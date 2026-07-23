import { timingSafeEqual } from "crypto";

export function checkInviteCode(input: string): boolean {
  const expected = process.env.INVITE_CODE;
  if (!expected) return false; // fail closed if unconfigured
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
