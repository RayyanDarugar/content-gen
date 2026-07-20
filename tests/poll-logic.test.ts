import { describe, it, expect } from "vitest";
import { decidePoll, POLL_CAP } from "@/lib/athena/poll-logic";

describe("decidePoll", () => {
  it("success with URL → ingest", () => {
    expect(decidePoll({ state: "success", resultUrl: "https://x/img.png" }, 3)).toEqual({
      action: "ingest",
      resultUrl: "https://x/img.png",
    });
  });
  it("success without URL → fail with clear error", () => {
    const d = decidePoll({ state: "success", resultUrl: null }, 3);
    expect(d.action).toBe("fail");
    if (d.action === "fail") expect(d.error).toContain("no result URL");
  });
  it("fail state → fail", () => {
    expect(decidePoll({ state: "fail", resultUrl: null }, 0).action).toBe("fail");
  });
  it("pending below cap → wait with incremented count", () => {
    expect(decidePoll({ state: "generating", resultUrl: null }, 5)).toEqual({
      action: "wait",
      pollCount: 6,
    });
  });
  it("pending at cap boundary → fail (never waits past POLL_CAP)", () => {
    const d = decidePoll({ state: "queuing", resultUrl: null }, POLL_CAP - 1);
    expect(d.action).toBe("fail");
    if (d.action === "fail") expect(d.error).toContain("poll cap");
  });
});
