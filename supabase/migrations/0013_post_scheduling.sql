-- supabase/migrations/0013_post_scheduling.sql
-- Post Menu phase 2 (spec 2026-07-28-post-composer-design.md).
-- A post either rides Buffer's own queue (scheduled_at null, the default)
-- or carries a custom time the user picked in the composer.
alter table posts add column scheduled_at timestamptz;

-- Phase 1 punch-list: connection labels drive the channel picker's
-- optgroups, so duplicates are ambiguous, and any future join on label
-- would fan out. Dedupe first — the constraint would otherwise fail on
-- existing data.
with numbered as (
  select id, row_number() over (partition by user_id, label order by created_at, id) as n
  from buffer_connections
)
update buffer_connections bc
set label = bc.label || ' (' || numbered.n || ')'
from numbered
where numbered.id = bc.id and numbered.n > 1;

alter table buffer_connections
  add constraint buffer_connections_user_label_unique unique (user_id, label);

-- Phase 1 punch-list: every other timestamped table has this trigger
-- (see 0001_init.sql); without it updated_at freezes on future edits.
create trigger buffer_connections_updated_at before update on buffer_connections
  for each row execute function set_updated_at();
