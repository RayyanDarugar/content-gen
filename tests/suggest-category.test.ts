import { describe, expect, it } from "vitest";
import {
  buildSuggestSystemPrompt, validateSuggestedSample, suggestionToTurns,
  type SuggestResponse,
} from "@/lib/athena/suggest-category";
import { formatsBlock } from "@/lib/athena/formats";
import type { BrandContext } from "@/lib/athena/prompts";
import type { Format } from "@/lib/types";
import type { NormalizedDraft as ND } from "@/lib/athena/draft-category";

const brand: BrandContext = {
  business_name: "Athena",
  business_description: "An SAT prep platform that teaches like a personal tutor.",
  audience: "Parents of high-schoolers",
  voice: "Warm, encouraging, plain-spoken",
  avoid: "AI-powered, dashboards, analytics",
  proof_points: ["Median score lift of 140 points across 3,000 students"],
  standing: ["test preparation", "high-school academics"],
  colors: [], fonts: [], visual_notes: "",
};

function fmt(over: Partial<Format> = {}): Format {
  return {
    id: "f1", user_id: "u1", name: "Myth bust",
    structure: "Hook states the myth, two beats dismantle it, payoff gives the real insight.",
    why_it_works: "A myth opens a curiosity gap the payoff closes.",
    source_example: "Seen on a study-skills account",
    brand_fit: "Brands with a teaching voice.",
    screenshot_url: "", origin: "observed", shared: true, active: true,
    created_at: "", updated_at: "", ...over,
  };
}

const draft: ND = {
  name: "Myth bust", style_guide: "Flat illustration, bold headline.",
  output_format: "myth, two dismantling beats, real insight",
  post_type: "narrative", role_guides: {}, caption_guide: "",
  images_per_carousel: 4, aspect_ratio: "4:5",
};

describe("buildSuggestSystemPrompt", () => {
  it("grounds the suggestion in the brand's material", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out).toContain("Median score lift of 140 points");
    expect(out).toContain("test preparation");
  });

  it("forbids currency claims even when the library is empty", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out.toLowerCase()).toContain("do not claim");
    expect(out).toContain("trending");
  });

  it("forbids currency claims when the library IS present", () => {
    const out = buildSuggestSystemPrompt(brand, [fmt()], [], []);
    expect(out).toContain("trending");
  });

  it("omits the library section entirely when there are no formats", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out).not.toContain("FORMAT LIBRARY");
  });

  // The empty-library invariant, spec §4: a library adds a block and changes
  // NOTHING else. Expressed as a difference rather than a brittle full-string
  // snapshot, so it stays meaningful as the prompt's wording evolves.
  it("adds only the library block and leaves the rest of the prompt untouched", () => {
    const bare = buildSuggestSystemPrompt(brand, [], [], []);
    const withLib = buildSuggestSystemPrompt(brand, [fmt()], [], []);
    const block = formatsBlock([fmt()]);
    expect(withLib).toContain(block);
    expect(withLib.replace(block, "").replace(/\n{2,}/g, "\n\n").trim())
      .toBe(bare.replace(/\n{2,}/g, "\n\n").trim());
  });

  it("renders excluded concepts when supplied and omits the section when empty", () => {
    expect(buildSuggestSystemPrompt(brand, [], [], ["a myth-bust carousel"]))
      .toContain("a myth-bust carousel");
    expect(buildSuggestSystemPrompt(brand, [], [], [])).not.toContain("ALREADY SHOWN");
  });

  it("passes excluded format ids through to the library block", () => {
    const out = buildSuggestSystemPrompt(brand, [fmt({ id: "f1" })], ["f1"], []);
    expect(out).not.toContain("FORMAT LIBRARY");
  });

  it("asserts no palette when the brand has none", () => {
    const out = buildSuggestSystemPrompt(brand, [], [], []);
    expect(out).not.toContain("Palette:");
  });

  it("uses the brand's real palette when it has one", () => {
    const out = buildSuggestSystemPrompt({ ...brand, colors: ["#123456"] }, [], [], []);
    expect(out).toContain("#123456");
  });
});

describe("validateSuggestedSample", () => {
  it("accepts a well-formed narrative sample", () => {
    const sample = {
      concept: "Three SAT myths", caption: "",
      slides: [
        { role: "hook" as const, text: "MYTH", visual: "a" },
        { role: "beat" as const, text: "b", visual: "b" },
        { role: "beat" as const, text: "c", visual: "c" },
        { role: "payoff" as const, text: "d", visual: "d" },
      ],
    };
    expect(validateSuggestedSample(sample, draft).ok).toBe(true);
  });

  it("rejects a narrative sample with the wrong slide count", () => {
    const sample = {
      concept: "x", caption: "",
      slides: [
        { role: "hook" as const, text: "a", visual: "a" },
        { role: "payoff" as const, text: "b", visual: "b" },
      ],
    };
    expect(validateSuggestedSample(sample, draft).ok).toBe(false);
  });

  // An independent post type's sample is ONE standalone image, regardless of
  // images_per_carousel — that field means "how many per batch" there.
  it("expects exactly one 'single' slide for an independent post type", () => {
    const indep: ND = { ...draft, post_type: "independent", images_per_carousel: 5 };
    const ok = { concept: "x", caption: "", slides: [{ role: "single" as const, text: "a", visual: "a" }] };
    const bad = { concept: "x", caption: "", slides: [{ role: "hook" as const, text: "a", visual: "a" }] };
    expect(validateSuggestedSample(ok, indep).ok).toBe(true);
    expect(validateSuggestedSample(bad, indep).ok).toBe(false);
  });
});

describe("suggestionToTurns", () => {
  const res: SuggestResponse = {
    suggestionId: "s1", formatId: "f1",
    rationale: "A myth opens a curiosity gap. It fits Athena's 140-point lift.",
    draft,
    sample: {
      concept: "Three SAT myths", caption: "Here's what actually moves the needle.",
      slides: [
        { role: "hook", text: "MYTH: cramming works", visual: "a" },
        { role: "beat", text: "b", visual: "b" },
        { role: "beat", text: "c", visual: "c" },
        { role: "payoff", text: "Spaced practice wins", visual: "d" },
      ],
    },
  };

  // Load-bearing: the Anthropic API rejects a messages array that starts with
  // an assistant turn, and the wizard replays its whole history on the next
  // message. An assistant-first seed would fail on turn 2, not turn 1.
  it("starts with a user turn so the replayed history stays valid", () => {
    const turns = suggestionToTurns(res);
    expect(turns[0].role).toBe("user");
    expect(turns[1].role).toBe("assistant");
    expect(turns).toHaveLength(2);
  });

  it("carries the draft on the assistant turn so the live panel fills in", () => {
    expect(suggestionToTurns(res)[1].draft).toEqual(draft);
  });

  it("shows the rationale and the worked sample in the assistant turn's text", () => {
    const text = suggestionToTurns(res)[1].text;
    expect(text).toContain("curiosity gap");
    expect(text).toContain("MYTH: cramming works");
    expect(text).toContain("Spaced practice wins");
    expect(text).toContain("Here's what actually moves the needle.");
  });
});
