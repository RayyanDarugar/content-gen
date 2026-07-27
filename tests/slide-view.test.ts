import { describe, it, expect } from "vitest";
import { buildSlideView } from "@/lib/athena/slide-view";

const g = (id: string, slide_index: number, status: string, created_at: string) =>
  ({ id, slide_index, status, created_at });

describe("buildSlideView", () => {
  it("places each slide in its own slot, in order", () => {
    const view = buildSlideView(
      [g("c", 2, "succeeded", "3"), g("a", 0, "succeeded", "1"), g("b", 1, "succeeded", "2")],
      3,
    );
    expect(view.slides.map((s) => s.generation?.id)).toEqual(["a", "b", "c"]);
    expect(view.superseded).toEqual([]);
  });

  it("leaves a slot empty when its slide hasn't generated yet", () => {
    const view = buildSlideView([g("a", 0, "succeeded", "1")], 3);
    expect(view.slides.map((s) => s.generation?.id ?? null)).toEqual(["a", null, null]);
  });

  it("treats a retry of the same slide as superseding, not as a sibling", () => {
    const view = buildSlideView(
      [g("old", 1, "succeeded", "1"), g("new", 1, "succeeded", "2")],
      2,
    );
    expect(view.slides[1].generation?.id).toBe("new");
    expect(view.superseded.map((x) => x.id)).toEqual(["old"]);
  });

  it("keeps a succeeded image even when a later retry of that slide failed", () => {
    const view = buildSlideView(
      [g("ok", 0, "succeeded", "1"), g("dud", 0, "failed", "2")],
      1,
    );
    expect(view.slides[0].generation?.id).toBe("ok");
    expect(view.superseded.map((x) => x.id)).toEqual(["dud"]);
  });

  it("shows an in-flight generation when the slot has no success yet", () => {
    const view = buildSlideView([g("p", 0, "polling", "1")], 1);
    expect(view.slides[0].generation?.id).toBe("p");
  });

  it("prefers the newest among equally-unsuccessful attempts", () => {
    const view = buildSlideView(
      [g("first", 0, "failed", "1"), g("second", 0, "failed", "2")],
      1,
    );
    expect(view.slides[0].generation?.id).toBe("second");
  });

  it("ignores generations whose slide index is out of range", () => {
    const view = buildSlideView([g("a", 0, "succeeded", "1"), g("stray", 7, "succeeded", "2")], 1);
    expect(view.slides).toHaveLength(1);
    expect(view.superseded.map((x) => x.id)).toEqual(["stray"]);
  });

  it("treats a legacy idea with no slides as a single slot", () => {
    const view = buildSlideView([g("a", 0, "succeeded", "1")], 0);
    expect(view.slides).toHaveLength(1);
    expect(view.slides[0].generation?.id).toBe("a");
  });
});
