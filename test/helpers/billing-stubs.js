// What supabase/billing.sql relies on from approval.sql, push.sql, holdings.sql and
// server/schema.sql (the plan column), for the PGlite tests of Phase D.
import { readFileSync } from 'node:fs';
import { APPROVED, WAITING } from './supabase-pg.js';

export const ADMIN = '00000000-0000-0000-0000-00000000000a';
export const PAYER = '00000000-0000-0000-0000-000000000004';
export const BILLING_STUBS = `
create table auth.users (id uuid primary key, email text);
insert into auth.users values ('${APPROVED}', 'a@x.ro'), ('${WAITING}', 'w@x.ro'), ('${ADMIN}', 'admin@x.ro'), ('${PAYER}', 'p@x.ro');
alter table public.account_status add column is_admin boolean not null default false, add column plan text not null default 'free';
insert into public.account_status (user_id, approved, suspended, is_admin) values ('${ADMIN}', true, false, true), ('${PAYER}', true, false, false);
create function public.is_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.is_admin and s.approved and not s.suspended) $$;
grant execute on function public.is_admin() to authenticated;
create table public.watchlist (user_id uuid not null, ticker text not null, push boolean not null default true, primary key (user_id, ticker));
create table public.holdings (user_id uuid not null, ticker text not null, shares numeric not null, primary key (user_id, ticker));
create function public.watchlist_cap() returns trigger language plpgsql as $$ begin return new; end $$;
create function public.holdings_cap() returns trigger language plpgsql as $$ begin return new; end $$;
`;
export const BILLING_SQL = readFileSync(new URL('../../supabase/billing.sql', import.meta.url), 'utf8');
