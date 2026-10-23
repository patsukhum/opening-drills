-- Opening Drills: sync by short code.
-- Run once in the Supabase SQL editor. Adds one table and two functions; touches nothing else.
-- The table is locked (RLS on, no policies); the app can only read/write a row whose code it knows.

create table if not exists public.drill_sync (
  code text primary key check (code ~ '^[A-Z0-9]{5}$'),
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.drill_sync enable row level security;
revoke all on table public.drill_sync from anon, authenticated;

create or replace function public.drill_get(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  s jsonb;
begin
  select state into s from drill_sync where code = upper(p_code);
  if s is null then
    perform pg_sleep(0.5); -- slows down anyone guessing codes
  end if;
  return s;
end;
$$;

create or replace function public.drill_put(p_code text, p_state jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if upper(p_code) !~ '^[A-Z0-9]{5}$' then
    raise exception 'bad code';
  end if;
  if pg_column_size(p_state) > 4000000 then
    raise exception 'too large';
  end if;
  insert into drill_sync (code, state, updated_at)
  values (upper(p_code), p_state, now())
  on conflict (code) do update set state = excluded.state, updated_at = now();
end;
$$;

revoke all on function public.drill_get(text) from public;
revoke all on function public.drill_put(text, jsonb) from public;
grant execute on function public.drill_get(text) to anon;
grant execute on function public.drill_put(text, jsonb) to anon;
