-- Mnemo : synchronisation. À exécuter une seule fois dans SQL Editor.
create sequence if not exists public.mnemo_seq;

create table if not exists public.mnemo_items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at bigint not null default 0,
  srv_seq bigint not null default nextval('public.mnemo_seq'),
  primary key (user_id, kind, id)
);
create index if not exists mnemo_items_user_seq on public.mnemo_items (user_id, srv_seq);

alter table public.mnemo_items enable row level security;
drop policy if exists "mnemo_own_rows" on public.mnemo_items;
create policy "mnemo_own_rows" on public.mnemo_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- La version la plus récente gagne ; chaque changement reçoit un nouveau numéro
create or replace function public.mnemo_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.srv_seq := nextval('public.mnemo_seq');
  return new;
end $$;
drop trigger if exists mnemo_touch on public.mnemo_items;
create trigger mnemo_touch before insert or update on public.mnemo_items
  for each row execute function public.mnemo_touch();

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.mnemo_items to authenticated;
grant usage, select on sequence public.mnemo_seq to authenticated;

-- Images et sons
insert into storage.buckets (id, name, public) values ('mnemo-media', 'mnemo-media', false)
  on conflict (id) do nothing;
drop policy if exists "mnemo_media_select" on storage.objects;
drop policy if exists "mnemo_media_insert" on storage.objects;
drop policy if exists "mnemo_media_update" on storage.objects;
drop policy if exists "mnemo_media_delete" on storage.objects;
create policy "mnemo_media_select" on storage.objects for select to authenticated
  using (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mnemo_media_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mnemo_media_update" on storage.objects for update to authenticated
  using (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mnemo_media_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
