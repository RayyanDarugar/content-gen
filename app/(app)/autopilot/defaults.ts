// What a freshly turned-on workflow gets. Shared by the per-row toggle and
// the "turn on for every category" button so the two can never disagree about
// what "on" means.
//
// The timezone is resolved in the browser, which is why this is called from a
// client component rather than baked in on the server: the rate is a
// preference, but the zone is a fact about the human reading the page.
//
// Not typed as WorkflowSettings on purpose — that type lives in a
// "server-only" module, and this one is bundled for the client. The literal is
// structurally identical, and the server action's own signature type-checks
// every call site.
export function defaultWorkflowSettings() {
  return {
    postsPerPeriod: 1,
    period: "day" as const,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    maxAttemptsPerPeriod: 3,
    autoPauseAfterFailedPeriods: 3,
  };
}
