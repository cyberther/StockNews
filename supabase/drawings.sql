-- Market Pulse: each account's drawings on a ticker's chart (support and resistance lines,
-- trend lines, zones, Fibonacci), from the ticker page's "Chart analysis" tab.
-- [{ id, type: 'hline'|'trend'|'zone'|'fib', a: { t, p }, b: { t, p } }]: real times
-- (Unix seconds) and prices, so a drawing stays put whatever the bar size.
-- Run once in the Supabase SQL editor, after approval.sql (it uses is_approved); safe to run again.
create table if not exists public.chart_drawings (
  user_id    uuid        not null references auth.users on delete cascade,
  ticker     text        not null,
  drawings   jsonb       not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, ticker),
  constraint chart_drawings_ticker check (ticker ~ '^[A-Z0-9][A-Z0-9.\-]{0,14}$'),
  constraint chart_drawings_list check (jsonb_typeof(drawings) = 'array' and jsonb_array_length(drawings) <= 100),
  constraint chart_drawings_size check (pg_column_size(drawings) < 32768)
);
alter table public.chart_drawings enable row level security;
alter table public.chart_drawings force row level security;
revoke all on public.chart_drawings from anon;
grant select, insert, update, delete on public.chart_drawings to authenticated;
drop policy if exists "read own drawings" on public.chart_drawings;
create policy "read own drawings" on public.chart_drawings for select to authenticated using (user_id = auth.uid() and public.is_approved());
drop policy if exists "add own drawings" on public.chart_drawings;
create policy "add own drawings" on public.chart_drawings for insert to authenticated with check (user_id = auth.uid() and public.is_approved());
drop policy if exists "edit own drawings" on public.chart_drawings;
create policy "edit own drawings" on public.chart_drawings for update to authenticated using (user_id = auth.uid() and public.is_approved()) with check (user_id = auth.uid());
drop policy if exists "remove own drawings" on public.chart_drawings;
create policy "remove own drawings" on public.chart_drawings for delete to authenticated using (user_id = auth.uid());
