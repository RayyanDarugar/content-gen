import { describe, expect, it } from "vitest";
import { zipEntriesForIdea } from "@/lib/download-zip";
import type { Generation } from "@/lib/types";

function gen(over: Partial<Generation>): Generation {
  return {
    id: "g1", user_id: "u1", idea_id: "i1", kie_task_id: "t1",
    status: "succeeded", poll_count: 1, kie_style_url: "", full_prompt: "",
    refinement_notes: "", image_path: "p", public_url: "https://c/clean.jpg",
    composited_url: "", error: "", slide_index: 0, anchor_generation_id: null,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

describe("zipEntriesForIdea", () => {
  it("names entries by carousel position, zero-padded so they sort", () => {
    const out = zipEntriesForIdea(
      [gen({ id: "a", slide_index: 0 }), gen({ id: "b", slide_index: 1 })],
      2,
    );
    expect(out.map((e) => e.name)).toEqual(["01.jpg", "02.jpg"]);
  });

  // The published image, not the clean anchor — this is what the user expects
  // to receive, with the QR code and speaker on it.
  it("uses the composited image when one exists", () => {
    const out = zipEntriesForIdea(
      [gen({ slide_index: 0, composited_url: "https://c/final.jpg" })],
      1,
    );
    expect(out[0].url).toBe("https://c/final.jpg");
  });

  it("falls back to the clean image when nothing was composited", () => {
    const out = zipEntriesForIdea([gen({ slide_index: 0, composited_url: "" })], 1);
    expect(out[0].url).toBe("https://c/clean.jpg");
  });

  it("skips a slide that has not succeeded", () => {
    const out = zipEntriesForIdea(
      [gen({ id: "a", slide_index: 0 }), gen({ id: "b", slide_index: 1, status: "failed" })],
      2,
    );
    expect(out.map((e) => e.name)).toEqual(["01.jpg"]);
  });

  // A gap must not renumber what follows it: slide 3 stays "03.jpg" even when
  // slide 2 is missing, or the zip silently misrepresents the carousel's order.
  it("keeps carousel positions when a slide is missing", () => {
    const out = zipEntriesForIdea(
      [gen({ id: "a", slide_index: 0 }), gen({ id: "c", slide_index: 2 })],
      3,
    );
    expect(out.map((e) => e.name)).toEqual(["01.jpg", "03.jpg"]);
  });

  it("returns nothing when no slide succeeded", () => {
    expect(zipEntriesForIdea([gen({ status: "failed" })], 1)).toEqual([]);
  });

  it("handles an idea with no generations at all", () => {
    expect(zipEntriesForIdea([], 3)).toEqual([]);
  });
});
