-- Post Menu phase 3 (spec 2026-07-29-multi-channel-posting-design.md).
-- One submission fans out to N channels as N posts rows sharing the
-- post_group_id added in 0012. These two columns let history explain each
-- row on its own terms.

-- The base copy this channel's text was adapted from. Empty when the
-- channel posted the base copy unchanged.
alter table posts add column adapted_from_caption text not null default '';

-- The channel's service snapshotted at post time, so history renders the
-- right platform icon even after a category is re-pointed at another
-- channel (categories.buffer_channel_service is the CURRENT default, not
-- what this post actually went out on).
alter table posts add column buffer_channel_service text not null default '';
