-- Economic impact analyses (Phase C): versioned analyses of policy measures, their frozen
-- model results, the results observed later, the companies' reported figures, the knowledge
-- graph over all of it, the policy push alerts, and the local model's annotations awaiting
-- review. Design: docs/plans/2026-10-18-faza-c-design.md; formulas: templates/shared/hif-impact.js.
--
-- Run once in the SQL Editor, after approval.sql, push.sql, holdings.sql, summaries.sql and
-- policy.sql; safe to run again. Written by the ingestion job (ingest/impact/, service role)
-- from the files in analyses/ and config/company-financials.json; read by approved accounts.
-- A published analysis and its results never change: a correction is a new version.

-- ---------------------------------------------------------------------------------------
-- The companies' reported figures. 'manual': read from the annual report (source_url),
-- checked in review; 'filing_auto': read by the local model from a filing, not checked.
create table if not exists public.company_financials (
  ticker           text        not null,
  fiscal_year      integer     not null,
  provenance       text        not null default 'manual',
  currency         text        not null default 'RON',
  revenue          numeric     not null,
  operating_profit numeric     not null,
  net_profit       numeric,
  geo_ro_pct       numeric,
  geo_eu_pct       numeric,
  geo_other_pct    numeric,
  segments         jsonb       not null default '[]',   -- [{ sector, pct }]
  source_url       text        not null,
  verified         boolean     not null default false,
  updated_at       timestamptz not null default now(),
  primary key (ticker, fiscal_year, provenance),
  constraint company_financials_ticker check (ticker ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$'),
  constraint company_financials_provenance check (provenance in ('manual', 'filing_auto')),
  constraint company_financials_currency check (currency in ('RON', 'EUR')),
  constraint company_financials_url check (source_url ~ '^https://')
);

-- ---------------------------------------------------------------------------------------
-- One row per published version of an analysis (analyses/<id>/v<N>.json, kept whole in body).
create table if not exists public.impact_analyses (
  id            text        not null,
  version       integer     not null,
  published_at  date        not null,
  title         text        not null,
  policy        text        not null,
  events        text[]      not null default '{}',
  sectors       text[]      not null default '{}',
  body          jsonb       not null,
  content_hash  text        not null,
  synced_at     timestamptz not null default now(),
  alerted_at    timestamptz,
  primary key (id, version),
  constraint impact_analyses_id check (id ~ '^[a-z0-9][a-z0-9-]{1,60}$' and policy ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  constraint impact_analyses_hash check (content_hash ~ '^[0-9a-f]{64}$')
);
create index if not exists impact_analyses_events on public.impact_analyses using gin (events);

-- The engine's results, frozen when the version was published (engine_version says which formulas).
create table if not exists public.impact_results (
  analysis_id    text        not null,
  version        integer     not null,
  engine_version text        not null,
  scenario       text        not null,
  subject        text        not null,                -- 'budget' or a ticker
  vals           jsonb       not null,
  formula        text        not null,
  computed_at    timestamptz not null default now(),
  primary key (analysis_id, version, engine_version, scenario, subject),
  foreign key (analysis_id, version) references public.impact_analyses (id, version),
  constraint impact_results_scenario check (scenario in ('full', 'partial', 'delayed'))
);

-- What actually happened, recorded later with its source (analyses/<id>/outcomes.json).
create table if not exists public.impact_outcomes (
  analysis_id  text        not null,
  version      integer     not null,
  scenario     text        not null,
  subject      text        not null,
  metric       text        not null,
  period       text        not null,
  observed     numeric     not null,
  source_url   text        not null,
  recorded_at  timestamptz not null default now(),
  primary key (analysis_id, version, scenario, subject, metric, period),
  foreign key (analysis_id, version) references public.impact_analyses (id, version),
  constraint impact_outcomes_scenario check (scenario in ('full', 'partial', 'delayed')),
  constraint impact_outcomes_metric check (metric in ('operating_profit_change', 'budget_effect')),
  constraint impact_outcomes_url check (source_url ~ '^https://')
);

-- Published means fixed: only the alert bookkeeping may change.
create or replace function public.impact_analyses_immutable() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' or (new.id, new.version, new.published_at, new.title, new.policy, new.events, new.sectors, new.body, new.content_hash, new.synced_at)
     is distinct from (old.id, old.version, old.published_at, old.title, old.policy, old.events, old.sectors, old.body, old.content_hash, old.synced_at) then
    raise exception 'published analyses do not change: publish a new version' using errcode = '42501';
  end if;
  return new;
end $$;
drop trigger if exists impact_analyses_immutable on public.impact_analyses;
create trigger impact_analyses_immutable before update or delete on public.impact_analyses
  for each row execute function public.impact_analyses_immutable();
create or replace function public.impact_results_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'results do not change: they are frozen with the engine version' using errcode = '42501';
end $$;
drop trigger if exists impact_results_immutable on public.impact_results;
create trigger impact_results_immutable before update or delete on public.impact_results
  for each row execute function public.impact_results_immutable();

-- ---------------------------------------------------------------------------------------
-- The local model's output (tools/policy-ai-batch.mjs), shown to readers only once an admin
-- has checked it.
create table if not exists public.ai_annotations (
  id           bigserial   primary key,
  target_type  text        not null default 'policy_event',
  target_id    text        not null,
  kind         text        not null,
  content      jsonb       not null,
  model        text        not null,
  status       text        not null default 'unverified',
  created_at   timestamptz not null default now(),
  reviewed_by  uuid,
  reviewed_at  timestamptz,
  unique (target_type, target_id, kind),
  constraint ai_annotations_target check (target_type in ('policy_event')),
  constraint ai_annotations_kind check (kind in ('summary', 'entities', 'sectors')),
  constraint ai_annotations_status check (status in ('unverified', 'verified', 'rejected')),
  constraint ai_annotations_size check (length(content::text) < 8000 and length(model) < 120)
);

-- ---------------------------------------------------------------------------------------
-- Row-level security: approved accounts read; only the service role writes.
alter table public.company_financials enable row level security;
alter table public.company_financials force row level security;
alter table public.impact_analyses enable row level security;
alter table public.impact_analyses force row level security;
alter table public.impact_results enable row level security;
alter table public.impact_results force row level security;
alter table public.impact_outcomes enable row level security;
alter table public.impact_outcomes force row level security;
alter table public.ai_annotations enable row level security;
alter table public.ai_annotations force row level security;
revoke all on public.company_financials, public.impact_analyses, public.impact_results, public.impact_outcomes, public.ai_annotations from anon, authenticated;
grant select on public.company_financials, public.impact_analyses, public.impact_results, public.impact_outcomes, public.ai_annotations to authenticated;

drop policy if exists "read financials" on public.company_financials;
create policy "read financials" on public.company_financials for select to authenticated using (public.is_approved() and (verified or public.is_admin()));
drop policy if exists "read analyses" on public.impact_analyses;
create policy "read analyses" on public.impact_analyses for select to authenticated using (public.is_approved());
drop policy if exists "read results" on public.impact_results;
create policy "read results" on public.impact_results for select to authenticated using (public.is_approved());
drop policy if exists "read outcomes" on public.impact_outcomes;
create policy "read outcomes" on public.impact_outcomes for select to authenticated using (public.is_approved());
drop policy if exists "read annotations" on public.ai_annotations;
create policy "read annotations" on public.ai_annotations for select to authenticated using (public.is_approved() and (status = 'verified' or public.is_admin()));

-- ---------------------------------------------------------------------------------------
-- The knowledge graph: nodes and edges read from the tables above (never stored twice).
-- security_invoker: a reader sees only the edges of rows they may read.
create or replace view public.knowledge_edges with (security_invoker = true) as
  select 'event'::text src_type, e.id src_id, 'classified_as'::text relation, 'sector'::text dst_type, s.sector dst_id,
         null::text analysis_id, null::integer version, null::text evidence
    from public.policy_events e, unnest(e.sectors) s(sector)
  union all
  select 'event', e.id, 'affects', 'company', c->>'ticker', null, null, c->>'why'
    from public.policy_events e, jsonb_array_elements(e.companies) c
  union all
  select 'policy', a.policy, 'evidenced_by', 'event', ev, a.id, a.version, null
    from public.impact_analyses a, unnest(a.events) ev
  union all
  select 'policy', a.policy, 'targets', 'sector', s, a.id, a.version, null
    from public.impact_analyses a, unnest(a.sectors) s
  union all
  select 'policy', a.policy, 'modelled_as', 'scenario', a.id || ':v' || a.version || ':' || sc, a.id, a.version, null
    from public.impact_analyses a, unnest(array['full', 'partial', 'delayed']) sc
  union all
  select 'scenario', a.id || ':v' || a.version || ':' || sc, 'estimates', 'company', c->>'ticker', a.id, a.version, c->>'why'
    from public.impact_analyses a, jsonb_array_elements(a.body->'companies') c, unnest(array['full', 'partial', 'delayed']) sc
  union all
  select distinct 'company', t, 'listed_as', 'instrument', t, null::text, null::integer, null::text
    from (select c->>'ticker' t from public.policy_events e, jsonb_array_elements(e.companies) c
          union select c->>'ticker' from public.impact_analyses a, jsonb_array_elements(a.body->'companies') c) x
  union all
  select 'outcome', o.analysis_id || ':v' || o.version || ':' || o.scenario || ':' || o.subject || ':' || o.period, 'observes', 'scenario',
         o.analysis_id || ':v' || o.version || ':' || o.scenario, o.analysis_id, o.version, o.source_url
    from public.impact_outcomes o;

create or replace view public.knowledge_nodes with (security_invoker = true) as
  select distinct n.type, n.id, coalesce(e.title, a.title, n.id) label
  from (select src_type type, src_id id from public.knowledge_edges union select dst_type, dst_id from public.knowledge_edges) n
  left join public.policy_events e on n.type = 'event' and e.id = n.id
  left join lateral (select title from public.impact_analyses x where n.type = 'policy' and x.policy = n.id order by version desc limit 1) a on true;

-- The frozen estimate for the year observed, against what was observed.
create or replace view public.analysis_accuracy with (security_invoker = true) as
  select o.analysis_id, o.version, o.scenario, o.subject, o.metric, o.period, r.engine_version,
         (r.vals->'byYear'->>o.period)::numeric estimated, o.observed,
         o.observed - (r.vals->'byYear'->>o.period)::numeric error,
         round((o.observed - (r.vals->'byYear'->>o.period)::numeric) / nullif(abs((r.vals->'byYear'->>o.period)::numeric), 0), 10) rel_error,
         sign(o.observed) = sign((r.vals->'byYear'->>o.period)::numeric) direction,
         o.source_url
  from public.impact_outcomes o
  join lateral (select * from public.impact_results x where x.analysis_id = o.analysis_id and x.version = o.version
                  and x.scenario = o.scenario and x.subject = o.subject order by x.computed_at limit 1) r on true;

-- A company's exposure as counts anyone can check, not a score: events of the last 12 months
-- not ended that name it or reach it through a sector, acts adopted, analyses that include it.
create or replace view public.company_exposure with (security_invoker = true) as
  with links as (
    select c->>'ticker' ticker, c->>'why' why, e.status, e.event_date
    from public.policy_events e, jsonb_array_elements(e.companies) c
    where e.event_date > current_date - 365
  ), tickers as (
    select ticker from links union select c->>'ticker' from public.impact_analyses a, jsonb_array_elements(a.body->'companies') c
  )
  select t.ticker,
    (select count(*) from links l where l.ticker = t.ticker and l.why = 'mentioned' and l.status <> 'stopped')::integer mentioned,
    (select count(*) from links l where l.ticker = t.ticker and l.why = 'sector' and l.status <> 'stopped')::integer via_sector,
    (select count(*) from links l where l.ticker = t.ticker and l.status in ('adopted', 'in_force', 'implemented'))::integer adopted,
    (select count(distinct a.id) from public.impact_analyses a, jsonb_array_elements(a.body->'companies') c where c->>'ticker' = t.ticker)::integer analyses
  from tickers t;

grant select on public.knowledge_edges, public.knowledge_nodes, public.analysis_accuracy, public.company_exposure to authenticated;
revoke all on public.knowledge_edges, public.knowledge_nodes, public.analysis_accuracy, public.company_exposure from anon;

-- ---------------------------------------------------------------------------------------
-- Policy push alerts (sent by the scan Edge Function, ?mode=alerts). Rows that exist when the
-- columns are first added count as alerted, so the first run sends nothing old.
do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'policy_events' and column_name = 'alerted_at') then
    alter table public.policy_events add column alerted_at timestamptz;
    update public.policy_events set alerted_at = now();
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'policy_event_history' and column_name = 'alerted_at') then
    alter table public.policy_event_history add column alerted_at timestamptz;
    update public.policy_event_history set alerted_at = now();
  end if;
