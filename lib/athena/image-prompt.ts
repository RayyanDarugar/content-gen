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

// Verbatim from the wording that held identity across five slides in
// testing, except "and any persistent elements precisely" is narrowed to the
// deferral sentence below. That phrase told the model to copy the anchor's
// persistent elements — including a hook's MYTH tag and strike-through X,
// which are visually "persistent" in the reference even though they must
// not appear on other panels. Per the header note above, the reference
// image tends to win over prose, so this cannot be fully verified without a
// live run — it narrows the wording rather than trusting prose alone.
const TWO_REFERENCES =
  "Two reference images are provided. The FIRST is the brand style reference. The SECOND " +
  "is the opening panel of this exact carousel — match its palette, typography, and subject " +
  "appearance precisely, while following the camera and pose direction above. For any tag, " +
  "badge, or overlay visible in the second reference, defer to this panel's treatment above " +
  "rather than copying it.";

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

  // The style guide covers what every panel shares; TREATMENT below covers
  // what belongs to THIS role only. Without a role guide, "including any
  // element it specifies as appearing on every panel" is the only signal
  // that footers etc. persist — keep it. With one, that same clause is a
  // direct contradiction of the treatment that follows (a myth-format guide
  // says its "MYTH:" tag and strike-through X appear on every panel; the
  // payoff's treatment says neither does) with no precedence rule between
  // them, so it is dropped and replaced by an explicit precedence line.
  const roleGuide = roleGuides[slide.role]?.trim();
  lines.push(
    "",
    roleGuide
      ? "Follow every rule in the style guide."
      : "Follow every rule in the style guide, including any element it specifies as appearing " +
          "on every panel.",
  );

  if (roleGuide) {
    lines.push(
      "",
      `TREATMENT FOR THIS PANEL (${slide.role}):`,
      roleGuide,
      "",
      "Where this treatment conflicts with the style guide, this treatment governs this panel.",
    );
  }

  if (refinementNotes) lines.push("", `Refinement notes: ${refinementNotes}`);
  lines.push("", `ROLE DIRECTION: ${ROLE_DIRECTION[slide.role]}`);
  lines.push("", chained ? TWO_REFERENCES : ONE_REFERENCE);
  return lines.join("\n");
}
