-- Political and legislative events from official sources (ingest/policy/, run by the daily
-- ingestion job), shown in the app's Policy screen. Run once in the SQL Editor (it can be run
-- again). Needs supabase/approval.sql (public.is_approved()) first.
--
-- status says where an act stands, taken only from the form of the source, never guessed from
-- the words of a title:
--   statement    an institution's statement or press release
--   draft        a bill or proposal in the legislative procedure
--   adopted      passed / promulgated
--   in_force     in force (no Phase B source sets it yet)
--   implemented  applied in practice (no Phase B source sets it yet)
--   stopped      procedure ended: rejected, withdrawn, filed
-- certainty says what kind of official record it is:
--   official_act        a promulgated act
--   official_procedure  a parliamentary record of a procedure
--   official_statement  an official press release
create table if not exists public.policy_events (
  id           text        primary key,          -- '<source>:<id at the source>', stable
  title        text        not null,
  summary      text,
  event_date   date        not null,
  country      text        not null default 'RO',
  institution  text        not null,
  initiator    text,                              -- Guvern | Parlamentari | the issuing institution
  doc_number   text,                              -- 'PL-x 320/06.10.2025', 'Lege 2/2026'
  source_url   text        not null,
  status       text        not null,
  stage        text,                              -- the source's own wording of the stage
  certainty    text        not null,
  sectors      text[]      not null default '{}',
  caen         text[]      not null default '{}',
  companies    jsonb       not null default '[]', -- [{ ticker, why: mentioned|sector, sector? }]
  figures      jsonb       not null default '[]', -- [{ kind: percent|amount, value, unit, text }]
  first_seen   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint policy_events_status check (status in ('statement', 'draft', 'adopted', 'in_force', 'implemented', 'stopped')),
  constraint policy_events_certainty check (certainty in ('official_act', 'official_procedure', 'official_statement')),
  constraint policy_events_url check (source_url ~ '^https://')
);
create index if not exists policy_events_date on public.policy_events (event_date desc);
create index if not exists policy_events_sectors on public.policy_events using gin (sectors);
create index if not exists policy_events_companies on public.policy_events using gin (companies jsonb_path_ops);

-- Every change of status or stage, as the jobs saw it (append-only).
create table if not exists public.policy_event_history (
  id          bigserial   primary key,
  event_id    text        not null references public.policy_events (id) on delete cascade,
  changed_at  timestamptz not null default now(),
  field       text        not null,
  old_value   text,
  new_value   text
);
create index if not exists policy_event_history_event on public.policy_event_history (event_id, changed_at);

alter table public.policy_events enable row level security;
alter table public.policy_events force row level security;
alter table public.policy_event_history enable row level security;
alter table public.policy_event_history force row level security;

revoke all on public.policy_events from anon, authenticated;
grant select on public.policy_events to authenticated;
revoke all on public.policy_event_history from anon, authenticated;

drop policy if exists "read policy events" on public.policy_events;
create policy "read policy events" on public.policy_events for select to authenticated using (public.is_approved());
