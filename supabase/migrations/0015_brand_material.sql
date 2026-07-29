-- Brand depth (spec 2026-07-29-brand-extraction-onboarding-design.md).
-- The model already gets tone and audience but no MATERIAL, which is why
-- generic output is the failure mode. These two arrays are the material.

-- Concrete claims the brand can point at, each a short string —
-- e.g. "5,000 students raised scores 120+ points".
alter table brand_profiles add column proof_points jsonb not null default '[]'::jsonb;

-- Topics the brand has authority to speak on. Generation declines angles
-- outside this when it is non-empty.
alter table brand_profiles add column standing jsonb not null default '[]'::jsonb;
