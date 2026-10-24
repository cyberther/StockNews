-- Market Pulse: each account's settings (theme, lock timeout, feed and portfolio views, the
-- chart's set-up overall and per ticker), so they follow the reader to every device
-- (templates/shared/hif-settings.js says which, and checks them when they are read back).
-- Drawings are kept per ticker in chart_drawings (drawings.sql).
-- The table is the one server/schema.sql made for the app's UI state (unused until now): the
-- same columns, here with the rules of the other account tables (an approved account, its own
-- row only, and no rights beyond reading and writing it).
-- Run once in the Supabase SQL editor, after approval.sql (it uses is_approved); safe to run again.
create table if not exists public.user_settings (
  user_id    uuid        primary key references auth.users on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint user_settings_is_object check (jsonb_typeof(data) = 'object'),
  constraint user_settings_size      check (pg_column_size(data) < 65536)
);
alter table public.user_settings enable row level security;
alter table public.user_settings force row level security;
revoke all on public.user_settings from anon, authenticated;
grant select, insert, update, delete on public.user_settings to authenticated;
drop policy if exists "read own settings" on public.user_settings;
create policy "read own settings" on public.user_settings for select to authenticated using (user_id = auth.uid() and public.is_approved());
drop policy if exists "insert own settings" on public.user_settings;
create policy "insert own settings" on public.user_settings for insert to authenticated with check (user_id = auth.uid() and public.is_approved());
drop policy if exists "update own settings" on public.user_settings;
create policy "update own settings" on public.user_settings for update to authenticated using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid());
drop policy if exists "remove own settings" on public.user_settings;
create policy "remove own settings" on public.user_settings for delete to authenticated using (user_id = auth.uid());
