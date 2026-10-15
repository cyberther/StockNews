-- Market Pulse: the US symbols the live chart relay listens to all the time
-- (tools/live-relay.mjs, on the PC): those on anyone's watchlist or in anyone's holdings,
-- most followed first. Run once in the Supabase SQL editor; safe to run again.
create or replace function public.relay_symbols(p_secret text)
returns table (ticker text, followers bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.summary_secret_ok(p_secret) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return query
    select x.t, count(distinct x.u) from (
      select w.ticker t, w.user_id u from public.watchlist w
      union all select h.ticker, h.user_id from public.holdings h) x
    where x.t ~ '^[A-Z][A-Z0-9]{0,5}(\.[A-Z])?$'
    group by x.t
    order by count(distinct x.u) desc, x.t
    limit 40;
end $$;
revoke all on function public.relay_symbols(text) from public;
grant execute on function public.relay_symbols(text) to anon, authenticated;
