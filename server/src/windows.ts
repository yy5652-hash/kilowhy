// Analysis windows (UTC days, 28 days each, aligned by weekday: both start on a Thursday).
export interface DateWindow { id: "A" | "B"; from: string; toExclusive: string; days: number }
export const WINDOW_A: DateWindow = { id: "A", from: "2026-08-27", toExclusive: "2026-09-24", days: 28 };
export const WINDOW_B: DateWindow = { id: "B", from: "2026-09-24", toExclusive: "2026-10-22", days: 28 };
export const SLOTS_PER_DAY = 48;
export const slotsInWindow = (w: DateWindow): number => w.days * SLOTS_PER_DAY;
/** Which window a UTC ISO timestamp or YYYY-MM-DD date falls into, or null. */
export function windowOf(tsOrDate: string, a: DateWindow, b: DateWindow): "A" | "B" | null {
  const d = tsOrDate.slice(0, 10);
  if (d >= a.from && d < a.toExclusive) return "A";
  if (d >= b.from && d < b.toExclusive) return "B";
  return null;
}
