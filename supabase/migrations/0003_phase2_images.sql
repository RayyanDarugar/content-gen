-- Phase 2: image generation support.

alter table generations add column refinement_notes text not null default '';

-- Public bucket for generated images. Public read is intentional (Buffer needs
-- fetchable URLs in Phase 3); writes go through the service-role client only.
insert into storage.buckets (id, name, public)
values ('images', 'images', true)
on conflict (id) do nothing;

-- Live gallery updates.
alter publication supabase_realtime add table generations;
