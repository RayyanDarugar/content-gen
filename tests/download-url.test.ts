import { describe, expect, it } from "vitest";
import { attachmentUrl, slugForAttachment } from "@/lib/download-url";

const CLOUDINARY = "https://res.cloudinary.com/demo/image/upload/v1712345678/athena/abc123.jpg";

describe("attachmentUrl", () => {
  it("inserts fl_attachment into a Cloudinary upload URL", () => {
    expect(attachmentUrl(CLOUDINARY)).toBe(
      "https://res.cloudinary.com/demo/image/upload/fl_attachment/v1712345678/athena/abc123.jpg",
    );
  });

  it("names the file when given one", () => {
    expect(attachmentUrl(CLOUDINARY, "Why founders stall")).toBe(
      "https://res.cloudinary.com/demo/image/upload/fl_attachment:why-founders-stall/v1712345678/athena/abc123.jpg",
    );
  });

  // Cloudinary delimits transformation components with "/" and ",", so an
  // unsanitised concept would corrupt the URL rather than name the file.
  it("sanitises a filename containing delimiters", () => {
    const out = attachmentUrl(CLOUDINARY, "a/b,c d");
    expect(out).toContain("fl_attachment:a-b-c-d/");
    expect(out.split("/image/upload/")[1].split("/")[0]).toBe("fl_attachment:a-b-c-d");
  });

  // Test Run previews are data URIs; other hosts and empty values reach this
  // too. Blind insertion would corrupt all three.
  it("passes a data URI through unchanged", () => {
    const uri = "data:image/png;base64,AAAA";
    expect(attachmentUrl(uri, "x")).toBe(uri);
  });

  it("passes a non-Cloudinary URL through unchanged", () => {
    const url = "https://example.test/image/upload/v1/x.jpg";
    expect(attachmentUrl(url)).toBe(url);
  });

  it("passes an empty string through unchanged", () => {
    expect(attachmentUrl("")).toBe("");
  });

  it("leaves a raw (non-image) Cloudinary URL alone", () => {
    const raw = "https://res.cloudinary.com/demo/raw/upload/v1/brand-docs/deck.pdf";
    expect(attachmentUrl(raw)).toBe(raw);
  });
});

describe("slugForAttachment", () => {
  it("lowercases and hyphenates", () => {
    expect(slugForAttachment("Why Founders Stall")).toBe("why-founders-stall");
  });

  it("collapses runs and trims edges", () => {
    expect(slugForAttachment("  --Hello,   World!!  ")).toBe("hello-world");
  });

  it("caps the length", () => {
    expect(slugForAttachment("a".repeat(100)).length).toBe(60);
  });

  it("falls back rather than returning an empty slug", () => {
    expect(slugForAttachment("!!!")).toBe("download");
  });
});
