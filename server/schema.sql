-- Heard It First — run this once in the Supabase SQL editor.
--
-- Row Level Security is what stops one signed-in user reading another's
-- watchlist: every policy below is scoped to auth.uid(), the id of the
-- caller's own session. Never disable it, and never use the service_role
-- key from the browser or the app server (it bypasses these policies).
--
-- Privilege model: the browser and the app server both authenticate as
-- `authenticated`. `anon` gets nothing at all — an unauthenticated caller
-- cannot even attempt a read.

-- ---------------------------------------------------------------------
-- user_settings — one row per user, holding the app's own UI state
-- ---------------------------------------------------------------------
create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  -- An object, never a scalar or an array, and never large enough to be used
  -- as free storage. The app server enforces a key allowlist on top of this.
  constraint user_settings_is_object check (jsonb_typeof(data) = 'object'),
  constraint user_settings_size      check (pg_column_size(data) < 65536)
);

alter table public.user_settings enable row level security;
-- Belt and braces: RLS is bypassed for table owners, so make sure the table is
-- not owned by a role the API ever authenticates as.
alter table public.user_settings force row level security;

revoke all on public.user_settings from anon;
grant select, insert, update on public.user_settings to authenticated;

drop policy if exists "read own settings"   on public.user_settings;
drop policy if exists "insert own settings" on public.user_settings;
drop policy if exists "update own settings" on public.user_settings;
-- Deliberately no delete policy: account deletion cascades from auth.users.

create policy "read own settings"   on public.user_settings
  for select to authenticated using (auth.uid() = user_id);
create policy "insert own settings" on public.user_settings
  for insert to authenticated with check (auth.uid() = user_id);
create policy "update own settings" on public.user_settings
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- A client that sends its own updated_at cannot backdate the row.
create or replace function public.touch_updated_at() returns trigger
  language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists user_settings_touch on public.user_settings;
create trigger user_settings_touch before insert or update on public.user_settings
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- security_events — the in-app audit trail (append only)
-- ---------------------------------------------------------------------
create table if not exists public.security_events (
  id         bigint generated always as identity primary key,
  user_id    uuid        not null references auth.users on delete cascade,
  kind       text        not null,
  detail     text,
  ip         inet,
  created_at timestamptz not null default now(),
  constraint security_events_kind check (kind in (
    'signin', 'signout', 'signout_all', 'twofa_on', 'twofa_off',
    'device_revoked', 'locked', 'unlock_failed', 'password_changed')),
  constraint security_events_detail_len check (detail is null or length(detail) <= 120)
);

create index if not exists security_events_user_time
  on public.security_events (user_id, created_at desc);

alter table public.security_events enable row level security;
alter table public.security_events force row level security;

revoke all on public.security_events from anon;
-- Read and append only. No update, no delete — a user cannot quietly erase the
-- record of a sign-in they did not make, which is the whole point of the log.
grant select, insert on public.security_events to authenticated;

drop policy if exists "read own events"   on public.security_events;
drop policy if exists "append own events" on public.security_events;

create policy "read own events"   on public.security_events
  for select to authenticated using (auth.uid() = user_id);
create policy "append own events" on public.security_events
  for insert to authenticated with check (auth.uid() = user_id);

-- Trim the log so it cannot grow without bound: keep the newest 200 per user.
create or replace function public.trim_security_events() returns trigger
  language plpgsql security definer set search_path = '' as $$
begin
  delete from public.security_events
   where user_id = new.user_id
     and id not in (select id from public.security_events
                     where user_id = new.user_id
                     order by id desc limit 200);
  return null;
end $$;

drop trigger if exists security_events_trim on public.security_events;
create trigger security_events_trim after insert on public.security_events
  for each row execute function public.trim_security_events();

-- ---------------------------------------------------------------------
-- quote_cache — server-side cache of quotes, so a page reload does not
-- spend a Finnhub call. Written by the server only.
-- ---------------------------------------------------------------------
create table if not exists public.quote_cache (
  symbol     text primary key,
  payload    jsonb       not null,
  fetched_at timestamptz not null default now(),
  constraint quote_cache_symbol check (symbol ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$')
);

alter table public.quote_cache enable row level security;
alter table public.quote_cache force row level security;

revoke all on public.quote_cache from anon;
grant select on public.quote_cache to authenticated;

drop policy if exists "read cache" on public.quote_cache;
-- Read for signed-in users; no insert/update/delete policy exists, so writes
-- are only possible from a privileged (service_role) context on the server.
create policy "read cache" on public.quote_cache
  for select to authenticated using (true);
