-- Market Pulse: AI summaries of news stories (Romanian first).
--
-- The background scan stores new stories in public.stories. A batch job on a PC running a
-- local model (tools/summarize-batch.mjs, LM Studio) asks for stories without a summary,
-- writes one for each, and sends them back here. The apps show a story's summary in the
-- reader's content language when there is one.
--
-- Run this once in the Supabase SQL editor; it is safe to run again. Then store the batch
-- job's secret in Vault (supabase/README.md, "AI summaries"). That secret can only list
-- stories that still need a summary and save summaries; the PC never gets the service-role
-- key.

create table if not exists public.story_summaries (
  story_id    text        not null references public.stories (id) on delete cascade,
  lang        text        not null,
  summary     text        not null,
  model       text,
  created_at  timestamptz not null default now(),
  primary key (story_id, lang),
  constraint story_summaries_lang check (lang in ('ro', 'en', 'de')),
  constraint story_summaries_len check (length(summary) between 20 and 1200)
);
alter table public.story_summaries enable row level security;
alter table public.story_summaries force row level security;
-- Readable by signed-in users, like the stories themselves; written only by the batch job.
revoke all on public.story_summaries from anon;
grant select on public.story_summaries to authenticated;
drop policy if exists "read summaries" on public.story_summaries;
create policy "read summaries" on public.story_summaries for select to authenticated using (true);

create or replace function public.summary_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_secret is not null and length(p_secret) >= 32
     and p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'summary_secret' limit 1);
$$;
revoke all on function public.summary_secret_ok(text) from public, anon, authenticated;

