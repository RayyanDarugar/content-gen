import { describe, expect, it } from "vitest";
import { encodeChannelChoice, decodeChannelChoice, resolveChannelService } from "@/lib/channel-choice";

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

describe("resolveChannelService", () => {
  const channels = [
    { id: "chan-1", service: "linkedin" },
    { id: "chan-2", service: "instagram" },
  ];

  it("prefers the live channel's service over a stale fallback", () => {
    expect(resolveChannelService(channels, "chan-1", "")).toBe("linkedin");
  });

  it("heals a pre-migration category whose stored service is empty", () => {
    // Simulates a category saved before buffer_channel_service existed:
    // buffer_channel_id/buffer_connection_id are valid, service is "".
    expect(resolveChannelService(channels, "chan-2", "")).toBe("instagram");
  });

  it("falls back to the stored value when the channel is missing from the live list", () => {
    expect(resolveChannelService(channels, "chan-404", "stale-service")).toBe("stale-service");
  });
});
