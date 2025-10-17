-- Fix FK so PostgREST can embed profiles from room_participants
begin;

-- Drop old FK that points to auth.users (if it exists)
alter table public.room_participants
  drop constraint if exists room_participants_user_id_fkey;

-- Add FK pointing to public.profiles(id)
alter table public.room_participants
  add constraint room_participants_user_id_fkey
  foreign key (user_id) references public.profiles(id) on delete cascade;

commit;

-- Optional backfill: ensure every auth.users has a profile
-- Run separately if you still see missing profiles
-- insert into public.profiles (id, display_name)
-- select u.id, split_part(u.email, '@', 1)
-- from auth.users u
-- where not exists (
--   select 1 from public.profiles p where p.id = u.id
-- );