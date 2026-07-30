import { describe, expect, it } from "vitest";
import { buildFormatDraftSystemPrompt, formatDraftMessages } from "@/lib/athena/draft-format";

describe("buildFormatDraftSystemPrompt", () => {
  it("asks for a brand-independent, reusable structure", () => {
    const out = buildFormatDraftSystemPrompt();
    expect(out).toContain("reusable");
    expect(out.toLowerCase()).toContain("different brand");
  });

  it("reads multiple screenshots as one post in order", () => {
    expect(buildFormatDraftSystemPrompt()).toContain("slides of ONE post");
  });

  it("forbids copying the example's visual identity", () => {
    const out = buildFormatDraftSystemPrompt();
    expect(out).toContain("NEVER");
    expect(out.toLowerCase()).toContain("colors");
  });

  it("forbids inventing engagement numbers about the example", () => {
    expect(buildFormatDraftSystemPrompt().toLowerCase()).toContain("do not invent");
  });
});

describe("formatDraftMessages", () => {
  it("puts every screenshot in a single user turn, in order", () => {
    const [msg] = formatDraftMessages(["https://a/1.png", "https://a/2.png"], "");
    expect(msg.role).toBe("user");
    const content = msg.content as Array<{ type: string; source?: { url: string } }>;
    expect(content.filter((c) => c.type === "image")).toHaveLength(2);
    expect(content[0].source?.url).toBe("https://a/1.png");
    expect(content[1].source?.url).toBe("https://a/2.png");
  });

  it("always ends with a text block, even with no note", () => {
    const [msg] = formatDraftMessages(["https://a/1.png"], "");
    const content = msg.content as Array<{ type: string; text?: string }>;
    expect(content[content.length - 1].type).toBe("text");
    expect(content[content.length - 1].text).toBeTruthy();
  });

  it("carries the note when one is given", () => {
    const [msg] = formatDraftMessages([], "a16z's 'startups that need to exist' posts");
    const content = msg.content as Array<{ type: string; text?: string }>;
    expect(content[content.length - 1].text).toContain("startups that need to exist");
  });
});
