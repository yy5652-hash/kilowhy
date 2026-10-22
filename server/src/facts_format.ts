// Display formatting of the facts table (spec section 13): £1,234.56 (negative −£12.34), 12.3%, 4,567 kWh, 21.4 p/kWh, 103.0 kgCO2e, YYYY-MM-DD.
// The narrative must copy these strings verbatim; the verifier parses them back, so every format here has a matching parser in verifier.ts.
export const MINUS = "−"; // U+2212, used for negative numbers in every display string

export type FactValue = number | string | boolean | null;

const group = (abs: number, dp: number): string => abs.toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** "1,234.56" with a leading U+2212 when the ROUNDED value is below zero (so −0.004 shows as "0.00"). */
export function signedNumber(x: number, dp: number): string {
  const rounded = Math.round(Math.abs(x) * 10 ** dp) / 10 ** dp;
  return `${x < 0 && rounded > 0 ? MINUS : ""}${group(rounded, dp)}`;
}
const wrap = (x: number, dp: number, prefix: string, suffix: string): string => {
  const s = signedNumber(x, dp);
  return s.startsWith(MINUS) ? `${MINUS}${prefix}${s.slice(1)}${suffix}` : `${prefix}${s}${suffix}`;
};

export const fmtGbp = (x: number): string => wrap(x, 2, "£", "");
export const fmtPct = (x: number): string => wrap(x, 1, "", "%");
export const fmtKwh = (x: number): string => wrap(x, Math.abs(x) >= 100 ? 0 : 1, "", " kWh");
export const fmtPkwh = (x: number): string => wrap(x, 1, "", " p/kWh");
export const fmtKg = (x: number): string => wrap(x, 1, "", " kgCO2e");
export const fmtPp = (x: number): string => wrap(x, 1, "", " pp");

/** Units whose values are numbers and how they are displayed. Anything else falls back to "<number> <unit>". */
const FORMATTERS: Record<string, (x: number) => string> = {
  GBP: fmtGbp, "%": fmtPct, kWh: fmtKwh, "p/kWh": fmtPkwh, kgCO2e: fmtKg, pp: fmtPp,
  sd: (x) => wrap(x, 1, "", " sd"), HDD: (x) => wrap(x, 1, "", " HDD"), "kWh/HDD": (x) => wrap(x, 2, "", " kWh/HDD"), "kWh/day": (x) => wrap(x, 1, "", " kWh/day"),
  "p/day": (x) => wrap(x, 2, "", " p/day"), "gCO2/kWh": (x) => wrap(x, 1, "", " gCO2/kWh"), r: (x) => wrap(x, 2, "", ""), t: (x) => wrap(x, 1, "", ""),
  days: (x) => wrap(x, 0, "", " days"), slots: (x) => wrap(x, 0, "", " slots"), count: (x) => wrap(x, 0, "", ""), number: (x) => wrap(x, 2, "", ""),
};
/** Number of decimals each unit's value is kept with in Fact.value (more than the display, so "within rounding" has something to round). */
export const VALUE_DP = 4;

export function displayFor(value: FactValue, unit: string): string {
  if (value === null || value === undefined) return "n/a";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  const f = FORMATTERS[unit];
  return f ? f(value) : wrap(value, Number.isInteger(value) ? 0 : 2, "", unit ? ` ${unit}` : "");
}

/** The kind of token a unit's display produces (see verifier.ts); "plain" units only match plain numbers. */
export type TokenKind = "money" | "pct" | "kwh" | "pkwh" | "kg" | "pp" | "plain";
export const UNIT_KIND: Record<string, TokenKind> = { GBP: "money", "%": "pct", kWh: "kwh", "p/kWh": "pkwh", kgCO2e: "kg", pp: "pp" };
export const kindOfUnit = (unit: string): TokenKind => UNIT_KIND[unit] ?? "plain";