-- One article is often filed under several tickers (Finnhub lists "Can Apple overtake
-- Nvidia?" under AAPL and NVDA; ids are '<TICKER>:<article id>'). It is summarized once:
-- a saved summary is copied to the article's other tickers (summaries_save), and a story
-- stored later under another ticker gets the summaries already written (trigger below).
create or replace function public.story_article(p_id text) returns text
language sql immutable as $$ select nullif(split_part(p_id, ':', 2), '') $$;
create index if not exists stories_article on public.stories (public.story_article(id));
create index if not exists story_summaries_article on public.story_summaries (public.story_article(story_id));

create or replace function public.stories_copy_summaries() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.story_summaries (story_id, lang, summary, model)
  select distinct on (x.lang) new.id, x.lang, x.summary, x.model
  from public.story_summaries x
  where public.story_article(x.story_id) = public.story_article(new.id) and x.story_id <> new.id
  order by x.lang, x.created_at desc
  on conflict (story_id, lang) do nothing;
  return null;
end $$;
revoke all on function public.stories_copy_summaries() from public, anon, authenticated;
drop trigger if exists stories_copy_summaries on public.stories;
create trigger stories_copy_summaries after insert on public.stories
  for each row execute function public.stories_copy_summaries();

-- Once, for what is already there: summaries copied to the article's other tickers.
insert into public.story_summaries (story_id, lang, summary, model)
select distinct on (o.id, x.lang) o.id, x.lang, x.summary, x.model
from public.story_summaries x
join public.stories o on public.story_article(o.id) = public.story_article(x.story_id) and o.id <> x.story_id
order by o.id, x.lang, x.created_at desc
on conflict (story_id, lang) do nothing;

-- Opinion and stock-picking publishers (Motley Fool and the like): hidden in the apps unless
-- the reader asks for them, so their summaries come last. Same list as isOpinion() in
-- templates/shared/hif-data.js.
create or replace function public.is_opinion(p_source text, p_url text) returns boolean
language sql immutable as $$
  select lower(trim(coalesce(p_source, ''))) in ('motley fool', '24/7 wall st.', 'tikr', 'trefis', 'trefis.com',
           'insider monkey', 'gurufocus', 'simply wall st', 'zacks', 'marketbeat', 'investorplace', 'chartmill', 'chartmill.com',
           'barchart', 'barchart.com', 'seeking alpha', 'seekingalpha', 'tipranks', 'kiplinger', 'investopedia')
      or coalesce(p_url, '') ~* '^https?://([a-z0-9-]+\.)*(fool\.com|247wallst\.com|tikr\.com|trefis\.com|insidermonkey\.com|gurufocus\.com|simplywall\.st|zacks\.com|marketbeat\.com|investorplace\.com|chartmill\.com|barchart\.com|seekingalpha\.com|tipranks\.com|kiplinger\.com|investopedia\.com)(/|$)'
$$;

-- Stories published in the last p_hours without a summary in p_lang: first those someone
-- follows or holds and the Bucharest listings (.RO), then the rest; newest first in each;
-- opinion pieces after all of those.
-- Romanian is written for every story. Another language only where an account reads it
-- (content_lang in its user metadata): for the tickers such an account follows or holds, and
-- for the US and EU Market tabs' stories (the ten US names, XETRA .DE and London .L), so a second language
-- doesn't halve the pace of the Romanian summaries on the summary PC.
-- The link lets the batch job read the whole article (it keeps only its own short summary).
-- (Dropped first: Postgres can't change a function's result columns in place.)
-- Which tickers the local model summarises (stories and day digests, supabase/digests.sql):
-- Bucharest listings only for now (2026-10-19, the owner's call). Other stories are still
-- stored and shown, just without a summary. For every market again: return true here.
create or replace function public.summary_scope(p_ticker text) returns boolean
language sql immutable as $$ select coalesce(p_ticker, '') ~ '\.RO$' $$;

drop function if exists public.summaries_pending(text, text, integer, integer);
create or replace function public.summaries_pending(p_secret text, p_lang text default 'ro', p_limit integer default 15, p_hours integer default 24)
returns table (id text, ticker text, headline text, summary text, source text, url text, published_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select s.id, s.ticker, s.headline, s.summary, s.source, s.url, s.published_at
    from public.stories s
    where s.published_at > now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 168))
      and public.summary_scope(s.ticker)
      and not exists (select 1 from public.story_summaries x where x.story_id = s.id and x.lang = p_lang)
      and (p_lang = 'ro' or exists (
        select 1 from auth.users u
        where upper(u.raw_user_meta_data->>'content_lang') = upper(p_lang)
          and (s.ticker ~ '\.(DE|L)$'
               or s.ticker = any(array['NVDA','AAPL','MSFT','GOOGL','AMZN','META','AVGO','TSLA','TSM','JPM'])
               or exists (select 1 from public.watchlist w where w.user_id = u.id and w.ticker = s.ticker)
               or exists (select 1 from public.holdings h where h.user_id = u.id and h.ticker = s.ticker))))
    order by public.is_opinion(s.source, s.url),
             (s.ticker like '%.RO'
              or exists (select 1 from public.watchlist w where w.ticker = s.ticker)
              or exists (select 1 from public.holdings h where h.ticker = s.ticker)) desc,
             s.published_at desc
    limit least(greatest(coalesce(p_limit, 15), 1), 100);
end $$;

-- p_rows: [{ "story_id": "NVDA:123", "lang": "ro", "summary": "…", "model": "openai/gpt-oss-20b" }, ...]
create or replace function public.summaries_save(p_secret text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0;
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    raise exception 'bad rows' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    insert into public.story_summaries (story_id, lang, summary, model)
    select r->>'story_id', r->>'lang', r->>'summary', left(r->>'model', 80)
    where exists (select 1 from public.stories where id = r->>'story_id')
    on conflict (story_id, lang) do update set summary = excluded.summary, model = excluded.model, created_at = now();
    if found then
      n := n + 1;
      -- The same article filed under other tickers gets the same summary.
      insert into public.story_summaries (story_id, lang, summary, model)
      select o.id, r->>'lang', r->>'summary', left(r->>'model', 80)
      from public.stories o
      where public.story_article(o.id) = public.story_article(r->>'story_id') and o.id <> r->>'story_id'
      on conflict (story_id, lang) do nothing;
    end if;
  end loop;
  return n;
end $$;

revoke all on function public.summaries_pending(text, text, integer, integer) from public;
revoke all on function public.summaries_save(text, jsonb) from public;
grant execute on function public.summaries_pending(text, text, integer, integer) to anon, authenticated;
grant execute on function public.summaries_save(text, jsonb) to anon, authenticated;
