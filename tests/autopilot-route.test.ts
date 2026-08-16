import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.hoisted, because the vi.mock factory below is itself hoisted above this
// file's top-level consts and would otherwise read the binding in its TDZ —
// the same reason tests/autopilot-tick.test.ts uses it.
const runAutopilotTick = vi.hoisted(() =>
  vi.fn(async () => ({
    workflowsExamined: 0, runsOpened: 0, runsAdvanced: 0, errors: [] as string[],
  })),
);
vi.mock("@/lib/autopilot/tick", () => ({ runAutopilotTick }));

import { GET } from "@/app/api/jobs/autopilot/route";

function request(auth?: string): Request {
  return new Request("https://example.com/api/jobs/autopilot", {
    headers: auth ? { authorization: auth } : {},
  });
}

describe("GET /api/jobs/autopilot", () => {
  beforeEach(() => {
    runAutopilotTick.mockClear();
    process.env.CRON_SECRET = "s3cret";
  });

  it("rejects a request with no bearer token", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request() as any);
    expect(res.status).toBe(401);
    expect(runAutopilotTick).not.toHaveBeenCalled();
  });

  it("rejects a wrong bearer token", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request("Bearer wrong") as any);
    expect(res.status).toBe(401);
    expect(runAutopilotTick).not.toHaveBeenCalled();
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request("Bearer s3cret") as any);
    expect(res.status).toBe(401);
    expect(runAutopilotTick).not.toHaveBeenCalled();
  });

  it("runs a tick for the right token and returns its summary", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await GET(request("Bearer s3cret") as any);
    expect(res.status).toBe(200);
    expect(runAutopilotTick).toHaveBeenCalledOnce();
    expect(await res.json()).toMatchObject({ workflowsExamined: 0 });
  });
});
