-- Market Pulse: a user deletes their own account (the right to erasure, GDPR art. 17).
--
-- Account -> Delete account in the web app calls delete_my_account() after the user retypes
-- their password (or, for a Google or Apple account, the confirmation word). Removing the
-- auth.users row removes everything that belongs to it, because every table that holds a
-- user's rows references auth.users "on delete cascade": account_status, user_settings,
-- watchlist, holdings, chart_drawings, push_subscriptions, security_events, and Supabase
-- Auth's own sessions, identities and two-factor factors. The name and phone number live in
-- the auth.users row itself (user metadata). Market data, stories and summaries belong to
-- nobody and stay.
--
-- An account with two-factor sign-in must ask from a session that gave the code (mfa_ok,
-- supabase/mfa.sql). An administrator account can't remove itself here, so the site never
-- loses its last administrator by a slip: another administrator, or the project owner in
-- Authentication -> Users, deletes it.
--
-- Run once in the Supabase SQL editor, after approval.sql and mfa.sql; safe to run again.

create or replace function public.delete_my_account() returns integer
language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n integer;
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.mfa_ok() then raise exception 'two-factor code required' using errcode = '42501'; end if;
  if exists (select 1 from public.account_status where user_id = me and is_admin) then
    raise exception 'administrator account' using errcode = '42501';
  end if;
  delete from auth.users where id = me;
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
