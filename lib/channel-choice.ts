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
