-- Run this entire file once in the Supabase SQL Editor.
-- Each authenticated account receives exactly one private Steady state.

create table if not exists public.habit_tracker_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.habit_tracker_states enable row level security;

revoke all on table public.habit_tracker_states from anon;
grant select, insert, update, delete on table public.habit_tracker_states to authenticated;

drop policy if exists "Users can read their own tracker" on public.habit_tracker_states;
create policy "Users can read their own tracker"
on public.habit_tracker_states for select
to authenticated
using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own tracker" on public.habit_tracker_states;
create policy "Users can create their own tracker"
on public.habit_tracker_states for insert
to authenticated
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own tracker" on public.habit_tracker_states;
create policy "Users can update their own tracker"
on public.habit_tracker_states for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own tracker" on public.habit_tracker_states;
create policy "Users can delete their own tracker"
on public.habit_tracker_states for delete
to authenticated
using ((select auth.uid()) = user_id);

create index if not exists habit_tracker_states_updated_at_idx
on public.habit_tracker_states (updated_at desc);
