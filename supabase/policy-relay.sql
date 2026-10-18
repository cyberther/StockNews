-- Fetches the Chamber of Deputies' legislative lists for the policy job (ingest/policy/run.mjs),
-- which runs on GitHub's servers: www.cdep.ro does not answer those, but answers Supabase.
-- The database fetches the page (pg_net) and the job reads it back. Only the two list URLs are
-- accepted, and only the service role may call these functions.
-- Run in the SQL Editor after supabase/policy.sql; needs the pg_net extension (supabase/push.sql).
create or replace function public.policy_fetch_start(p_url text) returns bigint
language plpgsql security definer set search_path = public, extensions as $$
begin
  if p_url !~ '^https://www\.cdep\.ro/ords/pls/proiecte/upl_pck2015\.lista\?an[lp]=[0-9]{4}$' then
    raise exception 'url not allowed';
  end if;
  return net.http_get(url := p_url, timeout_milliseconds := 30000);
end $$;

create or replace function public.policy_fetch_result(p_id bigint)
returns table (status_code integer, timed_out boolean, error_msg text, content text)
language plpgsql security definer set search_path = public as $$
begin
  return query select r.status_code, r.timed_out, r.error_msg, r.content from net._http_response r where r.id = p_id;
end $$;

revoke all on function public.policy_fetch_start(text) from public, anon, authenticated;
revoke all on function public.policy_fetch_result(bigint) from public, anon, authenticated;
grant execute on function public.policy_fetch_start(text) to service_role;
grant execute on function public.policy_fetch_result(bigint) to service_role;
