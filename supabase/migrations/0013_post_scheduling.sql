-- supabase/migrations/0013_post_scheduling.sql
-- Post Menu phase 2 (spec 2026-07-28-post-composer-design.md).
-- A post either rides Buffer's own queue (scheduled_at null, the default)
-- or carries a custom time the user picked in the composer.
alter table posts add column scheduled_at timestamptz;

-- Phase 1 punch-list: connection labels drive the channel picker's
-- optgroups, so duplicates are ambiguous, and any future join on label
-- would fan out. Dedupe first — the constraint would otherwise fail on
-- existing data. The suffix search skips labels the user already has, so
-- a pre-existing "Foo (2)" can't collide with a renamed duplicate.
do $$
declare
  r record;
  candidate text;
  i int;
begin
  for r in (
    select id, user_id, label
    from buffer_connections bc
    where exists (
      select 1 from buffer_connections o
      where o.user_id = bc.user_id and o.label = bc.label and o.id < bc.id
    )
    order by user_id, label, id
  ) loop
    i := 2;
    loop
      candidate := r.label || ' (' || i || ')';
      exit when not exists (
        select 1 from buffer_connections x
        where x.user_id = r.user_id and x.label = candidate
      );
      i := i + 1;
    end loop;
    update buffer_connections set label = candidate where id = r.id;
  end loop;
end $$;

alter table buffer_connections
  add constraint buffer_connections_user_label_unique unique (user_id, label);

-- Phase 1 punch-list: every other timestamped table has this trigger
-- (see 0001_init.sql); without it updated_at freezes on future edits.
create trigger buffer_connections_updated_at before update on buffer_connections
  for each row execute function set_updated_at();
