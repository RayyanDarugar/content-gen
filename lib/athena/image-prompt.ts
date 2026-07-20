export function buildImagePrompt(
  styleGuide: string,
  resolvedPrompt: string,
  refinementNotes = "",
): string {
  const content = refinementNotes
    ? `${resolvedPrompt}\n\nRefinement notes: ${refinementNotes}`
    : resolvedPrompt;
  return (
    styleGuide +
    "\n\nSPECIFIC CONTENT FOR THIS IMAGE:\n" +
    content +
    "\n\nReference the provided style image to maintain visual consistency in palette, illustration style, and layout."
  );
}
