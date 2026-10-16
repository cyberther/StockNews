-- Market Pulse: two-factor sign-in enforced by the database.
--
-- An account with a verified authenticator (Supabase Auth MFA, TOTP) gets its data only
-- with a session that gave the code (JWT claim aal = 'aal2'); an administrator account
-- must have one at all. Every row-level policy goes through is_approved()
-- (supabase/approval.sql), and the market gateway and the scan function ask it too, so a
-- password alone opens nothing for such an account.
--
-- The app asks for the code once per device, at sign-in (templates/shared/hif-auth.js);
-- the aal2 session then lasts through token refreshes until the device signs out.
--
-- Run in the Supabase SQL editor after approval.sql; safe to run again. Before running it,
-- the app every account uses must support the code (staging does; production from its
-- next deploy), or those accounts see empty pages.
--
-- Lost the authenticator? An administrator removes the factor in Authentication -> Users ->
-- the user -> MFA factors (or: delete from auth.mfa_factors where user_id = '...';).

create or replace function public.mfa_ok() returns boolean
language sql stable security definer set search_path = public, auth as $$
  select coalesce(auth.jwt()->>'aal', 'aal1') = 'aal2'
      or (not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
          and not exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.is_admin));
$$;
revoke all on function public.mfa_ok() from public, anon;
grant execute on function public.mfa_ok() to authenticated;

-- Whether the caller may use the app: approved, not suspended, and two-factor satisfied.
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.approved and not s.suspended)
     and public.mfa_ok();
$$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

-- An administrator acts only from a session that gave the code.
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.is_admin and s.approved and not s.suspended)
     and coalesce(auth.jwt()->>'aal', '') = 'aal2';
$$;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;
