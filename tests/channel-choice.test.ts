import { describe, expect, it } from "vitest";
import { encodeChannelChoice, decodeChannelChoice } from "@/lib/channel-choice";

describe("channel choice encoding", () => {
  it("round-trips", () => {
    const v = encodeChannelChoice("conn-1", "chan-9", "linkedin");
    expect(decodeChannelChoice(v)).toEqual({ connectionId: "conn-1", channelId: "chan-9", service: "linkedin" });
  });
  it("returns null for empty and malformed values", () => {
    expect(decodeChannelChoice("")).toBeNull();
    expect(decodeChannelChoice("just-one-part")).toBeNull();
  });
});
