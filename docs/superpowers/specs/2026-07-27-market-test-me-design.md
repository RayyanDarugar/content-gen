# Market Test Me — Design Spec

**Date:** 2026-07-27
**Status:** Design approved in brainstorming; Phase 0 is the only phase being committed to. Everything past Phase 0 is conditional on its outcome.
**Lives in:** a **separate app** (new repo, new Supabase project, new Vercel project), cloned from content-gen-app's infrastructure. This spec is stored in the content-gen-app repo only because that's where design docs live today.

## North Star

An internal super{set} tool that gives a portfolio company a real market read on a positioning, campaign, or business idea — before committing real spend — by having it organically tested by credible, ICP-specific persona accounts on social media, driving to a trackable waitlist. It answers four questions:

1. Is this positioning worth pursuing at all?
2. Which ICP reacts most strongly?
3. Which channel reacts most strongly?
4. Which message framing lands best?

Internal to super{set} first. Not a sellable product unless proven inside the portfolio.

## The Core Hypothesis (unproven — Phase 0 exists to test it)

**That an agentic tool running market tests through social channels produces a decision-grade market read faster, cheaper, and more credibly than what a founder would otherwise do** — manual validation (DIY posting, cold outreach, informal focus groups) or, most commonly, nothing at all. The baseline Market Test Me competes against is *manual testing / no testing*, not one distribution channel versus another.

Persona accounts and paid ads are both **instruments** of the same tool, not competitors. They yield different kinds of signal — paid gives fast, targeted, quantitative conversion data with zero platform risk; personas give organic-reception data and unprompted qualitative reactions (comments, objections, shares) that ads structurally can't. A mature version of the tool likely runs both per test. Phase 0 runs both not to pick a winner but to learn what each instrument actually contributes to the market read — which determines where build investment goes next.

The persona instrument carries costs the paid one doesn't (weeks of warmup, platform ban risk, reputational/disclosure risk to super{set}), so its *contribution* has to justify those costs — but that's a portfolio-allocation question inside the tool, not an existential either/or.

## Phase 0 — Validation Pilot (the only committed scope)

Run **one real test for one product/positioning** using both instruments, sharing the same message, landing page, and attribution pipeline:

**Instrument A — personas:**
- **2 ICPs:** developers, enterprise marketers.
- **1 persona account per ICP** (2 accounts total).
- **1 channel: X.**
- ~2 weeks of warmup per account (100% organic, ICP-relevant, non-promotional content) before any test content.
- During the campaign window: test posts folded in among continued organic posts, each linking to the waitlist with unique per-post UTMs.

**Instrument B — paid (manual, zero build):**
- A matched ad campaign created by hand in X's native ad manager — same channel, same message, same landing page — targeted at the same two ICPs via platform targeting.
- Tagged `utm_medium=paid` vs Instrument A's `utm_medium=organic-persona`. Same landing page captures both — no extra code.
- Manual in Phase 0 only because building ad-API automation before validating the tool would be premature — paid is expected to be an automated instrument later if the tool proves out.

**What Phase 0 must prove (the tool-level question):**
- The full loop works end to end: define a test → generate content → distribute through social channels → capture intent → produce a report a founder actually uses to make a decision.
- That read is worth more than what the founder would have gotten manually in the same two weeks — measured honestly by asking the test-subject founder: *did this change or confirm a decision, and would you have gotten there yourself?*

**What Phase 0 additionally teaches (the instrument-level question):**
- What each instrument contributes: does the persona arm's qualitative signal (comments, objections, organic shares) add decision value beyond the paid arm's conversion numbers? The answer sets post-Phase-0 build priorities — how much to invest in scaling the persona network vs. automating paid — it is not a kill-gate for either instrument.

If the tool-level question fails — the loop produces a report nobody acts on, or manual testing would clearly have done as well — stop and rethink the product, regardless of which instrument performed better.

## What Gets Built for Phase 0

Deliberately minimal — most of Phase 0 is operational (running accounts), not software.

