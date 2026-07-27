import type { RoleGuides, Slide } from "@/lib/types";

// Kept deliberately short. Testing showed the reference image overrides
// art-direction prose, so long stylistic instructions here buy nothing and
// push the prompt toward Kie's flaky length range.
const ROLE_DIRECTION: Record<Slide["role"], string> = {
  hook:
    "This is the anchor panel. Establish the palette, lettering, subject appearance, and " +
    "any persistent elements — every later panel matches this one.",
  beat:
    "Middle story beat. Match the reference panels exactly for palette, lettering, subject " +
    "appearance, and persistent elements, but the camera angle and pose must differ from " +
    "every other panel.",
  payoff:
    "Payoff panel. Highest emotional register in the set, and the tightest crop of the " +
    "carousel. Same palette, lettering, subject, and persistent elements as the references.",
  single:
    "A single standalone image, not part of a sequence. It must work alone.",
};

const ONE_REFERENCE =
  "Reference the provided style image to maintain visual consistency in palette, " +
  "illustration style, and layout.";

// Verbatim from the wording that held identity across five slides in testing.
const TWO_REFERENCES =
  "Two reference images are provided. The FIRST is the brand style reference. The SECOND " +
  "is the opening panel of this exact carousel — match its palette, typography, subject " +
  "appearance, and any persistent elements precisely, while following the camera and pose " +
  "direction above.";

export function buildSlidePrompt(
  styleGuide: string,
  slide: Slide,
  position: number,
  total: number,
  chained: boolean,
  refinementNotes = "",
  roleGuides: RoleGuides = {},
): string {
  const lines: string[] = [styleGuide, "", "SPECIFIC CONTENT FOR THIS IMAGE:"];
  if (total > 1) lines.push(`Panel ${position} of ${total}.`, "");
  if (slide.text.trim()) lines.push(`Text on panel: "${slide.text}"`);
  if (slide.visual.trim()) lines.push(`Scene: ${slide.visual}`);
  lines.push(
    "",
    "Follow every rule in the style guide, including any element it specifies as appearing " +
      "on every panel.",
  );

  // The style guide covers what every panel shares; this covers what belongs
  // to THIS role only. Without it a myth-format guide stamps its "MYTH:" tag
  // and strike-through X onto the explainer beats and the payoff too —
  // crossing out the very insight the carousel exists to land.
  const roleGuide = roleGuides[slide.role]?.trim();
  if (roleGuide) {
    lines.push("", `TREATMENT FOR THIS PANEL (${slide.role}):`, roleGuide);
  }

  if (refinementNotes) lines.push("", `Refinement notes: ${refinementNotes}`);
  lines.push("", `ROLE DIRECTION: ${ROLE_DIRECTION[slide.role]}`);
  lines.push("", chained ? TWO_REFERENCES : ONE_REFERENCE);
  return lines.join("\n");
}
