-- Market Pulse: the user's positions (the holdings table on the Watchlist screen).
--
-- Run this once in the Supabase SQL editor (Dashboard → SQL Editor → New query). It is
-- safe to run again. The apps keep working without it; positions then stay on the device.

-- One row per (user, ticker): how many shares and the average price paid, in the
-- listing's own currency. Prices, P/L and weights are worked out in the app from live quotes.
create table if not exists public.holdings (
  user_id     uuid        not null references auth.users on delete cascade,
  ticker      text        not null,
  shares      numeric     not null,
  avg_price   numeric,
  updated_at  timestamptz not null default now(),
  primary key (user_id, ticker),
  constraint holdings_ticker check (ticker ~ '^[A-Z0-9][A-Z0-9.\-]{0,11}$'),
  constraint holdings_shares check (shares > 0 and shares < 1e12),
  constraint holdings_avg_price check (avg_price is null or (avg_price >= 0 and avg_price < 1e9))
);
alter table public.holdings enable row level security;
alter table public.holdings force row level security;
revoke all on public.holdings from anon;
grant select, insert, update, delete on public.holdings to authenticated;

drop policy if exists "read own holdings"   on public.holdings;
drop policy if exists "add own holdings"    on public.holdings;
drop policy if exists "edit own holdings"   on public.holdings;
drop policy if exists "remove own holdings" on public.holdings;
create policy "read own holdings"   on public.holdings for select to authenticated using (user_id = auth.uid());
create policy "add own holdings"    on public.holdings for insert to authenticated with check (user_id = auth.uid());
create policy "edit own holdings"   on public.holdings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "remove own holdings" on public.holdings for delete to authenticated using (user_id = auth.uid());

create or replace function public.holdings_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists holdings_touch on public.holdings;
create trigger holdings_touch before update on public.holdings for each row execute function public.holdings_touch();

-- Same limit as the watchlist.
create or replace function public.holdings_cap() returns trigger language plpgsql as $$
begin
  if (select count(*) from public.holdings where user_id = new.user_id) >= 100 then
    raise exception 'holdings are limited to 100 positions';
  end if;
  return new;
end $$;
drop trigger if exists holdings_cap on public.holdings;
create trigger holdings_cap before insert on public.holdings for each row execute function public.holdings_cap();