1. **Persona definitions** — voice, backstory, ICP, cadence — authored as brand-profile-style records so the existing content-generation pattern can write in-voice posts. (Persona-as-template is the reusable IP; accounts are instances.)
2. **Content generation** — reuse content-gen-app's Claude + Kie pipeline pattern to produce both warmup content and test-post variants per persona. **Test content gets a mandatory human review gate** — nothing posts under a persona's identity unattended. (This deliberately inverts content-gen-app's publish-by-default philosophy: posting as a proxied identity is higher-stakes than posting as yourself.)
3. **Posting** — via Buffer (personal-key pattern already proven), scheduled so test posts are spread through the window, never front-loaded, and remain a minority of each account's feed.
4. **Waitlist landing page + attribution** — one page per test campaign; captures `utm_source` (platform), `utm_campaign` (test), `utm_content` (persona + post ID), `utm_medium` (organic-persona | paid) on **both pageview and signup**, so clicks-that-didn't-convert are visible. X's t.co and LinkedIn's wrapper both preserve query strings, so UTMs survive.
5. **Report** — for Phase 0 a simple comparison is enough (even hand-assembled from the attribution table + platform analytics): ICP × arm × post, showing engagement, clicks, signups. Signups are the intent signal; engagement is secondary and never conflated with it.

## Architecture (Phase 0 and beyond)

- **Separate app, cloned from content-gen-app.** Fork the repo; keep the multi-tenant auth pattern, the AES-256-GCM secrets module (`lib/crypto/secrets.ts`), the `getValidBufferToken()` boundary, and the generation-calling pattern. Strip the brand/format/series domain and UI. New Supabase project, new Vercel project.
- **Why not inside content-gen-app:** (1) the domain (personas, reservations, campaigns, attribution) is genuinely different from brand/format/series — bolting it on recreates the god-object problem that app just escaped; (2) risk isolation — content-gen-app is heading toward being a real product; ToS-adjacent persona machinery should not share its codebase or database.
- **Tenancy:** multi-tenant from the start (portfolio companies as orgs). Persona/account pool is shared infrastructure owned by super{set}; campaigns and their results are org-scoped.

## Post–Phase 0 Design (recorded, not committed)

These decisions were made during brainstorming and hold **if** Phase 0 validates the tool-level hypothesis; instrument-level results tune how much of this gets built and when:

- **Persona pool:** 3 account instances per ICP. Personas are reusable templates (the IP); the 3-account spread enables A/B of framings within one ICP and averages out single-account audience quirks.
- **Lifecycle:** warmup (~2 weeks, organic only) → reservable pool → steady state (mostly organic content, capped share of test content during reserved windows) → mandatory cooldown before a different org can reserve the same account. Cooldown + feed-share caps are what keep an account from reading as a serial pitchman — which would contaminate the signal for everyone.
- **Reservations:** a booking system. `personas` + `reservations` (persona_id, org_id, campaign_id, tstzrange window, status) with a Postgres `EXCLUDE USING gist` constraint making double-booking structurally impossible. The reservation window gates the posting scheduler. Contention policy (FCFS vs. operator arbitration) is policy, not schema — decide later.
- **Channels:** add LinkedIn second (text-first, same pipeline). Instagram is possible — the content engine already handles image/carousel production — but deprioritized while video generation is out of scope, since IG's algorithm under-distributes non-video content and accounts would grow slowly. Revisit when Kie-based video gen matures.
- **Paid ads as an automated instrument:** deferred, but expected. The build is per-platform ad API integrations, a spend-control layer (BYO ad accounts or centrally funded with caps + approval), ICP→targeting-spec translation per platform, and campaign pacing/monitoring. It shares the content engine and attribution layer with the persona instrument; how much to invest in it vs. scaling the persona network is set by what Phase 0 shows each instrument contributing.
- **Reporting at scale:** ICP × channel × persona × message-variant matrix; engagement rate + conversion rate per cell; persona maturity (follower count, account age) surfaced as context so a young account's weak numbers aren't misread as weak positioning.

## Risks (acknowledged, not resolved)

- **Platform detection:** multiple accounts operated from one shop with correlated posting patterns is what coordinated-inauthentic-behavior systems look for. Phase 0's 2-account scale keeps the blast radius small; a ban costs one account's warmup, not a network.
- **Disclosure/reputation:** proxied accounts presenting product mentions as organic discovery sits close to undisclosed-endorsement territory. The tail risk is reputational — "super{set}-backed startups run astroturf accounts" — and it lands on super{set}, not one portfolio company. This risk attaches only to the persona instrument, which is why its qualitative contribution (measured in Phase 0) has to justify carrying it — if paid + other honest instruments deliver most of the decision value, the persona network can stay small or be dropped without killing the tool.
- **Signal validity:** small follower counts in Phase 0 mean small absolute numbers; the comparison against the paid arm (same window, same message) is what makes them interpretable.

## Open Questions

1. Who operates the persona accounts day-to-day during Phase 0 (approving content, replying to comments)? Replies are part of credibility — an account that never responds reads as a bot.
2. What product/positioning is the Phase 0 test subject? (Needs a willing portfolio company — or a super{set} internal idea — with a real waitlist-worthy pitch.)
3. Contention policy for reservations (FCFS vs. operator-arbitrated) — only matters post-Phase 0.
