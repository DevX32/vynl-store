-- Relay setup for the Listen Along plugin.
--
-- Run this once in the Supabase SQL editor for the relay project. The project
-- needs no tables and no RPC functions: session membership lives in the WebRTC
-- connection itself, so Storage is the only thing to provision.
--
-- Nothing here is secret and nothing is app-specific. The anon key that ships
-- in the plugin is a public credential by design, so the security of shared
-- audio rests entirely on these policies: the bucket stays private and every
-- access path is scoped to bucket_id = 'listen-along'.

-- ---------------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------------

-- Private, because the plugin signs a short-lived URL per playback rather than
-- serving objects publicly. Capped at 200 MB so a large FLAC still uploads while
-- the bucket cannot be filled without bound by the anon role.
insert into storage.buckets (id, name, public, file_size_limit)
values ('listen-along', 'listen-along', false, 209715200)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------

-- Dropped first so this script is safe to re-run.
drop policy if exists "listen_along_insert" on storage.objects;
drop policy if exists "listen_along_update" on storage.objects;
drop policy if exists "listen_along_select" on storage.objects;
drop policy if exists "listen_along_delete" on storage.objects;

-- Upload. The plugin only stages a track after a joiner asks for it, so a
-- session with no listeners uploads nothing.
create policy "listen_along_insert" on storage.objects
  for insert to anon
  with check (bucket_id = 'listen-along');

-- The upload uses x-upsert, so re-staging an object needs UPDATE as well as
-- INSERT. Content-addressed keys mean this is the common case on a repeat
-- track rather than a rare one.
create policy "listen_along_update" on storage.objects
  for update to anon
  using (bucket_id = 'listen-along')
  with check (bucket_id = 'listen-along');

-- Signing a playback URL resolves through SELECT.
create policy "listen_along_select" on storage.objects
  for select to anon
  using (bucket_id = 'listen-along');

-- Deleting a session's staged audio.
create policy "listen_along_delete" on storage.objects
  for delete to anon
  using (bucket_id = 'listen-along');

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
--
-- Nothing to run. Signaling rides the standard Phoenix channel protocol over
-- the public Realtime endpoint, which the anon role may join.
--
-- Leave Realtime's private-channel authorization OFF. Turning it on requires a
-- signed JWT and matching RLS policies on realtime.messages, which would break
-- anonymous signaling — the plugin has no way to obtain a user token.