end $$;
-- Per device: the app's "Policy alerts" switch.
alter table public.push_subscriptions add column if not exists policy_alerts boolean not null default true;

-- Who is due an alert, with what: a new event or a status change naming one of their companies
-- (watchlist with push on, or holdings), the same through a sector only once the act is
-- adopted, and a new analysis that includes one. One row per user with a device that has
-- policy alerts on. p_since: older rows are left out (they are marked all the same).
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
    where a.alerted_at is null and a.synced_at >= p_since
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

-- Marks everything waiting up to p_until (the time the alerts were worked out) as alerted.
create or replace function public.policy_alerts_mark(p_until timestamptz) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer; m integer; k integer;
begin
  update policy_events set alerted_at = now() where alerted_at is null and first_seen <= p_until;
  get diagnostics n = row_count;
  update policy_event_history set alerted_at = now() where alerted_at is null and changed_at <= p_until;
  get diagnostics m = row_count;
  update impact_analyses set alerted_at = now() where alerted_at is null and synced_at <= p_until;
  get diagnostics k = row_count;
  return n + m + k;
end $$;
revoke all on function public.policy_alerts_due(timestamptz) from public, anon, authenticated;
revoke all on function public.policy_alerts_mark(timestamptz) from public, anon, authenticated;
grant execute on function public.policy_alerts_due(timestamptz) to service_role;
grant execute on function public.policy_alerts_mark(timestamptz) to service_role;

