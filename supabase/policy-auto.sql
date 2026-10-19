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

-- Open-data files already read (ingest/state/seap.mjs reads each once). Ingestion only.
create table if not exists public.state_sources (
  url          text        primary key,
  kind         text        not null,
  rows         integer     not null default 0,
  processed_at timestamptz not null default now()
);
alter table public.state_sources enable row level security;
revoke all on public.state_sources from anon, authenticated;
grant all on public.state_sources to service_role;

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
drop function if exists public.auto_pending(text, integer);
create or replace function public.auto_pending(p_secret text, p_limit integer default 10)
returns table (event_id text, title text, status text, sectors text[], url text, parts jsonb, text text, doc_sha256 text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select d.event_id, e.title, e.status, e.sectors, d.url, d.parts, d.text, d.sha256
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

-- ---------------------------------------------------------------------------------------
-- "Cine câștigă": who gains or loses from what the state does, each link with its evidence.
-- Information, never a recommendation. Read with the reader's own rights (security_invoker):
-- approved accounts, and Pro-only results stay Pro-only.
--   named      the company is named in the act                         neutral
--   sector     its sector is the act's subject                         neutral (no fact of direction)
--   contract   a public contract it won (SEAP, by fiscal code)         gains
--   state_aid  state aid it received                                  gains
--   tax_payer  an analysis puts a cost on it (full scenario)           loses
--   named      an analysis puts a gain on it (full scenario)           gains
drop view if exists public.company_state_exposure;
drop view if exists public.state_links;
create or replace view public.state_links with (security_invoker = true) as
  select c->>'ticker' as subject_ticker, case when c->>'why' = 'sector' then 'sector' else 'named' end as link_type, 'neutral'::text as direction,
         e.id as event_id, null::text as analysis_id, e.source_url as evidence_url, null::numeric as amount_ron, e.event_date::date as at, e.title as title
    from public.policy_events e, jsonb_array_elements(e.companies) c
  union all
  select p.ticker, 'contract', 'gains', null, null, p.source_url, p.value_ron, p.signed_on, p.authority || coalesce(' · CPV ' || p.cpv, '') from public.public_contracts p
  union all
  select s.ticker, 'state_aid', 'gains', null, null, s.source_url, s.amount_ron, s.granted_on, s.granter || coalesce(' · ' || nullif(s.scheme, ''), '') from public.state_aid s
  union all
  select r.subject, case when (r.vals->>'profitDelta')::numeric < 0 then 'tax_payer' else 'named' end,
         case when (r.vals->>'profitDelta')::numeric < 0 then 'loses' else 'gains' end,
         a.events[1], a.id, coalesce(a.body->'facts'->0->>'source_url', (select x.source_url from public.policy_events x where x.id = a.events[1])),
         abs((r.vals->>'profitDelta')::numeric), a.published_at, a.title
    from public.impact_results r join public.impact_analyses a on a.id = r.analysis_id and a.version = r.version
   where r.scenario = 'full' and r.subject <> 'budget' and a.withdrawn_at is null
     and (r.vals->>'profitDelta') is not null and (r.vals->>'profitDelta')::numeric <> 0
     and a.version = (select max(b.version) from public.impact_analyses b where b.id = a.id and b.withdrawn_at is null);

-- Per company: public contracts and aid in the last 12 months (sums, and contracts as a share of
-- the latest audited revenue), and how many measures favour or burden it.
create or replace view public.company_state_exposure with (security_invoker = true) as
  with t as (select distinct subject_ticker as ticker from public.state_links),
  rev as (select distinct on (ticker) ticker, revenue from public.company_financials where verified and revenue > 0 order by ticker, fiscal_year desc)
  select t.ticker,
         coalesce((select sum(value_ron) from public.public_contracts p where p.ticker = t.ticker and p.signed_on >= current_date - 365), 0) as contracts_12m_ron,
         round(100 * (select sum(value_ron) from public.public_contracts p where p.ticker = t.ticker and p.signed_on >= current_date - 365) / rev.revenue, 2) as contracts_12m_pct_revenue,
         coalesce((select sum(amount_ron) from public.state_aid s where s.ticker = t.ticker and s.granted_on >= current_date - 365), 0) as aid_12m_ron,
         (select count(distinct coalesce(analysis_id, event_id))::int from public.state_links l where l.subject_ticker = t.ticker and l.direction = 'gains' and l.link_type not in ('contract', 'state_aid')) as measures_gain,
         (select count(distinct coalesce(analysis_id, event_id))::int from public.state_links l where l.subject_ticker = t.ticker and l.direction = 'loses') as measures_lose
    from t left join rev on rev.ticker = t.ticker;

-- Where the state's money goes, by month: contracts won by listed companies by kind of purchase
-- (CPV division), and adopted acts per policy sector.
create or replace view public.sector_state_flows with (security_invoker = true) as
  select 'cpv'::text as dimension, left(p.cpv, 2) as key, date_trunc('month', p.signed_on)::date as month,
         sum(p.value_ron) as inflow_ron, count(*)::int as contracts, 0 as measures
    from public.public_contracts p where p.cpv ~ '^\d{2}' and p.signed_on is not null group by 2, 3
  union all
  select 'sector', s, date_trunc('month', e.event_date)::date, null, 0, count(*)::int
    from public.policy_events e, unnest(e.sectors) s
   where e.status in ('adopted', 'in_force', 'implemented') and e.event_date is not null group by 2, 3;

grant select on public.state_links, public.company_state_exposure, public.sector_state_flows to authenticated;
revoke all on public.state_links, public.company_state_exposure, public.sector_state_flows from anon;

-- ---------------------------------------------------------------------------------------
-- Alerts (impact.sql's rules, kept as they are) plus the state's money: a public contract won
-- or state aid received by a company the reader follows with push on or holds. Still at most
-- one push per user per run (the scan Edge Function).
alter table public.public_contracts add column if not exists alerted_at timestamptz;
alter table public.state_aid add column if not exists alerted_at timestamptz;

create or replace function public.policy_alerts_due(p_since timestamptz)
returns table (user_id uuid, items jsonb)
language sql stable security definer set search_path = public as $$
  with ev as (
    select 'event' type, e.id, e.title, e.status, c->>'ticker' ticker, c->>'why' why
    from policy_events e, jsonb_array_elements(e.companies) c
    where e.alerted_at is null and e.first_seen >= p_since
    union
    select 'event', e.id, e.title, h.new_value, c->>'ticker', c->>'why'
    from policy_event_history h join policy_events e on e.id = h.event_id, jsonb_array_elements(e.companies) c
    where h.alerted_at is null and h.field = 'status' and h.changed_at >= p_since and e.alerted_at is not null
  ), items as (
    select type, id, title, status, ticker from ev where why = 'mentioned' or status = 'adopted'
    union
    select 'analysis', a.id, a.title, null, c->>'ticker'
    from impact_analyses a, jsonb_array_elements(a.body->'companies') c
    where a.alerted_at is null and a.synced_at >= p_since and a.withdrawn_at is null
    union
    select 'contract', p.id, 'Contract public: ' || p.authority || coalesce(' · ' || to_char(p.value_ron, 'FM999G999G999G990') || ' lei', ''), null, p.ticker
    from public_contracts p where p.alerted_at is null and p.stored_at >= p_since
    union
    select 'aid', s.id, 'Ajutor de stat: ' || s.granter || coalesce(' · ' || to_char(s.amount_ron, 'FM999G999G999G990') || ' lei', ''), null, s.ticker
    from state_aid s where s.alerted_at is null and s.stored_at >= p_since
  ), owners as (
    select w.user_id, w.ticker from watchlist w where w.push
    union
    select h.user_id, h.ticker from holdings h
  )
  select o.user_id, jsonb_agg(distinct jsonb_build_object('type', i.type, 'id', i.id, 'title', i.title, 'status', i.status, 'ticker', i.ticker))
  from items i join owners o on o.ticker = i.ticker
  join account_status s on s.user_id = o.user_id and s.approved and not s.suspended
  where exists (select 1 from push_subscriptions p where p.user_id = o.user_id and p.policy_alerts)
  group by o.user_id;
$$;

create or replace function public.policy_alerts_mark(p_until timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; m integer; k integer; c integer; a integer;
begin
  update policy_events set alerted_at = now() where alerted_at is null and first_seen <= p_until;
  get diagnostics n = row_count;
  update policy_event_history set alerted_at = now() where alerted_at is null and changed_at <= p_until;
  get diagnostics m = row_count;
  update impact_analyses set alerted_at = now() where alerted_at is null and synced_at <= p_until;
  get diagnostics k = row_count;
  update public_contracts set alerted_at = now() where alerted_at is null and stored_at <= p_until;
  get diagnostics c = row_count;
  update state_aid set alerted_at = now() where alerted_at is null and stored_at <= p_until;
  get diagnostics a = row_count;
  return n + m + k + c + a;
end $$;
revoke all on function public.policy_alerts_due(timestamptz) from public, anon, authenticated;
revoke all on function public.policy_alerts_mark(timestamptz) from public, anon, authenticated;
grant execute on function public.policy_alerts_due(timestamptz) to service_role;
grant execute on function public.policy_alerts_mark(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------
-- SEAP's open data is read on the owner's PC (data.gov.ro does not answer GitHub's runners):
-- the files already read, and the contracts of one file. A contract signed more than 30 days
-- ago is stored as already announced, so a first import sends no alerts about old contracts.
create or replace function public.state_sources_done(p_secret text) returns setof text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select url from state_sources;
end $$;
create or replace function public.contracts_save(p_secret text, p_url text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0; c integer;
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_url, '') !~ '^https://' then raise exception 'source urls must be https'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then raise exception 'rows must be a list of up to 5000'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'source_url', '') !~ '^https://' then raise exception 'source urls must be https'; end if;
    insert into public_contracts (id, cui, ticker, authority, title, cpv, value_ron, currency, signed_on, duration_months, source_url, alerted_at)
    values (left(r->>'id', 200), r->>'cui', r->>'ticker', left(coalesce(r->>'authority', ''), 300), left(coalesce(r->>'title', ''), 300), r->>'cpv',
      (r->>'value_ron')::numeric, coalesce(r->>'currency', 'RON'), (r->>'signed_on')::date, (r->>'duration_months')::integer, r->>'source_url',
      case when (r->>'signed_on')::date >= current_date - 30 then null else now() end)
    on conflict (id) do nothing;
    get diagnostics c = row_count;
    n := n + c;
  end loop;
  insert into state_sources (url, kind, rows) values (p_url, 'seap_contracts', jsonb_array_length(p_rows))
  on conflict (url) do update set rows = excluded.rows, processed_at = now();
  return n;
end $$;
revoke all on function public.state_sources_done(text) from public;
revoke all on function public.contracts_save(text, text, jsonb) from public;
grant execute on function public.state_sources_done(text) to anon, service_role;
grant execute on function public.contracts_save(text, text, jsonb) to anon, service_role;
