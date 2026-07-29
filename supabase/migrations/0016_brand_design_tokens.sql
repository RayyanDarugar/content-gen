-- Design identity scraped from the brand's own site. Until now the only
-- visual signal reaching a post was categories.style_ref_url — an image —
-- so every drafted style_guide described a look in generic prose.

-- Hex strings, most prominent first.
alter table brand_profiles add column colors jsonb not null default '[]'::jsonb;

-- Font family names.
alter table brand_profiles add column fonts jsonb not null default '[]'::jsonb;

-- Anything else worth carrying: imagery style, logo treatment.
alter table brand_profiles add column visual_notes text not null default '';
