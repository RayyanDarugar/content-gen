import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withDeadline } from "@/lib/with-deadline";

describe("withDeadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the inner value when the work settles before the deadline", async () => {
    const result = withDeadline(Promise.resolve("real value"), 1_000, "fallback");
    await expect(result).resolves.toBe("real value");
  });

  it("resolves with the fallback when the deadline fires before the work settles", async () => {
    const inner = new Promise<string>(() => {}); // never settles
    const result = withDeadline(inner, 1_000, "fallback value");
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(result).resolves.toBe("fallback value");
  });

  it("resolves with the fallback, not a rejection, when the inner promise rejects before the deadline", async () => {
    const inner = Promise.reject(new Error("boom"));
    const result = withDeadline(inner, 1_000, "fallback");
    await expect(result).resolves.toBe("fallback");
  });

  it("produces no unhandled rejection when the inner promise rejects after the deadline has already fired", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (err: unknown) => seen.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      let rejectInner!: (e: unknown) => void;
      const inner = new Promise<string>((_, reject) => {
        rejectInner = reject;
      });
      const result = withDeadline(inner, 1_000, "fallback");
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(result).resolves.toBe("fallback");

      // The deadline has already settled withDeadline's returned promise.
      // Rejecting the inner promise now must not escape as an unhandled
      // rejection even though its result is discarded.
      rejectInner(new Error("late failure"));
      // Flush the microtask queue so the (discarded) rejection handler runs.
      await vi.runAllTimersAsync();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
