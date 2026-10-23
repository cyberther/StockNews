-- Market Pulse: the public methodology and accuracy page (templates/stock-news-web/methodology.html,
-- at /metodologie). One function anyone can call, signed in or not, that returns counts and
-- the record of where the analyses were wrong: how many official events and documents were
-- read, how many analyses and fact sheets exist, every analysis withdrawn with its reason,
-- and every estimate compared with what the company reported later (direction and relative
-- error, not the frozen lei figures, which stay in Pro).
--
-- Run once in the SQL Editor, after impact.sql and policy-auto.sql; safe to run again.

create or replace function public.public_transparency() returns jsonb
language sql stable security definer set search_path = public as $$
  with acc as (
    select a.analysis_id, a.version, a.subject, a.period, a.direction, a.rel_error, a.source_url, x.title, x.published_at
    from analysis_accuracy a
    join impact_analyses x on x.id = a.analysis_id and x.version = a.version
    where a.scenario = 'full'
  )
  select jsonb_build_object(
    'updated_at', now(),
    'events', (select count(*) from policy_events),
    'documents', (select count(*) from policy_documents where status = 'ok'),
    'unreadable', (select count(*) from policy_documents where status = 'unreadable'),
    'sheets', (select count(*) from fact_sheets),
    'analyses', (select count(*) from (select distinct id from impact_analyses where withdrawn_at is null) a),
    'analyses_auto', (select count(*) from (select distinct id from impact_analyses where withdrawn_at is null and origin = 'auto') a),
    'withdrawn', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'version', version,
        'published', published_at, 'withdrawn', withdrawn_at::date, 'reason', withdrawn_reason) order by withdrawn_at desc)
      from (select * from impact_analyses where withdrawn_at is not null order by withdrawn_at desc limit 50) w), '[]'::jsonb),
    'compared', (select count(*) from acc),
    'direction_ok', (select count(*) from acc where direction),
    'median_abs_error', (select round(percentile_cont(0.5) within group (order by abs(rel_error))::numeric, 4) from acc where rel_error is not null),
    'comparisons', coalesce((select jsonb_agg(jsonb_build_object('title', title, 'subject', subject, 'period', period,
        'direction', direction, 'rel_error', round(rel_error, 4), 'source_url', source_url) order by published_at desc, subject)
      from (select * from acc order by published_at desc limit 50) c), '[]'::jsonb)
  );
$$;
revoke all on function public.public_transparency() from public;
grant execute on function public.public_transparency() to anon, authenticated;
