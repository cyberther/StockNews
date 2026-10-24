-- Market Pulse: regulatory filings of the Bucharest listings, kept for years.
--
-- tools/filings-crawl.mjs (on the PC, systemd timer) reads each company's own website, where
-- its robots.txt allows it (never bvb.ro), and the Romanian press, and stores every investor
-- announcement it finds: title, date, link, and what kind it is. tools/summarize-batch.mjs
-- then has the local model read the documents of the kinds that carry figures (management
-- dealings, results, dividends and general meetings, holdings) and stores the figures in
-- `data`. The ticker page's "Insider & filings" shows them as tables, newest first.
--
-- Run once in the Supabase SQL editor, after summaries.sql (it uses summary_secret_ok);
-- safe to run again. Only the last 6 months are kept (undated documents are not stored); their
-- figures are read for all of them, the companies people follow or hold first.

create table if not exists public.filings (
  id            bigint generated always as identity primary key,
  ticker        text        not null,
  url           text        not null,
  title         text        not null,
  published_at  timestamptz,                     -- null when the page gives no date
  kind          text        not null,            -- insider | results | dividend | agm | holding | report | other
  source        text        not null,            -- the company's name, or the newspaper's
  official      boolean     not null default true,
  first_seen    timestamptz not null default now(),
  data          jsonb,                           -- the figures read from the document
  extract_status text,                           -- null (to do) | ok | none | failed | skipped
  extracted_at  timestamptz,
  model         text,
  constraint filings_url unique (ticker, url),
  constraint filings_kind check (kind in ('insider', 'results', 'dividend', 'agm', 'holding', 'report', 'other')),
  constraint filings_title_len check (length(title) between 3 and 400),
  constraint filings_url_https check (url ~ '^https://')
);
create index if not exists filings_ticker_date on public.filings (ticker, coalesce(published_at, first_seen) desc);
create index if not exists filings_todo on public.filings (extract_status, kind) where extract_status is null;
alter table public.filings enable row level security;
alter table public.filings force row level security;
revoke all on public.filings from anon;
-- Every column but the figures read from the documents (data): those are Pro, through the view
-- filing_figures (billing.sql). The list of documents stays for every approved reader.
revoke select on public.filings from authenticated;
grant select (id, ticker, url, title, published_at, kind, source, official, first_seen, extract_status, extracted_at, model)
  on public.filings to authenticated;
drop policy if exists "read filings" on public.filings;
create policy "read filings" on public.filings for select to authenticated using (true);

-- What the crawler knows about each company's site (for its own bookkeeping and so a
-- site that refuses robots is not asked again every run).
create table if not exists public.filing_sites (
  ticker      text primary key,
  site        text,
  status      text,            -- ok | robots | unreachable | none
  found       integer not null default 0,
  checked_at  timestamptz not null default now()
);
alter table public.filing_sites enable row level security;
alter table public.filing_sites force row level security;
revoke all on public.filing_sites from anon, authenticated;

-- The crawler: rows [{ ticker, url, title, published_at, kind, source, official }]. A known
-- link keeps its first title and date unless it had none.
create or replace function public.filings_upsert(p_secret text, p_rows jsonb, p_sites jsonb default '[]'::jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with r as (
    select upper(x->>'ticker') ticker, x->>'url' url, left(x->>'title', 400) title,
           nullif(x->>'published_at', '')::timestamptz published_at, x->>'kind' kind,
           left(coalesce(x->>'source', ''), 80) source, coalesce((x->>'official')::boolean, true) official
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
  ), ins as (
    insert into public.filings (ticker, url, title, published_at, kind, source, official)
    select ticker, url, title, published_at, kind, source, official from r
    where ticker ~ '\.RO$' and url ~ '^https://' and length(title) between 3 and 400
      and published_at > now() - interval '6 months' and published_at < now() + interval '1 day'
      and kind in ('insider', 'results', 'dividend', 'agm', 'holding', 'report', 'other')
    on conflict (ticker, url) do update
      set published_at = coalesce(public.filings.published_at, excluded.published_at),
          kind = case when public.filings.data is null then excluded.kind else public.filings.kind end
    returning 1
  ) select count(*) into n from ins;
  insert into public.filing_sites (ticker, site, status, found, checked_at)
  select upper(x->>'ticker'), x->>'site', x->>'status', coalesce((x->>'found')::int, 0), now()
  from jsonb_array_elements(coalesce(p_sites, '[]'::jsonb)) x
  on conflict (ticker) do update set site = excluded.site, status = excluded.status, found = excluded.found, checked_at = now();
  return n;
end $$;

-- The batch job: the last month's documents whose figures haven't been read; dealings,
-- holdings, dividends and results before general meetings, newest first. Older ones are
-- never read.
create or replace function public.filings_pending(p_secret text, p_limit integer default 2)
returns table (id bigint, ticker text, url text, title text, kind text, published_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select f.id, f.ticker, f.url, f.title, f.kind, f.published_at from public.filings f
    -- Every kept document (6 months; filings_prune drops older ones), the companies people
    -- follow or hold first, then by kind and newest.
    where f.extract_status is null and f.kind in ('insider', 'results', 'dividend', 'agm', 'holding')
    order by (exists (select 1 from public.watchlist w where w.ticker = f.ticker)
              or exists (select 1 from public.holdings h where h.ticker = f.ticker)) desc,
             array_position(array['insider', 'holding', 'dividend', 'results', 'agm'], f.kind),
             f.published_at desc nulls last
    limit least(greatest(coalesce(p_limit, 2), 1), 50);
end $$;

create or replace function public.filings_save(p_secret text, p_id bigint, p_status text, p_data jsonb, p_model text)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_status not in ('ok', 'none', 'failed', 'skipped') then raise exception 'bad status'; end if;
  update public.filings set extract_status = p_status, data = case when p_status = 'ok' then p_data else null end,
    extracted_at = now(), model = left(p_model, 80) where id = p_id;
  return 1;
end $$;

revoke all on function public.filings_upsert(text, jsonb, jsonb) from public;
revoke all on function public.filings_pending(text, integer) from public;
revoke all on function public.filings_save(text, bigint, text, jsonb, text) from public;
grant execute on function public.filings_upsert(text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.filings_pending(text, integer) to anon, authenticated;
grant execute on function public.filings_save(text, bigint, text, jsonb, text) to anon, authenticated;

-- Documents older than 6 months (or without a date) are deleted every night.
create or replace function public.filings_prune() returns void language sql security definer set search_path = public as $$
  delete from public.filings where published_at is null or published_at < now() - interval '6 months';
$$;
revoke all on function public.filings_prune() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'market-pulse-filings-prune';
select cron.schedule('market-pulse-filings-prune', '23 3 * * *', $job$ select public.filings_prune(); $job$);
