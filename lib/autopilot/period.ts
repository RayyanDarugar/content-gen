import type { AutopilotPeriod } from "@/lib/types";

// All timezone arithmetic here goes through Intl.DateTimeFormat rather than a
// date library — the only two questions autopilot ever asks are "what local
// calendar date is it?" and "when did that local date begin?", and both are
// answerable from formatted parts.

function localParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  // hourCycle h23 is load-bearing: with hour12:false alone, some ICU versions
  // render midnight as "24", which would push the reconstructed date a day
  // forward inside offsetMs below.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"), month: get("month"), day: get("day"),
    hour: get("hour"), minute: get("minute"), second: get("second"),
  };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// Monday-based index (Mon = 0 … Sun = 6) of a calendar date, computed with UTC
// arithmetic on the date alone — no timezone involved, because by this point
// the date is already the workflow's LOCAL date.
function mondayIndex(year: number, month: number, day: number): number {
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // Sun = 0
  return (dow + 6) % 7;
}

// The local calendar date (YYYY-MM-DD) that `now` belongs to for this period
// kind: the local day itself, or its ISO week's Monday.
export function periodStart(now: Date, timezone: string, period: AutopilotPeriod): string {
  const { year, month, day } = localParts(now, timezone);
  if (period === "day") return `${year}-${pad(month)}-${pad(day)}`;
  const back = mondayIndex(year, month, day);
  const monday = new Date(Date.UTC(year, month - 1, day - back));
  return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
}

// How far the zone is from UTC at a given instant, in ms.
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - instant.getTime();
}

// The instant at which local midnight of `periodStartDate` occurred. Two
// passes, because the offset must be the one in force AT that instant, not at
// the naive UTC guess — on a DST-transition date those differ by an hour, and
// a one-hour error moves the lower bound of the landed-post count onto the
// wrong side of a real post.
export function periodStartUtc(periodStartDate: string, timezone: string): Date {
  const [year, month, day] = periodStartDate.split("-").map(Number);
  const guess = new Date(Date.UTC(year, month - 1, day));
  const first = new Date(guess.getTime() - offsetMs(guess, timezone));
  const settled = offsetMs(first, timezone);
  return new Date(guess.getTime() - settled);
}
