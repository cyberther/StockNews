-- Market Pulse: the previous trading day's digest, per ticker.
--
-- Every story about a ticker from the previous business day (Bucharest time; on a Monday
-- the weekend's stories too) is read by the same local model that writes the AI summaries
-- (tools/summarize-batch.mjs), which writes a few bullet points covering everything that
-- was published. The ticker page shows the latest one.
--
-- Run once in the Supabase SQL editor, after summaries.sql (it uses summary_secret_ok and
-- is_opinion); safe to run again.

create table if not exists public.ticker_digests (
  ticker      text        not null,
  day         date        not null,          -- the business day the stories are from
  lang        text        not null,
  digest      text        not null,          -- one bullet per line
  stories     integer     not null,
  model       text,
  created_at  timestamptz not null default now(),
  primary key (ticker, day, lang),
  constraint ticker_digests_lang check (lang in ('ro', 'en', 'de')),
  constraint ticker_digests_len check (length(digest) between 20 and 3000)
);
alter table public.ticker_digests enable row level security;
alter table public.ticker_digests force row level security;
revoke all on public.ticker_digests from anon;
grant select on public.ticker_digests to authenticated;
drop policy if exists "read digests" on public.ticker_digests;
create policy "read digests" on public.ticker_digests for select to authenticated using (true);

-- The previous business day in Bucharest, and the span its digest covers: from its start
-- to the start of today (so a Monday's digest of Friday includes the weekend).
create or replace function public.digest_window(out day date, out t0 timestamptz, out t1 timestamptz)
language plpgsql stable as $$
declare today date := (now() at time zone 'Europe/Bucharest')::date;
begin
  day := today - 1;
  while extract(isodow from day) >= 6 loop day := day - 1; end loop;
  t0 := day::timestamp at time zone 'Europe/Bucharest';
  t1 := today::timestamp at time zone 'Europe/Bucharest';
end $$;

-- Tickers still without a digest of that day in p_lang, the busiest first, each with its
-- stories (the same headline once): headline, source, time, whether it is an opinion piece,
-- and the story's AI summary in p_lang when there is one, else the source's snippet.
-- Which tickers: every ticker with a story that day (followed ones, the US Market names and
-- the press tabs' companies); for a language other than Romanian, as for the summaries, only
-- where an account reads it.
-- p_ticker asks for one ticker (to try it out); it is still only one the rules allow.
create or replace function public.digests_pending(p_secret text, p_lang text default 'ro', p_limit integer default 1, p_ticker text default null)
returns table (ticker text, day date, stories jsonb)
language plpgsql stable security definer set search_path = public as $$
declare w record;
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select * into w from public.digest_window();
  return query
    with wanted as (
      select distinct x.t from (
        select s0.ticker t from public.stories s0 where s0.published_at >= w.t0 and s0.published_at < w.t1) x
      where (p_ticker is null or x.t = upper(p_ticker))
        and public.summary_scope(x.t)
        and (p_lang = 'ro' or exists (
          select 1 from auth.users u
          where upper(u.raw_user_meta_data->>'content_lang') = upper(p_lang)
            and (x.t ~ '\.(DE|L)$'
                 or x.t = any(array['NVDA','AAPL','MSFT','GOOGL','AMZN','META','AVGO','TSLA','TSM','JPM'])
                 or exists (select 1 from public.watchlist w3 where w3.user_id = u.id and w3.ticker = x.t)
                 or exists (select 1 from public.holdings h2 where h2.user_id = u.id and h2.ticker = x.t))))
        and not exists (select 1 from public.ticker_digests d where d.ticker = x.t and d.day = w.day and d.lang = p_lang)
    ), day_stories as (
      select distinct on (s.ticker, lower(s.headline)) s.ticker, s.headline, s.source, s.published_at,
             coalesce(ss.summary, s.summary) as summary, public.is_opinion(s.source, s.url) as opinion
      from public.stories s
      join wanted on wanted.t = s.ticker
      left join public.story_summaries ss on ss.story_id = s.id and ss.lang = p_lang
      where s.published_at >= w.t0 and s.published_at < w.t1
      order by s.ticker, lower(s.headline), s.published_at
    )
    select ds.ticker, w.day,
           jsonb_agg(jsonb_build_object('headline', ds.headline, 'source', ds.source, 'at', ds.published_at, 'summary', ds.summary, 'opinion', ds.opinion)
                     order by ds.published_at)
    from day_stories ds
    group by ds.ticker
    having count(*) >= 1
    order by count(*) desc, ds.ticker
    limit least(greatest(coalesce(p_limit, 1), 1), 20);
end $$;

create or replace function public.digests_save(p_secret text, p_ticker text, p_day date, p_lang text, p_digest text, p_stories integer, p_model text)
returns integer language plpgsql security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.ticker_digests (ticker, day, lang, digest, stories, model)
  values (upper(p_ticker), p_day, p_lang, p_digest, greatest(coalesce(p_stories, 0), 0), left(p_model, 80))
  on conflict (ticker, day, lang) do update set digest = excluded.digest, stories = excluded.stories, model = excluded.model, created_at = now();
  return 1;
end $$;

revoke all on function public.digests_pending(text, text, integer, text) from public;
revoke all on function public.digests_save(text, text, date, text, text, integer, text) from public;
grant execute on function public.digests_pending(text, text, integer, text) to anon, authenticated;
grant execute on function public.digests_save(text, text, date, text, text, integer, text) to anon, authenticated;

-- Digests are kept as long as the stories: 10 business days (supabase/push.sql scan_prune).
create or replace function public.digests_prune() returns void language sql security definer set search_path = public as $$
  delete from public.ticker_digests where day < (public.business_day_start(10) at time zone 'UTC')::date;
$$;
revoke all on function public.digests_prune() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'market-pulse-digest-prune';
select cron.schedule('market-pulse-digest-prune', '19 3 * * *', $job$ select public.digests_prune(); $job$);
