// Local-time price bands. The UK is on BST (UTC+1) until 2026-10-25, so local hour = UTC hour + 1 for both analysis windows.
// Timestamps in this project are UTC ISO strings ("2026-09-24T17:30:00Z").
export const LOCAL_OFFSET_HOURS = 1;

export type Band = "night" | "morning" | "afternoon" | "peak" | "evening";
/** Local hour ranges [from, to): night 00-07, morning 07-12, afternoon 12-16, peak 16-19, evening 19-24. */
export const BANDS: { band: Band; from: number; to: number }[] = [
  { band: "night", from: 0, to: 7 },
  { band: "morning", from: 7, to: 12 },
  { band: "afternoon", from: 12, to: 16 },
  { band: "peak", from: 16, to: 19 },
  { band: "evening", from: 19, to: 24 },
];
export const BAND_NAMES: Band[] = BANDS.map((b) => b.band);

const localMs = (ts: string): number => Date.parse(ts) + LOCAL_OFFSET_HOURS * 3600e3;

/** Local hour of day as a fraction (e.g. 17.5 for 17:30 local). */
export function localHour(ts: string): number {
  const d = new Date(localMs(ts));
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}
export const localDate = (ts: string): string => new Date(localMs(ts)).toISOString().slice(0, 10);
export const utcDate = (ts: string): string => new Date(Date.parse(ts)).toISOString().slice(0, 10);
export const weekdayUtc = (date: string): number => new Date(date + "T00:00:00Z").getUTCDay();

export function bandOf(ts: string): Band {
  const h = localHour(ts);
  return (BANDS.find((b) => h >= b.from && h < b.to) ?? BANDS[BANDS.length - 1]).band;
}

/** "2026-09-24 17:30:00.0" (Zetaris, UTC) or an ISO string -> ISO "2026-09-24T17:30:00Z". */
export function toIso(z: string): string {
  if (z.includes("T")) return new Date(z).toISOString().replace(".000Z", "Z");
  return z.replace(" ", "T").replace(/\.0+$/, "") + "Z";
}
export const addDays = (d: string, n: number): string => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
