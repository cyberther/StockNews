-- Market Pulse: background scanning and push alerts.
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query), after
-- server/schema.sql. It is safe to run again. The scan itself is the Edge Function in
-- supabase/functions/scan; the schedule at the bottom calls it every 10 minutes.
-- Setup, secrets and testing: supabase/README.md.

-- ---------------------------------------------------------------------------------------
-- Watchlist: one row per (user, ticker). The apps mirror the user's watchlist here so the
-- scan knows what to look for; push = false mutes alerts for that ticker.
create table if not exists public.watchlist (
  user_id   uuid        not null references auth.users on delete cascade,
  ticker    text        not null,
  push      boolean     not null default true,
  added_at  timestamptz not null default now(),
  primary key (user_id, ticker),
  constraint watchlist_ticker check (ticker ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$')
);
alter table public.watchlist enable row level security;
alter table public.watchlist force row level security;
revoke all on public.watchlist from anon;
grant select, insert, update, delete on public.watchlist to authenticated;

drop policy if exists "read own watchlist"   on public.watchlist;
drop policy if exists "add to own watchlist" on public.watchlist;
drop policy if exists "edit own watchlist"   on public.watchlist;
drop policy if exists "trim own watchlist"   on public.watchlist;
create policy "read own watchlist"   on public.watchlist for select to authenticated using (user_id = auth.uid());
create policy "add to own watchlist" on public.watchlist for insert to authenticated with check (user_id = auth.uid());
create policy "edit own watchlist"   on public.watchlist for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "trim own watchlist"   on public.watchlist for delete to authenticated using (user_id = auth.uid());

-- A watchlist stays a watchlist, not free storage.
create or replace function public.watchlist_cap() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.watchlist where user_id = new.user_id) >= 100 then
    raise exception 'watchlist is limited to 100 tickers';
  end if;
  return new;
end $$;
drop trigger if exists watchlist_cap on public.watchlist;
create trigger watchlist_cap before insert on public.watchlist for each row execute function public.watchlist_cap();

-- ---------------------------------------------------------------------------------------
-- Push subscriptions: one row per browser/device that turned alerts on.
create table if not exists public.push_subscriptions (
  endpoint    text        primary key,
  user_id     uuid        not null references auth.users on delete cascade,
  p256dh      text        not null,
  auth        text        not null,
  user_agent  text,
  created_at  timestamptz not null default now(),
  last_ok     timestamptz,
  constraint push_endpoint_https check (endpoint like 'https://%' and length(endpoint) < 1024),
  constraint push_keys_size check (length(p256dh) < 200 and length(auth) < 100)
);
create index if not exists push_subscriptions_user on public.push_subscriptions (user_id);
alter table public.push_subscriptions enable row level security;
alter table public.push_subscriptions force row level security;
revoke all on public.push_subscriptions from anon;
grant select, insert, update, delete on public.push_subscriptions to authenticated;

drop policy if exists "read own devices"   on public.push_subscriptions;
drop policy if exists "add own device"     on public.push_subscriptions;
drop policy if exists "update own device"  on public.push_subscriptions;
drop policy if exists "remove own device"  on public.push_subscriptions;
create policy "read own devices"  on public.push_subscriptions for select to authenticated using (user_id = auth.uid());
create policy "add own device"    on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid());
create policy "update own device" on public.push_subscriptions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove own device" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());

-- ---------------------------------------------------------------------------------------
-- Stories the scan has found (public market news, readable by any signed-in user).
-- Only the scan (service role) writes here.
create table if not exists public.stories (
  id            text        primary key,          -- '<TICKER>:<finnhub id>'
  ticker        text        not null,
  headline      text        not null,
  source        text,
  url           text,
  summary       text,
  published_at  timestamptz not null,
  found_at      timestamptz not null default now()
);
create index if not exists stories_ticker_time on public.stories (ticker, published_at desc);
alter table public.stories enable row level security;
alter table public.stories force row level security;
revoke all on public.stories from anon;
grant select on public.stories to authenticated;
drop policy if exists "read stories" on public.stories;
create policy "read stories" on public.stories for select to authenticated using (true);

-- Company names the scan uses to tell real company news from general market articles.
create table if not exists public.ticker_names (
  ticker      text        primary key,
  name        text,
  updated_at  timestamptz not null default now()
);
alter table public.ticker_names enable row level security;
alter table public.ticker_names force row level security;
revoke all on public.ticker_names from anon, authenticated;

-- One row per scan, for the "last scan" time and for checking that the job runs.
create table if not exists public.scan_runs (
  id           bigserial   primary key,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  tickers      int         not null default 0,
  new_stories  int         not null default 0,
  pushes       int         not null default 0,
  errors       text
);
alter table public.scan_runs enable row level security;
alter table public.scan_runs force row level security;
revoke all on public.scan_runs from anon;
grant select on public.scan_runs to authenticated;
drop policy if exists "read scan runs" on public.scan_runs;
create policy "read scan runs" on public.scan_runs for select to authenticated using (true);

-- Housekeeping: stories older than 10 business days (with their AI summaries) and scan rows
-- older than 7 days. The apps show 5 business days; the rest is margin.
-- Start (UTC midnight) of the n-th business day back, today counting when it is one.
create or replace function public.business_day_start(n integer) returns timestamptz
language sql stable as $$
  select (d::timestamp at time zone 'UTC') from (
    select g::date d from generate_series(current_date::timestamp, current_date::timestamp - interval '40 days', interval '-1 day') g
    where extract(isodow from g) < 6 order by g desc offset greatest(n, 1) - 1 limit 1) x
$$;
create or replace function public.scan_prune() returns void language sql security definer set search_path = public as $$
  delete from public.stories   where published_at < public.business_day_start(10);
  delete from public.scan_runs where started_at   < now() - interval '7 days';
$$;
revoke all on function public.scan_prune() from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------
-- The schedule. Needs the pg_cron and pg_net extensions and two Vault secrets:
--   scan_url    = https://<project-ref>.supabase.co/functions/v1/scan
--   scan_secret = the same value as the function's SCAN_SECRET
-- Create them once (Dashboard → Project Settings → Vault, or):
--   select vault.create_secret('https://<project-ref>.supabase.co/functions/v1/scan', 'scan_url');
--   select vault.create_secret('<your SCAN_SECRET>', 'scan_secret');
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net  with schema extensions;

select cron.unschedule(jobid) from cron.job where jobname in ('market-pulse-scan', 'market-pulse-prune');

select cron.schedule('market-pulse-scan', '*/10 * * * *', $job$
  select net.http_post(
    url     := (select decrypted_secret from vault.decrypted_secrets where name = 'scan_url'),
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'scan_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 120000);
$job$);

select cron.schedule('market-pulse-prune', '17 3 * * *', $job$ select public.scan_prune(); $job$);
