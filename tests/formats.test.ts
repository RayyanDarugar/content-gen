import { describe, expect, it } from "vitest";
import { formatsBlock } from "@/lib/athena/formats";
import type { Format } from "@/lib/types";

function fmt(over: Partial<Format> = {}): Format {
  return {
    id: "f1", user_id: "u1", name: "Myth bust",
    structure: "Hook states the myth, two beats dismantle it, payoff gives the real insight.",
    why_it_works: "A myth opens a curiosity gap the payoff closes.",
    source_example: "Seen on a study-skills account",
    brand_fit: "Brands with a teaching voice and real domain authority.",
    screenshot_url: "", origin: "observed", shared: true, active: true,
    created_at: "", updated_at: "", ...over,
  };
}

describe("formatsBlock", () => {
  it("returns exactly the empty string when there are no formats", () => {
    expect(formatsBlock([])).toBe("");
  });

  it("returns exactly the empty string when every format is excluded", () => {
    expect(formatsBlock([fmt({ id: "f1" })], ["f1"])).toBe("");
  });

  it("renders every field a suggestion needs, including the id", () => {
    const out = formatsBlock([fmt()]);
    expect(out).toContain("id: f1");
    expect(out).toContain("Myth bust");
    expect(out).toContain("two beats dismantle it");
    expect(out).toContain("curiosity gap");
    expect(out).toContain("Seen on a study-skills account");
    expect(out).toContain("teaching voice");
  });

  it("puts observed formats before invented ones", () => {
    const out = formatsBlock([
      fmt({ id: "inv", name: "Invented one", origin: "invented" }),
      fmt({ id: "obs", name: "Observed one", origin: "observed" }),
    ]);
    expect(out.indexOf("Observed one")).toBeLessThan(out.indexOf("Invented one"));
  });

  it("labels each entry with its origin so the model can weigh the evidence", () => {
    const out = formatsBlock([fmt({ id: "inv", origin: "invented" })]);
    expect(out).toContain("[invented]");
  });

  it("drops only the excluded ids and keeps the rest", () => {
    const out = formatsBlock([fmt({ id: "a", name: "Alpha" }), fmt({ id: "b", name: "Beta" })], ["a"]);
    expect(out).not.toContain("Alpha");
    expect(out).toContain("Beta");
  });

  it("omits an empty optional field rather than printing a blank label", () => {
    const out = formatsBlock([fmt({ source_example: "", brand_fit: "" })]);
    expect(out).not.toContain("Source example:");
    expect(out).not.toContain("Fits brands that:");
  });
});
