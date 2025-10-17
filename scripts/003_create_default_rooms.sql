-- Create some default rooms for testing
insert into public.rooms (name, created_by)
select 'Sala Geral', id from auth.users limit 1
on conflict do nothing;

insert into public.rooms (name, created_by)
select 'Sala de Jogos', id from auth.users limit 1
on conflict do nothing;

insert into public.rooms (name, created_by)
select 'Sala de Música', id from auth.users limit 1
on conflict do nothing;
