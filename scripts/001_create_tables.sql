-- Create profiles table
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamp with time zone default now()
);

-- Create rooms table
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid references auth.users(id) on delete cascade,
  created_at timestamp with time zone default now()
);

-- Create room_participants table
create table if not exists public.room_participants (
  room_id uuid references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  joined_at timestamp with time zone default now(),
  is_speaking boolean default false,
  is_muted boolean default false,
  is_deafened boolean default false,
  primary key (room_id, user_id)
);

-- Enable Row Level Security
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_participants enable row level security;

-- Profiles policies
create policy "profiles_select_all"
  on public.profiles for select
  using (true);

create policy "profiles_insert_own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id);

-- Rooms policies
create policy "rooms_select_all"
  on public.rooms for select
  using (true);

create policy "rooms_insert_authenticated"
  on public.rooms for insert
  with check (auth.uid() = created_by);

create policy "rooms_update_own"
  on public.rooms for update
  using (auth.uid() = created_by);

create policy "rooms_delete_own"
  on public.rooms for delete
  using (auth.uid() = created_by);

-- Room participants policies
create policy "room_participants_select_all"
  on public.room_participants for select
  using (true);

create policy "room_participants_insert_own"
  on public.room_participants for insert
  with check (auth.uid() = user_id);

create policy "room_participants_update_own"
  on public.room_participants for update
  using (auth.uid() = user_id);

create policy "room_participants_delete_own"
  on public.room_participants for delete
  using (auth.uid() = user_id);
