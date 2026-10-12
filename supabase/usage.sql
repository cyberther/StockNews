-- Market Pulse: shared usage counters for the market data gateway
-- (netlify/functions/_shared/market/). Every function instance adds its upstream calls,
-- rate-limit answers and errors here, so daily provider quotas are respected across
-- instances, and /api/market/health can show today's usage.
--
-- Run this once in the Supabase SQL editor; it is safe to run again. Then store the
-- gateway's secret in Vault (supabase/README.md, "Usage counters"): the same value goes in
-- Netlify as USAGE_SECRET. That secret can only add to and read these counters; Netlify
-- never gets the service-role key.

create table if not exists public.provider_usage (
  provider               text        not null,
  day                    date        not null,
  calls                  integer     not null default 0,
  rate_limited           integer     not null default 0,
  errors                 integer     not null default 0,
  last_rate_limited_at   timestamptz,
  last_error_at          timestamptz,
  updated_at             timestamptz not null default now(),
  primary key (provider, day),
  constraint provider_usage_name check (provider ~ '^[a-z0-9_-]{1,32}$')
);
-- Reached only through the two functions below.
alter table public.provider_usage enable row level security;
alter table public.provider_usage force row level security;
revoke all on public.provider_usage from anon, authenticated;

create or replace function public.market_usage_secret_ok(p_secret text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_secret is not null and length(p_secret) >= 32
     and p_secret = (select decrypted_secret from vault.decrypted_secrets where name = 'usage_secret' limit 1);
$$;
revoke all on function public.market_usage_secret_ok(text) from public, anon, authenticated;

-- p_rows: [{ "provider": "finnhub", "calls": 12, "rate_limited": 0, "errors": 1 }, ...]
create or replace function public.market_usage_bump(p_secret text, p_rows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  r jsonb;
  today date := (now() at time zone 'utc')::date;
  n_calls int; n_limited int; n_errors int;
begin
  if not public.market_usage_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20 then
    raise exception 'bad rows' using errcode = '22023';
  end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    n_calls   := least(greatest(coalesce((r->>'calls')::int, 0), 0), 100000);
    n_limited := least(greatest(coalesce((r->>'rate_limited')::int, 0), 0), 100000);
    n_errors  := least(greatest(coalesce((r->>'errors')::int, 0), 0), 100000);
    insert into public.provider_usage as u (provider, day, calls, rate_limited, errors, last_rate_limited_at, last_error_at)
    values (r->>'provider', today, n_calls, n_limited, n_errors,
            case when n_limited > 0 then now() end, case when n_errors > 0 then now() end)
    on conflict (provider, day) do update set
      calls = u.calls + excluded.calls,
      rate_limited = u.rate_limited + excluded.rate_limited,
      errors = u.errors + excluded.errors,
      last_rate_limited_at = coalesce(excluded.last_rate_limited_at, u.last_rate_limited_at),
      last_error_at = coalesce(excluded.last_error_at, u.last_error_at),
      updated_at = now();
  end loop;
end $$;

create or replace function public.market_usage_read(p_secret text, p_days integer default 7)
returns setof public.provider_usage
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.market_usage_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select * from public.provider_usage
    where day > (now() at time zone 'utc')::date - least(greatest(coalesce(p_days, 7), 1), 90)
    order by day desc, provider;
end $$;

revoke all on function public.market_usage_bump(text, jsonb) from public;
revoke all on function public.market_usage_read(text, integer) from public;
grant execute on function public.market_usage_bump(text, jsonb) to anon, authenticated;
grant execute on function public.market_usage_read(text, integer) to anon, authenticated;

-- Keep four months of history.
select cron.unschedule('market-usage-prune') where exists (select 1 from cron.job where jobname = 'market-usage-prune');
select cron.schedule('market-usage-prune', '23 3 * * *',
  $$delete from public.provider_usage where day < (now() at time zone 'utc')::date - 120$$);
