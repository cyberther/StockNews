-- Politici 2.0 (docs/plans/2026-10-19-politici-automat-design.md): the documents behind each
-- policy event, a fact sheet for every event, automatic impact analyses, and the state's money
-- going to listed companies (public contracts; state aid when a source with an export exists).
--
-- Run in the Supabase SQL editor after policy.sql and impact.sql, and again after either of
-- them is rerun (this redefines impact.sql's immutability trigger). Safe to run twice.
-- Readers: approved accounts. Writers: the ingestion (service role) and the local batch through
-- auto_pending / auto_save, which check the summary secret (summaries.sql).

-- ---------------------------------------------------------------------------------------
-- The text of an event's documents (bill, explanatory memorandum, financial sheet, government
-- note, act), joined into one bundle; parts says which url each stretch of text came from.
create table if not exists public.policy_documents (
  event_id   text        not null references public.policy_events (id),
  sha256     text        not null,
  url        text        not null,
  parts      jsonb       not null default '[]',
  text       text        not null default '',
  chars      integer     not null default 0,
  status     text        not null default 'ok',
  fetched_at timestamptz not null default now(),
  primary key (event_id, sha256),
  constraint policy_documents_sha check (sha256 ~ '^[0-9a-f]{64}$'),
  constraint policy_documents_url check (url ~ '^https://'),
  constraint policy_documents_status check (status in ('ok', 'unreadable')),
  constraint policy_documents_size check (length(text) <= 400000)
);

-- One sheet per event: what the ingestion knows (base) and, once the local batch has read the
-- documents, a summary; reasons say why there is no impact analysis.
create table if not exists public.fact_sheets (
  event_id   text        primary key references public.policy_events (id),
  base       jsonb       not null default '{}',
  summary    text,
  reasons    text[]      not null default '{}',
  doc_sha256 text,
  origin     text        not null default 'cloud',
  updated_at timestamptz not null default now(),
  constraint fact_sheets_origin check (origin in ('cloud', 'auto')),
  constraint fact_sheets_summary check (summary is null or length(summary) <= 800)
);

create or replace function public.reason_codes() returns text[] language sql immutable as $$
  select array['no_figures', 'no_financial_sheet', 'type_not_modelled', 'no_company_data', 'missing_assumption',
    'quote_not_found', 'ai_pending', 'source_unreadable', 'advice_language'] $$;

-- Public contracts won by a listed company or a subsidiary (SEAP open data, matched by CUI only).
create table if not exists public.public_contracts (
  id              text        primary key,
  cui             text        not null,
  ticker          text        not null,
  authority       text        not null default '',
  title           text        not null default '',
  cpv             text,
  value_ron       numeric,
  currency        text        not null default 'RON',
  signed_on       date,
  duration_months integer,
  source_url      text        not null,
  stored_at       timestamptz not null default now(),
  constraint public_contracts_url check (source_url ~ '^https://')
);
create index if not exists public_contracts_ticker on public.public_contracts (ticker, signed_on desc);

-- State aid received (no source with an export yet: LEGAL-SOURCES.md, section 6).
create table if not exists public.state_aid (
  id         text        primary key,
  cui        text        not null,
  ticker     text        not null,
  granter    text        not null default '',
  scheme     text        not null default '',
  amount_ron numeric,
  granted_on date,
  source_url text        not null,
  stored_at  timestamptz not null default now(),
  constraint state_aid_url check (source_url ~ '^https://')
);

-- Automatic analyses live beside the reviewed ones; withdrawal hides one, with its reason.
alter table public.impact_analyses add column if not exists origin text not null default 'manual';
alter table public.impact_analyses add column if not exists doc_sha256 text;
alter table public.impact_analyses add column if not exists withdrawn_at timestamptz;
alter table public.impact_analyses add column if not exists withdrawn_reason text;
do $$ begin
  alter table public.impact_analyses add constraint impact_analyses_origin check (origin in ('manual', 'auto'));
exception when duplicate_object then null; end $$;