-- ---------------------------------------------------------------------------------------
-- The local model's batch saves with the summary secret (as summaries_save); status is
-- always 'unverified' and a reviewed annotation is never overwritten.
create or replace function public.ai_annotations_save(p_secret text, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0; c integer;
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 200 then raise exception 'rows must be a list of up to 200'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    continue when not exists (select 1 from policy_events e where e.id = r->>'target_id');
    continue when coalesce(r->>'kind', '') not in ('summary', 'entities', 'sectors');
    continue when jsonb_typeof(r->'content') is distinct from 'object' or length((r->'content')::text) >= 8000;
    insert into ai_annotations (target_type, target_id, kind, content, model)
    values ('policy_event', r->>'target_id', r->>'kind', r->'content', left(coalesce(r->>'model', ''), 119))
    on conflict (target_type, target_id, kind) do update set content = excluded.content, model = excluded.model, created_at = now()
      where ai_annotations.status = 'unverified';
    get diagnostics c = row_count;
    n := n + c;
  end loop;
  return n;
end $$;
revoke all on function public.ai_annotations_save(text, jsonb) from public, anon;
grant execute on function public.ai_annotations_save(text, jsonb) to authenticated, anon, service_role;

-- The admin screen: what waits for review, and the decision.
create or replace function public.admin_ai_pending()
returns setof public.ai_annotations
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  return query select * from ai_annotations where status = 'unverified' order by created_at desc limit 100;
end $$;
create or replace function public.admin_ai_review(p_id bigint, p_decision text) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not public.is_admin() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p_decision not in ('verified', 'rejected') then raise exception 'decision must be verified or rejected'; end if;
  update ai_annotations set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now() where id = p_id and status = 'unverified';
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.admin_ai_pending() from public, anon;
revoke all on function public.admin_ai_review(bigint, text) from public, anon;
grant execute on function public.admin_ai_pending() to authenticated;
grant execute on function public.admin_ai_review(bigint, text) to authenticated;

-- What the batch reads next: events not annotated in all three kinds yet, newest first.
create or replace function public.ai_annotations_pending(p_secret text, p_limit integer default 20)
returns table (id text, title text, summary text, event_date date)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then raise exception 'not allowed' using errcode = '42501'; end if;
  return query
    select e.id, e.title, e.summary, e.event_date from policy_events e
    where (select count(*) from ai_annotations a where a.target_type = 'policy_event' and a.target_id = e.id) < 3
    order by e.event_date desc, e.id desc
    limit greatest(1, least(coalesce(p_limit, 20), 200));
end $$;
revoke all on function public.ai_annotations_pending(text, integer) from public, anon;
grant execute on function public.ai_annotations_pending(text, integer) to authenticated, anon, service_role;
