-- Market Pulse: the Bucharest listings' financial calendars (report dates, general meetings,
-- dividend dates).
--
-- Every BVB issuer publishes a yearly "calendar financiar" on its website. The filings
-- reader (tools/filings-crawl.mjs) finds those documents and pages and lists them here
-- (calendar_docs); the summary job (tools/summarize-batch.mjs, tools/calendar-extract.mjs)
-- has the local model read their dates into report_dates, and reads each one again weekly,
-- since companies update their calendar during the year. The app shows the next results
-- date in a share's "Earnings" box and the coming events in its calendar.
--
-- Run once in the Supabase SQL editor, after summaries.sql (summary_secret_ok) and
-- approval.sql (is_approved); safe to run again.

create table if not exists public.calendar_docs (
  url text primary key,
  ticker text not null,
  title text not null default '',
  year integer,                      -- the year in its title or address, when there is one
  found_at timestamptz not null default now(),
  checked_at timestamptz not null default now(),
  read_at timestamptz,
  status text,                       -- ok, none, failed, skipped (null: not read yet)
  content_hash text,
  model text
);
create index if not exists calendar_docs_todo on public.calendar_docs (read_at nulls first);
alter table public.calendar_docs enable row level security;
-- Only the RPCs below touch it: no table rights for the API roles (Supabase grants them on
-- every new table; row-level security would block them anyway).
revoke all on public.calendar_docs from anon, authenticated;

-- One row per event: results for a quarter (q 1-4; q 4 = the preliminary yearly results),
-- the annual report, a trading update, a general meeting, the dividend's ex, record and
-- payment dates. key keeps one row per event and year, so an updated calendar moves a date
-- instead of adding a second one.
create table if not exists public.report_dates (
  ticker text not null,
  kind text not null check (kind in ('results', 'annual_report', 'trading_update', 'agm', 'ex_dividend', 'record_date', 'payment_date')),
  year integer not null,
  q integer not null default 0,      -- quarter for results and trading updates, month for a meeting
  day date not null,
  hour text,                         -- 'bmo' before the market opens, 'amc' after it closes
  label text,                        -- as written in the calendar, short
  doc_url text,
  doc_day date,                      -- when the calendar was published (or read): the newest wins
  updated_at timestamptz not null default now(),
  primary key (ticker, kind, year, q)
);
create index if not exists report_dates_next on public.report_dates (ticker, day);
alter table public.report_dates enable row level security;
drop policy if exists "read report dates" on public.report_dates;
create policy "read report dates" on public.report_dates for select to authenticated using (public.is_approved());
revoke all on public.report_dates from anon, authenticated;
grant select on public.report_dates to authenticated;

-- The crawler: [{ ticker, url, title, year }].
create or replace function public.calendar_docs_upsert(p_secret text, p_rows jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  with r as (
    -- One row per address (two listings of one group can share a site).
    select distinct on (x->>'url') upper(x->>'ticker') as ticker, x->>'url' as url, left(coalesce(x->>'title', ''), 300) as title, nullif(x->>'year', '')::int as y
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  ), ins as (
    insert into public.calendar_docs (ticker, url, title, year)
    select ticker, url, title, y from r
    where ticker ~ '\.RO$' and url ~ '^https://' and (y is null or y between extract(year from now())::int - 1 and extract(year from now())::int + 1)
    on conflict (url) do update set title = excluded.title, year = excluded.year, checked_at = now()
    returning 1
  ) select count(*) into n from ins;
  return n;
end $$;

-- The batch job: calendars never read, then those of this year and next not read for a week.
create or replace function public.calendar_pending(p_secret text, p_limit integer default 2)
returns table (url text, ticker text, title text, year integer, content_hash text, found_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select d.url, d.ticker, d.title, d.year, d.content_hash, d.found_at from public.calendar_docs d
    where d.checked_at > now() - interval '45 days'
      and (d.read_at is null or (d.read_at < now() - interval '7 days' and coalesce(d.year, extract(year from now())::int) >= extract(year from now())::int
           and coalesce(d.status, '') in ('ok', 'none', 'failed')))
    order by d.read_at nulls first, d.year desc nulls first
    limit least(greatest(coalesce(p_limit, 2), 1), 20);
end $$;

-- p_status 'same': the text hasn't changed since the last read. p_events:
-- [{ kind, year, q, day, hour, label }], checked here too.
create or replace function public.calendar_save(p_secret text, p_url text, p_status text, p_hash text, p_events jsonb, p_model text, p_doc_day date default null)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer := 0; t text; dd date;
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_status not in ('ok', 'none', 'failed', 'skipped', 'same') then raise exception 'bad status'; end if;
  select ticker into t from public.calendar_docs where url = p_url;
  if t is null then return 0; end if;
  update public.calendar_docs set read_at = now(),
    status = case when p_status = 'same' then status else p_status end,
    content_hash = coalesce(p_hash, content_hash), model = coalesce(left(p_model, 80), model) where url = p_url;
  if p_status <> 'ok' then return 0; end if;
  dd := coalesce(p_doc_day, current_date);
  with e as (
    select x->>'kind' as kind, (x->>'year')::int as y, coalesce((x->>'q')::int, 0) as q, (x->>'day')::date as day,
           nullif(x->>'hour', '') as hour, left(x->>'label', 120) as label
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) x
  ), ins as (
    insert into public.report_dates (ticker, kind, year, q, day, hour, label, doc_url, doc_day, updated_at)
    select t, kind, y, q, day, hour, label, p_url, dd, now() from e
    where kind in ('results', 'annual_report', 'trading_update', 'agm', 'ex_dividend', 'record_date', 'payment_date')
      and y between 2000 and 2100 and q between 0 and 12
      and day between current_date - 400 and current_date + 500
      and (hour is null or hour in ('bmo', 'amc'))
    on conflict (ticker, kind, year, q) do update
      set day = excluded.day, hour = excluded.hour, label = excluded.label, doc_url = excluded.doc_url,
          doc_day = excluded.doc_day, updated_at = now()
      where public.report_dates.doc_day <= excluded.doc_day
    returning 1
  ) select count(*) into n from ins;
  return n;
end $$;

revoke all on function public.calendar_docs_upsert(text, jsonb) from public;
revoke all on function public.calendar_pending(text, integer) from public;
revoke all on function public.calendar_save(text, text, text, text, jsonb, text, date) from public;
grant execute on function public.calendar_docs_upsert(text, jsonb) to anon, authenticated;
grant execute on function public.calendar_pending(text, integer) to anon, authenticated;
grant execute on function public.calendar_save(text, text, text, text, jsonb, text, date) to anon, authenticated;

-- Every night: events more than 13 months old, and calendars of past years not seen again.
create or replace function public.calendar_prune() returns void language sql security definer set search_path = public as $$
  delete from public.report_dates where day < current_date - 400;
  delete from public.calendar_docs where checked_at < now() - interval '120 days'
    or (year is not null and year < extract(year from now())::int - 1);
$$;
revoke all on function public.calendar_prune() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'market-pulse-calendar-prune';
select cron.schedule('market-pulse-calendar-prune', '31 3 * * *', $job$ select public.calendar_prune(); $job$);
