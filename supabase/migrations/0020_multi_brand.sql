-- supabase/migrations/0020_multi_brand.sql
-- Multi-brand accounts (spec 2026-08-10-multi-brand-design.md §2, §7).
--
-- brand_profiles is primary-keyed on user_id, so an account can hold exactly
-- one brand. In production several brands already share one login, which
-- means loadBrandContext() returns one brand's voice, proof points and colors
-- for every other brand's generations. This reshapes brand_profiles into the
-- brands table in place — no new table, no data copy, no dual-write window.

-- 1. user_id PK -> id PK; user_id demoted to a plain owner FK.
alter table brand_profiles add column id uuid not null default gen_random_uuid();
alter table brand_profiles drop constraint brand_profiles_pkey;
alter table brand_profiles add primary key (id);
alter table brand_profiles add column is_default boolean not null default false;
create index brand_profiles_user_idx on brand_profiles(user_id);

-- The MCP `brand` argument resolves by display name (spec §6), so two brands
-- on one account may not share one.
alter table brand_profiles
  add constraint brand_profiles_user_name_unique unique (user_id, business_name);

-- 2. Every existing row is its account's only brand, by construction.
update brand_profiles set is_default = true;

-- 3. An account owning categories but no brand_profiles row would fail step
--    5's not-null. Give it a placeholder. is_default is set HERE rather than
--    left to step 2, which has already run.
insert into brand_profiles (user_id, business_name, is_default)
select distinct c.user_id, 'My brand', true
from categories c
where not exists (select 1 from brand_profiles b where b.user_id = c.user_id);

-- 4. categories gain a brand owner, nullable until backfilled.
--    on delete cascade matches categories.user_id's existing behaviour. Note
--    that deleting a brand that still has ideas will fail rather than cascade:
--    ideas holds a composite FK into categories(user_id, key) with no cascade
--    (0005), which is a deliberate safety net. There is no delete-brand UI in
--    this project.
alter table categories add column brand_id uuid references brand_profiles(id) on delete cascade;

-- 5. Backfill from each account's single brand.
update categories c
set brand_id = b.id
from brand_profiles b
where b.user_id = c.user_id and b.is_default;

-- Post-condition (spec §7), asserted before the not-null so the failure
-- names the actual problem instead of surfacing as a constraint violation.
do $$
declare bad int;
begin
  select count(*) into bad from categories where brand_id is null;
  if bad > 0 then
    raise exception 'multi-brand backfill: % categories still have a null brand_id', bad;
  end if;

  select count(*) into bad from (
    select user_id from brand_profiles
    group by user_id
    having count(*) filter (where is_default) <> 1
  ) t;
  if bad > 0 then
    raise exception 'multi-brand backfill: % accounts lack exactly one default brand', bad;
  end if;
end $$;

alter table categories alter column brand_id set not null;
create index categories_brand_idx on categories(brand_id);
