-- Market data written by the ingestion jobs (ingest/, run by GitHub Actions) and read by the
-- apps straight from the database, so no serverless function runs per visitor.
--
-- Run once in the SQL Editor (it can be run again). Needs supabase/push.sql (public.stories)
-- and supabase/approval.sql (public.is_approved()) first.
--
-- Every row carries the licence of the source it came from:
--   dev_only            development and personal use only (Yahoo): approved accounts only,
--                       never anyone signed out
--   commercial_display  licensed for display in the product
--   redistribution      licensed for display and redistribution
-- Only the service role (the jobs) writes; RLS keeps the browser to reading.

-- ---------------------------------------------------------------------------------------
-- Latest price per symbol.
create table if not exists public.market_quotes (
  symbol       text        primary key,
  price        numeric     not null,
  change       numeric,
  change_pct   numeric,
  prev_close   numeric,
  currency     text,
  market_time  timestamptz,                         -- the last trade the price is from
  fetched_at   timestamptz not null default now(),  -- when the job read it
  source       text        not null,
  license      text        not null,
  constraint market_quotes_symbol check (symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$'),
  constraint market_quotes_license check (license in ('dev_only', 'commercial_display', 'redistribution'))
);

-- Analyst recommendations, read once a day (end-of-day job). status 'none' remembers that a
-- source has nothing for the symbol, so it is not asked again for 24 hours.
create table if not exists public.market_recommendations (
  symbol      text        primary key,
  status      text        not null,
  buy         int,
  hold        int,
  sell        int,
  period      text,
  fetched_at  timestamptz not null default now(),
  source      text        not null,
  license     text        not null,
  constraint market_recs_symbol check (symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$'),
  constraint market_recs_status check (status in ('ok', 'none')),
  constraint market_recs_license check (license in ('dev_only', 'commercial_display', 'redistribution'))
);

-- The jobs' own bookkeeping: one row per run, each provider's circuit breaker, and calls
-- per provider and job per day (budgets, config/budgets.json).
create table if not exists public.ingest_runs (
  id           bigserial   primary key,
  job          text        not null,
  started_at   timestamptz not null,
  finished_at  timestamptz not null default now(),
  ok           boolean     not null,
  symbols      int         not null default 0,
  requests     jsonb       not null default '{}'::jsonb,  -- { provider: calls } in this run
  errors       text
);
create index if not exists ingest_runs_time on public.ingest_runs (started_at desc);

create table if not exists public.ingest_provider_state (
  provider    text        primary key,
  fails       int         not null default 0,
  open_until  timestamptz,
  reason      text,
  updated_at  timestamptz not null default now()
);

create table if not exists public.ingest_usage (
  day       date not null,
  provider  text not null,
  job       text not null,
  calls     int  not null default 0,
  primary key (day, provider, job)
);

-- Push alerts are sent once per story: the scan's alerts-only mode marks what it sent.
alter table public.stories add column if not exists alerted_at timestamptz;
create index if not exists stories_unalerted on public.stories (found_at) where alerted_at is null;

-- ---------------------------------------------------------------------------------------
-- Row-level security.
alter table public.market_quotes enable row level security;
alter table public.market_quotes force row level security;
alter table public.market_recommendations enable row level security;
alter table public.market_recommendations force row level security;
alter table public.ingest_runs enable row level security;
alter table public.ingest_runs force row level security;
alter table public.ingest_provider_state enable row level security;
alter table public.ingest_provider_state force row level security;
alter table public.ingest_usage enable row level security;
alter table public.ingest_usage force row level security;

revoke all on public.market_quotes, public.market_recommendations from anon, authenticated;
grant select on public.market_quotes, public.market_recommendations to anon, authenticated;
revoke all on public.ingest_runs, public.ingest_provider_state, public.ingest_usage from anon, authenticated;

-- Signed out: licensed data only. (anon may not call is_approved(), hence two policies.)
drop policy if exists "read licensed quotes" on public.market_quotes;
create policy "read licensed quotes" on public.market_quotes for select to anon using (license <> 'dev_only');
drop policy if exists "read quotes" on public.market_quotes;
create policy "read quotes" on public.market_quotes for select to authenticated using (license <> 'dev_only' or public.is_approved());

drop policy if exists "read licensed recommendations" on public.market_recommendations;
create policy "read licensed recommendations" on public.market_recommendations for select to anon using (license <> 'dev_only');
drop policy if exists "read recommendations" on public.market_recommendations;
create policy "read recommendations" on public.market_recommendations for select to authenticated using (license <> 'dev_only' or public.is_approved());

-- ---------------------------------------------------------------------------------------
-- Housekeeping: run rows older than 60 days, usage older than 400 days.
create or replace function public.ingest_prune() returns void language sql security definer set search_path = public as $$
  delete from public.ingest_runs where started_at < now() - interval '60 days';
  delete from public.ingest_usage where day < current_date - 400;
$$;
revoke all on function public.ingest_prune() from public, anon, authenticated;
