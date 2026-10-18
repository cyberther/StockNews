// A real Postgres (PGlite) with the parts of Supabase the SQL files rely on: the anon /
// authenticated / service_role roles with Supabase's default grants, auth.uid() from the
// request's JWT, public.is_approved() as in supabase/approval.sql, and public.stories.
import { PGlite } from '@electric-sql/pglite';

export const APPROVED = '00000000-0000-0000-0000-000000000001';
export const WAITING = '00000000-0000-0000-0000-000000000002';

export const STUB = `
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
create table public.account_status (user_id uuid primary key, approved boolean not null default false, suspended boolean not null default false);
insert into public.account_status values ('${APPROVED}', true, false), ('${WAITING}', false, false);
create function public.is_approved() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.account_status s where s.user_id = auth.uid() and s.approved and not s.suspended) $$;
revoke all on function public.is_approved() from public, anon;
grant execute on function public.is_approved() to authenticated;
create table public.stories (id text primary key, ticker text not null, headline text not null, source text, url text, summary text,
  published_at timestamptz not null, found_at timestamptz not null default now());
`;

export async function supabaseDb(...sqlFiles) {
  const db = new PGlite();
  await db.exec(STUB);
  for (const sql of sqlFiles) await db.exec(sql);
  return db;
}

// Runs a query as a role (and JWT subject), then switches back.
export async function as(db, role, sub, sql) {
  await db.exec(`set role ${role}; select set_config('request.jwt.claim.sub', '${sub || ''}', false);`);
  try { return await db.query(sql); } finally { await db.exec('reset role'); }
}
