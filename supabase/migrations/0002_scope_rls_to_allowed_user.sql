-- Scope RLS policies to the single allowed user, not any authenticated session.
-- The email is hardcoded as a literal to match this app's ALLOWED_EMAIL env var
-- (Postgres RLS policies cannot read Next.js env vars, and this single-user app's
-- identity model is already a fixed single email, not a dynamic list).

drop policy "auth full access" on categories;
create policy "allowed user only" on categories
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu')
  with check ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu');

drop policy "auth full access" on ideas;
create policy "allowed user only" on ideas
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu')
  with check ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu');

drop policy "auth full access" on generations;
create policy "allowed user only" on generations
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu')
  with check ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu');

drop policy "auth full access" on posts;
create policy "allowed user only" on posts
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu')
  with check ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu');

drop policy "auth full access" on post_images;
create policy "allowed user only" on post_images
  for all to authenticated
  using ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu')
  with check ((auth.jwt() ->> 'email') = 'rdarugar@usc.edu');
