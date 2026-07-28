// One <select> option must carry three values (connection, channel, service).
// "|" is safe: Buffer ids are alphanumeric and services are single words.
export function encodeChannelChoice(connectionId: string, channelId: string, service: string): string {
  return `${connectionId}|${channelId}|${service}`;
}

export function decodeChannelChoice(
  value: string,
): { connectionId: string; channelId: string; service: string } | null {
  if (!value) return null;
  const parts = value.split("|");
  if (parts.length !== 3 || !parts[0] || !parts[1]) return null;
  return { connectionId: parts[0], channelId: parts[1], service: parts[2] };
}

// Categories saved before the service field existed (or whose stored value
// has otherwise drifted) carry a stale/empty `service`. Both save() and the
// select's displayed value need the LIVE service for a channel id so the
// encoded choice matches an actual <option>; fall back to the stored value
// only when the channel isn't in the live list at all (e.g. failed fetch).
export function resolveChannelService(
  channels: { id: string; service: string }[],
  channelId: string,
  fallback: string,
): string {
  return channels.find((c) => c.id === channelId)?.service ?? fallback;
}
