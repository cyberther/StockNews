-- Plans and subscriptions (Phase D): who has Pro, decided here and nowhere else, and the one
-- switch that turns the commercial rules on. Design: docs/plans/2026-10-19-faza-d-design.md.
--
-- Run once in the SQL Editor, after approval.sql, push.sql, holdings.sql and impact.sql; safe to
-- run again. While app_config.commercial_mode is false (the default) every approved account is
-- Pro, as before Phase D, and none of the limits apply.

-- ---------------------------------------------------------------------------------------
-- Settings read by the database itself. Keep 'limits' equal to config/billing.json (test).
create table if not exists public.app_config (
  key        text        primary key,
  value      jsonb       not null,
  updated_at timestamptz not null default now()
);
insert into public.app_config (key, value) values ('commercial_mode', 'false') on conflict (key) do nothing;
insert into public.app_config (key, value) values ('limits', '{"free": {"tickers": 5, "positions": 5}, "pro": {"tickers": 100, "positions": 100}}')
  on conflict (key) do update set value = excluded.value, updated_at = now();
alter table public.app_config enable row level security;
alter table public.app_config force row level security;
revoke all on public.app_config from anon, authenticated;

create or replace function public.commercial_mode() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from app_config where key = 'commercial_mode'), false);
$$;
revoke all on function public.commercial_mode() from public, anon;
grant execute on function public.commercial_mode() to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- One row per account and source of the right: a paid subscription, a trial, or given by hand.
create table if not exists public.entitlements (
  user_id             uuid        not null references auth.users on delete cascade,
  source              text        not null,
  plan                text        not null default 'pro',
  status              text        not null,
  current_period_end  timestamptz,                -- null only for 'manual' without an end
  provider            text,
  customer_id         text,
  subscription_id     text,
  portal_url          text,
  provider_updated_at timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (user_id, source),
  constraint entitlements_source check (source in ('payment', 'trial', 'manual')),
  constraint entitlements_plan check (plan in ('pro')),
  constraint entitlements_status check (status in ('active', 'trialing', 'past_due', 'cancelled', 'expired')),
  constraint entitlements_portal check (portal_url is null or portal_url ~ '^https://')
);
-- The provider's variant (the price bought) and whether it is the founder price.
alter table public.entitlements add column if not exists variant_id text;
alter table public.entitlements add column if not exists founder boolean not null default false;
create index if not exists entitlements_subscription on public.entitlements (subscription_id);
alter table public.entitlements enable row level security;
alter table public.entitlements force row level security;
revoke all on public.entitlements from anon, authenticated;
grant select on public.entitlements to authenticated;
drop policy if exists "read own entitlements" on public.entitlements;
create policy "read own entitlements" on public.entitlements for select to authenticated using (user_id = auth.uid());