-- Published means fixed: only the alert bookkeeping may change, and the withdrawal fields be
-- filled once.
create or replace function public.impact_analyses_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (new.id, new.version, new.published_at, new.title, new.policy, new.events, new.sectors, new.body, new.content_hash, new.synced_at, new.origin, new.doc_sha256)
     is distinct from (old.id, old.version, old.published_at, old.title, old.policy, old.events, old.sectors, old.body, old.content_hash, old.synced_at, old.origin, old.doc_sha256)
     or (old.withdrawn_at is not null and (new.withdrawn_at, new.withdrawn_reason) is distinct from (old.withdrawn_at, old.withdrawn_reason)) then
    raise exception 'published analyses do not change: publish a new version' using errcode = '42501';
  end if;
  return new;
end $$;

alter table public.policy_documents enable row level security;
alter table public.fact_sheets enable row level security;
alter table public.public_contracts enable row level security;
alter table public.state_aid enable row level security;
revoke all on public.policy_documents, public.fact_sheets, public.public_contracts, public.state_aid from anon, authenticated;
grant select on public.policy_documents, public.fact_sheets, public.public_contracts, public.state_aid to authenticated;
grant all on public.policy_documents, public.fact_sheets, public.public_contracts, public.state_aid to service_role;
drop policy if exists "read documents" on public.policy_documents;
create policy "read documents" on public.policy_documents for select to authenticated using (public.is_approved());
drop policy if exists "read sheets" on public.fact_sheets;
create policy "read sheets" on public.fact_sheets for select to authenticated using (public.is_approved());
drop policy if exists "read contracts" on public.public_contracts;
create policy "read contracts" on public.public_contracts for select to authenticated using (public.is_approved());
drop policy if exists "read aid" on public.state_aid;
create policy "read aid" on public.state_aid for select to authenticated using (public.is_approved());

