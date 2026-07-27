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

describe("buildSlideView — anchor scoping", () => {
  const a = (id: string, slide_index: number, status: string, created_at: string,
             anchor_generation_id: string | null = null) =>
    ({ id, slide_index, status, created_at, anchor_generation_id });

  it("does not borrow a previous anchor's image when the current one failed", () => {
    const view = buildSlideView([
      a("A", 0, "succeeded", "1"),
      a("A1", 1, "succeeded", "2", "A"),
      a("B", 0, "succeeded", "5"),
      a("B1", 1, "failed", "6", "B"),
    ], 2);
    // Slot 1 must show B's failure, not A's success — otherwise the carousel
    // looks complete while the backend correctly refuses to complete it.
    expect(view.slides[1].generation?.id).toBe("B1");
    expect(view.superseded.map((x) => x.id).sort()).toEqual(["A", "A1"]);
  });

  it("scopes a healthy carousel to the current anchor's slides", () => {
    const view = buildSlideView([
      a("A", 0, "succeeded", "1"),
      a("A1", 1, "succeeded", "2", "A"),
      a("B", 0, "succeeded", "5"),
      a("B1", 1, "succeeded", "6", "B"),
    ], 2);
    expect(view.slides.map((s) => s.generation?.id)).toEqual(["B", "B1"]);
  });

  it("shows everything when no anchor has succeeded yet (first run in flight)", () => {
    const view = buildSlideView([a("p", 0, "polling", "1")], 3);
    expect(view.slides[0].generation?.id).toBe("p");
  });

  it("still handles legacy rows that carry no anchor id", () => {
    const view = buildSlideView([a("only", 0, "succeeded", "1")], 1);
    expect(view.slides[0].generation?.id).toBe("only");
    expect(view.superseded).toEqual([]);
  });
});

describe("buildSlideView — untracked anchor ids", () => {
  const a = (id: string, slide_index: number, status: string, created_at: string,
             anchor_generation_id: string | null = null) =>
    ({ id, slide_index, status, created_at, anchor_generation_id });

  it("keeps siblings that carry no anchor id, rather than hiding legacy rows", () => {
    const view = buildSlideView([
      a("A", 0, "succeeded", "1"),
      a("untracked", 1, "succeeded", "2", null),
    ], 2);
    expect(view.slides[1].generation?.id).toBe("untracked");
  });

  it("still drops a sibling explicitly bound to a superseded anchor", () => {
    const view = buildSlideView([
      a("A", 0, "succeeded", "1"),
      a("A1", 1, "succeeded", "2", "A"),
      a("B", 0, "succeeded", "5"),
    ], 2);
    expect(view.slides[1].generation).toBeNull();
    expect(view.superseded.map((x) => x.id).sort()).toEqual(["A", "A1"]);
  });
});
