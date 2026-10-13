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

-- Newest stories first, published in the last p_hours, without a summary in p_lang.
create or replace function public.summaries_pending(p_secret text, p_lang text default 'ro', p_limit integer default 15, p_hours integer default 24)
returns table (id text, ticker text, headline text, summary text, source text, published_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select s.id, s.ticker, s.headline, s.summary, s.source, s.published_at
    from public.stories s
    where s.published_at > now() - make_interval(hours => least(greatest(coalesce(p_hours, 24), 1), 168))
      and not exists (select 1 from public.story_summaries x where x.story_id = s.id and x.lang = p_lang)
    order by s.published_at desc
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
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

revoke all on function public.summaries_pending(text, text, integer, integer) from public;
revoke all on function public.summaries_save(text, jsonb) from public;
grant execute on function public.summaries_pending(text, text, integer, integer) to anon, authenticated;
grant execute on function public.summaries_save(text, jsonb) to anon, authenticated;