-- Pro while a right is current: paid, on trial, in the grace of a failed payment, or cancelled
-- but not yet at the end of what was paid; or given by hand without an end.
create or replace function public.current_plan(p_uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when exists (
    select 1 from entitlements e where e.user_id = p_uid and (
      (e.status in ('active', 'trialing', 'past_due', 'cancelled') and e.current_period_end > now())
      or (e.source = 'manual' and e.status = 'active' and e.current_period_end is null))
  ) then 'pro' else 'free' end;
$$;
revoke all on function public.current_plan(uuid) from public, anon, authenticated;
grant execute on function public.current_plan(uuid) to service_role;

-- The one check every rule uses: an approved account, and Pro (or the commercial rules off).
create or replace function public.is_pro() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_approved() and (not public.commercial_mode() or public.current_plan(auth.uid()) = 'pro');
$$;
revoke all on function public.is_pro() from public, anon;
grant execute on function public.is_pro() to authenticated;

-- What the app shows about the reader's plan, with the limits that apply to it.
create or replace function public.my_plan() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cm boolean := public.commercial_mode(); p text; e record; lim jsonb;
begin
  select value into lim from app_config where key = 'limits';
  if not cm then
    return jsonb_build_object('commercial', false, 'plan', 'pro', 'source', 'early_access', 'status', null,
      'period_end', null, 'portal_url', null, 'limits', lim->'pro');
  end if;
  p := public.current_plan(auth.uid());
  select * into e from entitlements x where x.user_id = auth.uid()
    order by (x.status in ('active', 'trialing', 'past_due', 'cancelled') and coalesce(x.current_period_end > now(), x.source = 'manual')) desc,
             x.current_period_end desc nulls first
    limit 1;
  return jsonb_build_object('commercial', true, 'plan', p, 'source', e.source, 'status', e.status,
    'period_end', e.current_period_end, 'portal_url', e.portal_url, 'limits', lim->p,
    'founder', coalesce(e.founder, false) and p = 'pro');
end $$;
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;

-- The plan on account_status follows, for whatever still reads it there (display only: the
-- rules call current_plan / is_pro, which also see a period that has just ended).
create or replace function public.entitlements_sync() returns trigger
language plpgsql security definer set search_path = public as $$
declare uid uuid := coalesce(new.user_id, old.user_id);
begin
  update account_status set plan = public.current_plan(uid) where user_id = uid;
  return null;
end $$;
drop trigger if exists entitlements_sync on public.entitlements;
create trigger entitlements_sync after insert or update or delete on public.entitlements
  for each row execute function public.entitlements_sync();

-- Given by hand (the Administration screen): until a date, or with no end (null).
create or replace function public.admin_grant_pro(p_user uuid, p_until timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_until is not null and p_until <= now() then raise exception 'the end must be in the future'; end if;
  insert into entitlements (user_id, source, status, current_period_end, updated_at)
  values (p_user, 'manual', 'active', p_until, now())
  on conflict (user_id, source) do update set status = 'active', current_period_end = excluded.current_period_end, updated_at = now();
  return 1;
end $$;
create or replace function public.admin_revoke_pro(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  update entitlements set status = 'expired', current_period_end = now(), updated_at = now()
  where user_id = p_user and source = 'manual' and status <> 'expired';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.admin_grant_pro(uuid, timestamptz) from public, anon;
revoke all on function public.admin_revoke_pro(uuid) from public, anon;
grant execute on function public.admin_grant_pro(uuid, timestamptz) to authenticated;
grant execute on function public.admin_revoke_pro(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The founder price (2026-10-23, the owner's call): 49 lei a month or 490 a year for the first
-- 200 subscribers, kept for as long as the subscription stays active (the provider keeps the
-- price of a subscription; one cancelled and started again later pays the price of then).
-- A seat is held by a founder subscription that still gives access (trial included), and for
-- two hours by a checkout started from the app, so that the count shown is never above what
-- is left. 'founder_seats' follows config/billing.json (test); 'founder_variants' is set once
-- by the owner, with the ids of the two founder prices at the provider (docs/phase-d-setup.md).
insert into public.app_config (key, value) values ('founder_seats', '200')
  on conflict (key) do update set value = excluded.value, updated_at = now();
insert into public.app_config (key, value) values ('founder_variants', '[]') on conflict (key) do nothing;

create table if not exists public.founder_claims (
  user_id    uuid        primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.founder_claims enable row level security;
alter table public.founder_claims force row level security;
revoke all on public.founder_claims from anon, authenticated;

create or replace function public.founder_variant(p_variant text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_variant is not null and exists (
    select 1 from app_config c, jsonb_array_elements_text(c.value) v
    where c.key = 'founder_variants' and v = p_variant), false);
$$;
revoke all on function public.founder_variant(text) from public, anon, authenticated;

-- Seats taken: founder subscriptions that still give access, and recent checkouts of others.
create or replace function public.founder_taken() returns integer
language sql stable security definer set search_path = public as $$
  with subs as (
    select distinct user_id from entitlements
    where source = 'payment' and founder and current_period_end > now()
      and status in ('trialing', 'active', 'past_due', 'cancelled')
  )
  select ((select count(*) from subs)
        + (select count(*) from founder_claims c where c.created_at > now() - interval '2 hours'
           and c.user_id not in (select user_id from subs)))::int;
$$;
revoke all on function public.founder_taken() from public, anon, authenticated;

-- What the paywall shows: how many seats there are and how many are left (counts only).
create or replace function public.founder_offer() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('seats', s, 'left', greatest(s - public.founder_taken(), 0))
  from (select coalesce((select (value #>> '{}')::int from app_config where key = 'founder_seats'), 0) s) x;
$$;
revoke all on function public.founder_offer() from public;
grant execute on function public.founder_offer() to anon, authenticated;

-- The billing Edge Function, before it asks the provider for a founder checkout: 'ok' (a seat
-- is held for this account), 'full', or 'not_configured' (the variant is not a founder price).
-- One at a time (advisory lock), so two readers can't take the last seat together.
create or replace function public.founder_claim(p_user uuid, p_variant text) returns text
language plpgsql security definer set search_path = public as $$
declare seats integer;
begin
  if p_user is null then raise exception 'a user is required'; end if;
  if not public.founder_variant(p_variant) then return 'not_configured'; end if;
  perform pg_advisory_xact_lock(hashtext('market-pulse-founder-seats'));
  if exists (select 1 from entitlements where user_id = p_user and source = 'payment' and founder
             and current_period_end > now() and status in ('trialing', 'active', 'past_due', 'cancelled'))
     or exists (select 1 from founder_claims where user_id = p_user and created_at > now() - interval '2 hours') then
    update founder_claims set created_at = now() where user_id = p_user;
    return 'ok';
  end if;
  seats := coalesce((select (value #>> '{}')::int from app_config where key = 'founder_seats'), 0);
  if public.founder_taken() >= seats then return 'full'; end if;
  insert into founder_claims (user_id, created_at) values (p_user, now())
    on conflict (user_id) do update set created_at = now();
  return 'ok';
end $$;
revoke all on function public.founder_claim(uuid, text) from public, anon, authenticated;
grant execute on function public.founder_claim(uuid, text) to service_role;

-- ---------------------------------------------------------------------------------------
-- Webhooks from the payment provider (Lemon Squeezy), after the billing Edge Function has
-- checked their signature. Every delivery is kept (by the hash of its body): a retry is not
-- applied twice, and one older than what was applied changes nothing.
create table if not exists public.billing_events (
  hash            text        primary key,
  event_name      text,
  subscription_id text,
  user_id         uuid,
  received_at     timestamptz not null default now(),
  applied         boolean     not null default false,
  note            text
);
alter table public.billing_events enable row level security;
alter table public.billing_events force row level security;
revoke all on public.billing_events from anon, authenticated;

-- Subscription events only ('subscriptions' objects): after a payment the provider also sends
-- subscription_updated with the new renewal date, so invoice events are only recorded.
create or replace function public.billing_apply(p_hash text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev text := p_payload->'meta'->>'event_name';
  uid_text text := p_payload->'meta'->'custom_data'->>'user_id';
  uid uuid;
  d jsonb := p_payload->'data';
  a jsonb := p_payload->'data'->'attributes';
  st text; ends timestamptz; upd timestamptz; prev timestamptz; portal text;
  note text;
begin
  if p_hash is null or length(p_hash) < 8 then raise exception 'hash required'; end if;
  if exists (select 1 from billing_events where hash = p_hash) then
    return jsonb_build_object('applied', false, 'note', 'duplicate');
  end if;
  if uid_text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select id into uid from auth.users where id = uid_text::uuid;
  end if;
  st := case a->>'status' when 'on_trial' then 'trialing' when 'active' then 'active' when 'past_due' then 'past_due'
    when 'unpaid' then 'past_due' when 'cancelled' then 'cancelled' when 'expired' then 'expired' when 'paused' then 'expired' end;
  if d->>'type' is distinct from 'subscriptions' then note := 'not a subscription';
  elsif uid is null then note := 'unknown user';
  elsif st is null then note := 'unknown status';
  end if;
  if note is null then
    upd := coalesce((a->>'updated_at')::timestamptz, now());
    select provider_updated_at into prev from entitlements where user_id = uid and source = 'payment';
    if prev is not null and prev >= upd then note := 'stale'; end if;
  end if;
  insert into billing_events (hash, event_name, subscription_id, user_id, applied, note)
  values (p_hash, left(ev, 80), left(d->>'id', 80), uid, note is null, note);
  if note is not null then return jsonb_build_object('applied', false, 'note', note); end if;

  -- The end of what is paid (or of the trial); for a paused or expired one, now.
  ends := case
    when st = 'trialing' then coalesce((a->>'trial_ends_at')::timestamptz, (a->>'renews_at')::timestamptz)
    when st in ('active', 'past_due') then (a->>'renews_at')::timestamptz
    when st = 'cancelled' then coalesce((a->>'ends_at')::timestamptz, (a->>'renews_at')::timestamptz)
    else least(coalesce((a->>'ends_at')::timestamptz, now()), now()) end;
  portal := a->'urls'->>'customer_portal';
  if portal !~ '^https://[^\s"''<>]+$' then portal := null; end if;
  insert into entitlements (user_id, source, status, current_period_end, provider, customer_id, subscription_id, portal_url, provider_updated_at, updated_at, variant_id, founder)
  values (uid, 'payment', st, ends, 'lemonsqueezy', left(a->>'customer_id', 80), left(d->>'id', 80), portal, upd, now(),
    left(a->>'variant_id', 80), public.founder_variant(a->>'variant_id'))
  on conflict (user_id, source) do update set status = excluded.status, current_period_end = excluded.current_period_end,
    provider = excluded.provider, customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
    portal_url = excluded.portal_url, provider_updated_at = excluded.provider_updated_at, updated_at = now(),
    variant_id = coalesce(excluded.variant_id, entitlements.variant_id),
    founder = case when excluded.variant_id is null then entitlements.founder else excluded.founder end;
  delete from founder_claims where user_id = uid;
  return jsonb_build_object('applied', true, 'note', st);
end $$;
revoke all on function public.billing_apply(text, jsonb) from public, anon, authenticated;
grant execute on function public.billing_apply(text, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------
-- The rules that only apply with the commercial switch on. (approval.sql and impact.sql
-- recreate the two read policies below without them: run this file again after either.)

-- Tickers followed and positions held: the plan's limit (Free 5, Pro 100); 100 for everyone
-- while the commercial rules are off, as before.
create or replace function public.plan_limit(p_uid uuid, p_what text) returns integer
language sql stable security definer set search_path = public as $$
  select (select (value -> (case when not public.commercial_mode() or public.current_plan(p_uid) = 'pro' then 'pro' else 'free' end) ->> p_what)::int
          from app_config where key = 'limits');
$$;
revoke all on function public.plan_limit(uuid, text) from public, anon, authenticated;

create or replace function public.watchlist_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare lim integer := coalesce(public.plan_limit(new.user_id, 'tickers'), 100);
begin
  if (select count(*) from watchlist where user_id = new.user_id) >= lim then
    raise exception 'watchlist is limited to % tickers', lim using errcode = '23514';
  end if;
  return new;
end $$;
create or replace function public.holdings_cap() returns trigger language plpgsql security definer set search_path = public as $$
declare lim integer := coalesce(public.plan_limit(new.user_id, 'positions'), 100);
begin
  if (select count(*) from holdings where user_id = new.user_id) >= lim then
    raise exception 'holdings are limited to % positions', lim using errcode = '23514';
  end if;
  return new;
end $$;

-- Impact results (and the accuracy view over them) and the day digests: Pro. The analyses
-- themselves (facts, assumptions, risks) stay readable by every approved account.
do $$
begin
  if to_regclass('public.impact_results') is not null then
    execute 'drop policy if exists "read results" on public.impact_results';
    execute 'create policy "read results" on public.impact_results for select to authenticated using (public.is_pro())';
  end if;
  if to_regclass('public.ticker_digests') is not null then
    execute 'drop policy if exists "read digests" on public.ticker_digests';
    execute 'create policy "read digests" on public.ticker_digests for select to authenticated using (public.is_pro())';
  end if;
end $$;

-- Who of these accounts gets push alerts (news and policy, supabase/functions/scan): all of
-- them while the commercial rules are off, else the Pro ones.
create or replace function public.pro_users(p_ids uuid[]) returns setof uuid
language sql stable security definer set search_path = public as $$
  select u from unnest(p_ids) u where not public.commercial_mode() or public.current_plan(u) = 'pro';
$$;
revoke all on function public.pro_users(uuid[]) from public, anon, authenticated;
grant execute on function public.pro_users(uuid[]) to service_role;
