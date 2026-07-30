// Server-side confirmation gate for Tier 2 MCP tools — any tool that is
// irreversible in-app or spends real money/credit or reaches a live external
// account must call this BEFORE any database write or external API call.
// `confirm` is intentionally optional on the input schema (so the model sees
// the field and can choose to omit it on a first, exploratory call) but this
// function treats anything other than a literal `true` as "not confirmed".
export function assertConfirmed(input: { confirm?: boolean }, summary: string): void {
  if (input.confirm !== true) {
    throw new Error(
      `Not confirmed: this would ${summary}. Show the user exactly what will happen and get their explicit ` +
        `go-ahead, then call this tool again with confirm: true.`,
    );
  }
}