-- ---------------------------------------------------------------------------------------
-- The local batch: documents not yet read in this version (no automatic sheet or analysis for
-- the same text), oldest first.
create or replace function public.auto_pending(p_secret text, p_limit integer default 10)
returns table (event_id text, title text, status text, url text, parts jsonb, text text, doc_sha256 text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select d.event_id, e.title, e.status, d.url, d.parts, d.text, d.sha256
      from policy_documents d join policy_events e on e.id = d.event_id
     where d.status = 'ok'
       and not exists (select 1 from fact_sheets f where f.event_id = d.event_id and f.origin = 'auto' and f.doc_sha256 = d.sha256)
       and not exists (select 1 from impact_analyses a where a.origin = 'auto' and a.doc_sha256 = d.sha256 and d.event_id = any (a.events))
     order by d.fetched_at, d.sha256
     limit least(greatest(coalesce(p_limit, 10), 1), 50);
end $$;

-- What the batch decided for one document: an analysis (with the engine's results) or a sheet
-- with reasons. The version is the next one for the analysis id; the same document twice is a
-- duplicate. The sheet is updated either way.
create or replace function public.auto_save(p_secret text, p_payload jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ev text := p_payload->>'event_id'; sha text := p_payload->>'doc_sha256';
  a jsonb := p_payload->'analysis'; aid text; v integer; body jsonb; r jsonb;
  codes text[];
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from policy_documents d where d.event_id = ev and d.sha256 = sha) then raise exception 'unknown document'; end if;
  select coalesce(array_agg(c), '{}') into codes from jsonb_array_elements_text(coalesce(p_payload->'reasons', '[]')) c where c = any (public.reason_codes());
  if jsonb_typeof(a) = 'object' then
    aid := a->>'id';
    if aid !~ '^auto-[a-z0-9-]{1,56}$' then raise exception 'automatic analysis ids start with auto-'; end if;
    if exists (select 1 from impact_analyses x where x.id = aid and x.doc_sha256 = sha) then
      return jsonb_build_object('saved', 0, 'kind', 'duplicate');
    end if;
    select coalesce(max(x.version), 0) + 1 into v from impact_analyses x where x.id = aid;
    body := a || jsonb_build_object('version', v, 'origin', 'auto');
    insert into impact_analyses (id, version, published_at, title, policy, events, sectors, body, content_hash, origin, doc_sha256)
    values (aid, v, coalesce((a->>'published_at')::date, current_date), left(coalesce(a->>'title', ''), 300), coalesce(a->>'policy', aid),
      array[ev], coalesce(array(select jsonb_array_elements_text(a->'sectors')), '{}'), body,
      encode(sha256(convert_to(body::text, 'UTF8')), 'hex'), 'auto', sha);
    for r in select * from jsonb_array_elements(coalesce(p_payload->'results', '[]')) loop
      insert into impact_results (analysis_id, version, engine_version, scenario, subject, vals, formula)
      values (aid, v, r->>'engine_version', r->>'scenario', r->>'subject', r->'vals', coalesce(r->>'formula', ''));
    end loop;
    codes := '{}';
  end if;
  insert into fact_sheets (event_id, summary, reasons, doc_sha256, origin, updated_at)
  values (ev, left(nullif(coalesce(p_payload->>'summary', a->>'summary'), ''), 800), codes, sha, 'auto', now())
  on conflict (event_id) do update set summary = excluded.summary, reasons = excluded.reasons, doc_sha256 = excluded.doc_sha256,
    origin = 'auto', updated_at = now();
  if aid is not null then return jsonb_build_object('saved', 1, 'kind', 'analysis', 'id', aid, 'version', v); end if;
  return jsonb_build_object('saved', 1, 'kind', 'sheet');
end $$;
revoke all on function public.auto_pending(text, integer) from public;
revoke all on function public.auto_save(text, jsonb) from public;
grant execute on function public.auto_pending(text, integer) to anon, service_role;
grant execute on function public.auto_save(text, jsonb) to anon, service_role;

-- The Chamber's documents are read on the owner's PC (it does not answer GitHub): the batch
-- asks which Chamber events have no documents yet and saves what it read.
create or replace function public.docs_missing(p_secret text, p_limit integer default 20)
returns table (event_id text, source_url text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select e.id, e.source_url from policy_events e
     where e.id like 'cdep:%' and not exists (select 1 from policy_documents d where d.event_id = e.id)
     order by e.event_date desc nulls last, e.id
     limit least(greatest(coalesce(p_limit, 20), 1), 100);
end $$;
create or replace function public.documents_save(p_secret text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0; c integer;
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 50 then raise exception 'rows must be a list of up to 50'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when not exists (select 1 from policy_events e where e.id = r->>'event_id');
    if coalesce(r->>'url', '') !~ '^https://' then raise exception 'document urls must be https'; end if;
    insert into policy_documents (event_id, sha256, url, parts, text, chars, status)
    values (r->>'event_id', r->>'sha256', r->>'url', coalesce(r->'parts', '[]'), left(coalesce(r->>'text', ''), 400000),
      length(left(coalesce(r->>'text', ''), 400000)), coalesce(r->>'status', 'ok'))
    on conflict (event_id, sha256) do nothing;
    get diagnostics c = row_count;
    n := n + c;
  end loop;
  return n;
end $$;
revoke all on function public.docs_missing(text, integer) from public;
revoke all on function public.documents_save(text, jsonb) from public;
grant execute on function public.docs_missing(text, integer) to anon, service_role;
grant execute on function public.documents_save(text, jsonb) to anon, service_role;

-- The ingestion rewrites base sheets; one the batch has written stays as the batch wrote it.
create or replace function public.fact_sheets_keep_auto() returns trigger language plpgsql as $$
begin
  if old.origin = 'auto' and new.origin = 'cloud' then return old; end if;
  return new;
end $$;
drop trigger if exists fact_sheets_keep_auto on public.fact_sheets;
create trigger fact_sheets_keep_auto before update on public.fact_sheets for each row execute function public.fact_sheets_keep_auto();

-- An admin hides a wrong automatic analysis; the reason is shown to readers instead.
create or replace function public.admin_withdraw_analysis(p_id text, p_version integer, p_reason text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if length(trim(coalesce(p_reason, ''))) < 5 then raise exception 'a reason is required'; end if;
  if exists (select 1 from impact_analyses where id = p_id and version = p_version and withdrawn_at is not null) then raise exception 'already withdrawn'; end if;
  update impact_analyses set withdrawn_at = now(), withdrawn_reason = left(trim(p_reason), 300) where id = p_id and version = p_version;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.admin_withdraw_analysis(text, integer, text) from public, anon;
grant execute on function public.admin_withdraw_analysis(text, integer, text) to authenticated;
