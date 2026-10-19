-- The ingestion's clock. GitHub did not start the workflows' own schedules (2026-10-19: none
-- ran, not even as skipped), so pg_cron here starts them through GitHub's API at the same UTC
-- times: intraday every 15 minutes on weekdays, eod after New York's close, the morning
-- health check. The workflows themselves are unchanged and still run on GitHub's runners.
--
-- Needs, in the vault, a fine-grained GitHub token for this repository only, with
-- "Actions: Read and write" (name 'github_dispatch_token'); it never leaves the database
-- except as the Authorization header to api.github.com. Run once in the SQL Editor; safe to
-- run again. Each call's answer is in net._http_response (204 = started).
create or replace function public.ingest_dispatch(p_workflow text, p_job text default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare tok text;
begin
  if p_workflow is null or p_workflow not in ('ingest.yml', 'health.yml') then raise exception 'unknown workflow'; end if;
  if p_workflow = 'ingest.yml' and coalesce(p_job, '') not in ('intraday', 'eod') then raise exception 'unknown job'; end if;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if tok is null or length(tok) < 20 then raise exception 'github_dispatch_token is not set in the vault'; end if;
  return net.http_post(
    url := 'https://api.github.com/repos/cyberther/StockNews/actions/workflows/' || p_workflow || '/dispatches',
    headers := jsonb_build_object('authorization', 'Bearer ' || tok, 'accept', 'application/vnd.github+json',
      'x-github-api-version', '2022-11-28', 'user-agent', 'market-pulse-cron', 'content-type', 'application/json'),
    body := jsonb_build_object('ref', 'main') || case when p_job is null then '{}'::jsonb else jsonb_build_object('inputs', jsonb_build_object('job', p_job)) end,
    timeout_milliseconds := 15000);
end $$;
revoke all on function public.ingest_dispatch(text, text) from public, anon, authenticated;
grant execute on function public.ingest_dispatch(text, text) to service_role;

-- UTC, as the workflows' cron lines were (and ingest/health.mjs CRON expects).
select cron.schedule('ingest-intraday', '7,22,37,52 7-21 * * 1-5', $$select public.ingest_dispatch('ingest.yml', 'intraday')$$);
select cron.schedule('ingest-eod', '40 21 * * 1-5', $$select public.ingest_dispatch('ingest.yml', 'eod')$$);
select cron.schedule('ingest-health', '15 6 * * *', $$select public.ingest_dispatch('health.yml')$$);
