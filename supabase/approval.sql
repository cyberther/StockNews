-- Market Pulse: new accounts wait for the owner's approval.
--
-- Anyone can still sign up (email or Google), but a new account starts unapproved: the app
-- shows "awaiting approval", and nothing else is readable or writable for it, here (row-level
-- security) or through the market data gateway (netlify/functions/_shared/market/gateway.js).
-- The background scan sends the admins a push alert for each new account
-- (supabase/functions/scan/index.ts).
--
-- To approve: Table Editor -> account_status -> the row with that email -> approved = true.
-- To make an account an admin (gets the alerts): is_admin = true.
--
-- Run once in the Supabase SQL editor, after server/schema.sql, push.sql, holdings.sql,
-- summaries.sql, digests.sql and filings.sql, and again after re-running any of them (they
-- recreate their policies without the approval check); safe to run again. Accounts that
-- exist when it first runs are approved.

alter table public.account_status add column if not exists approved boolean not null default false;
alter table public.account_status add column if not exists is_admin boolean not null default false;
alter table public.account_status add column if not exists email text;
alter table public.account_status add column if not exists requested_at timestamptz not null default now();
alter table public.account_status add column if not exists notified_at timestamptz;

-- Every existing account: approved, nothing to announce.
insert into public.account_status (user_id, approved, email, notified_at)
select u.id, true, u.email, now() from auth.users u
on conflict (user_id) do nothing;
update public.account_status s set email = u.email from auth.users u where u.id = s.user_id and s.email is null;

-- A new account gets its row, unapproved.
create or replace function public.account_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.account_status (user_id, approved, email) values (new.id, false, new.email)
  on conflict (user_id) do nothing;
  return new;
end $$;
revoke all on function public.account_created() from public, anon, authenticated;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.account_created();

-- Whether the caller may use the app: approved and not suspended.
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.approved and not s.suspended);
$$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;

-- Row-level security: every policy for signed-in users also needs approval. (Their own
-- account_status row stays readable, so the app can say the account is waiting.)
drop policy if exists "read filings" on public.filings;
create policy "read filings" on public.filings for select to authenticated using (public.is_approved());
drop policy if exists "read stories" on public.stories;
create policy "read stories" on public.stories for select to authenticated using (public.is_approved());
drop policy if exists "read summaries" on public.story_summaries;
create policy "read summaries" on public.story_summaries for select to authenticated using (public.is_approved());
drop policy if exists "read digests" on public.ticker_digests;
create policy "read digests" on public.ticker_digests for select to authenticated using (public.is_approved());
drop policy if exists "read cache" on public.quote_cache;
create policy "read cache" on public.quote_cache for select to authenticated using (public.is_approved());
drop policy if exists "read scan runs" on public.scan_runs;
create policy "read scan runs" on public.scan_runs for select to authenticated using (public.is_approved());

drop policy if exists "read own watchlist" on public.watchlist;
create policy "read own watchlist" on public.watchlist for select to authenticated using (user_id = auth.uid() and public.is_approved());
drop policy if exists "add to own watchlist" on public.watchlist;
create policy "add to own watchlist" on public.watchlist for insert to authenticated with check (user_id = auth.uid() and public.is_approved());
drop policy if exists "edit own watchlist" on public.watchlist;
create policy "edit own watchlist" on public.watchlist for update to authenticated using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid());
drop policy if exists "trim own watchlist" on public.watchlist;
create policy "trim own watchlist" on public.watchlist for delete to authenticated using (user_id = auth.uid() and public.is_approved());

drop policy if exists "read own holdings" on public.holdings;
create policy "read own holdings" on public.holdings for select to authenticated using (user_id = auth.uid() and public.is_approved());
drop policy if exists "add own holdings" on public.holdings;
create policy "add own holdings" on public.holdings for insert to authenticated with check (user_id = auth.uid() and public.is_approved());
drop policy if exists "edit own holdings" on public.holdings;
create policy "edit own holdings" on public.holdings for update to authenticated using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid());
drop policy if exists "remove own holdings" on public.holdings;
create policy "remove own holdings" on public.holdings for delete to authenticated using (user_id = auth.uid() and public.is_approved());

drop policy if exists "read own devices" on public.push_subscriptions;
create policy "read own devices" on public.push_subscriptions for select to authenticated using (user_id = auth.uid() and public.is_approved());
drop policy if exists "add own device" on public.push_subscriptions;
create policy "add own device" on public.push_subscriptions for insert to authenticated with check (user_id = auth.uid() and public.is_approved());
drop policy if exists "update own device" on public.push_subscriptions;
create policy "update own device" on public.push_subscriptions for update to authenticated using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid());
drop policy if exists "remove own device" on public.push_subscriptions;
create policy "remove own device" on public.push_subscriptions for delete to authenticated using (user_id = auth.uid());
