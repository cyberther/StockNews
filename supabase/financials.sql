-- Market Pulse: companies' financial statements, annual and quarterly, for the ticker page's
-- Financials tab (2026-10-24). Written by the owner's PC (tools/financials-batch.mjs):
--   source 'sec'    US companies, from the SEC's XBRL company facts (tools/financials-lib.mjs)
--   source 'mf'     Bucharest listings, yearly, from the Finance Ministry's open data
--   source 'report' Bucharest listings, quarterly, from the companies' own reports
-- Every approved reader sees each company's latest year and latest quarter (is_latest); the
-- five years behind them are Pro (is_pro(): every approved reader while the commercial rules
-- are off).
-- Run once in the Supabase SQL editor, after summaries.sql (summary_secret_ok) and billing.sql
-- (is_pro); safe to run again.
create table if not exists public.financials (
  ticker       text        not null,
  source       text        not null,
  period       text        not null,               -- 'A' a (fiscal) year, 'Q' a quarter
  period_end   date        not null,
  label        text        not null,               -- '2025', 'T3 2026'
  currency     text        not null,
  consolidated boolean,
  data         jsonb       not null,               -- { revenue, net_income, eps, assets, ... }
  is_latest    boolean     not null default false, -- the latest of its kind for this ticker and source
  updated_at   timestamptz not null default now(),
  primary key (ticker, source, period, period_end),
  constraint financials_ticker check (ticker ~ '^[A-Z0-9][A-Z0-9.\-]{0,14}$'),
  constraint financials_source check (source in ('sec', 'mf', 'report')),
  constraint financials_period check (period in ('A', 'Q')),
  constraint financials_data check (jsonb_typeof(data) = 'object' and pg_column_size(data) < 8192)
);
-- When each ticker was last asked for, found or not (the batch job's queue).
create table if not exists public.financials_checked (
  ticker     text        not null,
  source     text        not null,
  checked_at timestamptz not null default now(),
  status     text        not null,                 -- 'ok', 'none' (no figures), 'failed'
  primary key (ticker, source)
);

alter table public.financials enable row level security;
alter table public.financials force row level security;
alter table public.financials_checked enable row level security;
alter table public.financials_checked force row level security;
revoke all on public.financials, public.financials_checked from anon, authenticated;
grant select on public.financials to authenticated;
drop policy if exists "read financials" on public.financials;
create policy "read financials" on public.financials for select to authenticated
  using (public.is_approved() and (is_latest or public.is_pro()));

-- The PC job's queue: the US shares people follow or hold, never asked for first, then those
-- not asked for in a week (filings come four times a year).
create or replace function public.financials_pending(p_secret text, p_source text, p_limit integer)
returns table (ticker text) language plpgsql security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    with wanted as (
      select w.ticker from public.watchlist w union select h.ticker from public.holdings h
    )
    select x.ticker from wanted x
    left join public.financials_checked c on c.ticker = x.ticker and c.source = p_source
    where case p_source when 'sec' then x.ticker ~ '^[A-Z]{1,5}(\.[A-Z])?$'
                        else x.ticker ~ '\.RO$' end
      and (c.checked_at is null or c.checked_at < now() - interval '7 days'
           or (c.status = 'failed' and c.checked_at < now() - interval '1 day'))
    order by c.checked_at nulls first, x.ticker
    limit least(greatest(coalesce(p_limit, 20), 1), 200);
end $$;

-- One ticker's statements from one source, replacing what was there.
create or replace function public.financials_save(p_secret text, p_ticker text, p_source text, p_status text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0;
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('ok', 'none', 'failed') then raise exception 'bad status'; end if;
  if p_status = 'ok' then
    if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 80 then raise exception 'bad rows'; end if;
    delete from public.financials where ticker = p_ticker and source = p_source;
    insert into public.financials (ticker, source, period, period_end, label, currency, consolidated, data)
    select p_ticker, p_source, r->>'period', (r->>'period_end')::date, left(r->>'label', 20), left(coalesce(r->>'currency', ''), 8),
           (r->>'consolidated')::boolean, r->'data'
    from jsonb_array_elements(p_rows) r
    on conflict (ticker, source, period, period_end) do nothing;
    get diagnostics n = row_count;
    update public.financials f set is_latest = f.period_end = (
      select max(g.period_end) from public.financials g where g.ticker = f.ticker and g.source = f.source and g.period = f.period)
    where f.ticker = p_ticker and f.source = p_source;
  end if;
  insert into public.financials_checked (ticker, source, checked_at, status) values (p_ticker, p_source, now(), p_status)
  on conflict (ticker, source) do update set checked_at = excluded.checked_at, status = excluded.status;
  return n;
end $$;

revoke all on function public.financials_pending(text, text, integer) from public;
revoke all on function public.financials_save(text, text, text, text, jsonb) from public;
grant execute on function public.financials_pending(text, text, integer) to anon, authenticated;
grant execute on function public.financials_save(text, text, text, text, jsonb) to anon, authenticated;
