// Recommendation (Q4): counterfactual load shift, re-priced on the REAL window-B Agile prices and carbon intensities.
// Per site and local day: flexible load = peak-band (16:00-19:00 local) kWh above the site's night-band median per slot, capped at maxKwhPerDay.
// It is moved, spread evenly, into the cheapest contiguous block of the same local day that does not overlap the peak band; days where that does not save money are left alone.
// Only complete local days (48 slots) are used. Meter kWh are SAMPLE data; prices and carbon are real.
import { sum } from "./decompose.ts";
import { bandOf, localDate } from "./bands.ts";
import { mean } from "./stats.ts";
import type { SlotRow } from "./data.ts";
import { THRESHOLDS as T } from "./hypotheses/thresholds.ts";
import { loadSlots } from "./hypotheses/context.ts";
import type { HypCtx } from "./hypotheses/types.ts";
import { gbp, metricMap, round } from "./hypotheses/util.ts";

export interface ShiftOptions { maxKwhPerDay?: number; blockSlots?: number }
export interface SiteShift {
  site: string; baselineKwhPerSlot: number | null;
  daysUsed: number; daysShifted: number; shiftedKwh: number;
  costBeforePence: number; costAfterPence: number; savedPence: number;
  savedKgCo2e: number | null;               // null when a carbon intensity is missing in the slots involved
  targetBlock: string | null;               // most common target block, local time "HH:MM-HH:MM"
}
export interface Recommendation {
  scope: string; ok: boolean; reason?: string;
  maxKwhPerDay: number; blockSlots: number;
  sites: SiteShift[];
  total: { daysUsed: number; daysShifted: number; shiftedKwh: number; costBeforeGbp: number; costAfterGbp: number; savedGbp: number; savedKgCo2e: number | null };
  text: string;
  evidence: string[];
}

const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const hhmm = (h: number): string => `${String(Math.floor(h)).padStart(2, "0")}:${h % 1 ? "30" : "00"}`;

/** Counterfactual for ONE site from its window-B slots (sorted or not). Pure. */
export function planShift(rowsIn: SlotRow[], opts: ShiftOptions = {}): SiteShift {
  const cap = opts.maxKwhPerDay ?? T.REC_MAX_KWH_PER_DAY, n = opts.blockSlots ?? T.REC_BLOCK_SLOTS;
  const rows = [...rowsIn].sort((a, b) => a.ts.localeCompare(b.ts));
  const site = rows[0]?.site ?? "";
  const nights = rows.filter((r) => bandOf(r.ts) === "night").map((r) => r.kwh);
  const base = nights.length ? median(nights) : null;
  const out: SiteShift = { site, baselineKwhPerSlot: base, daysUsed: 0, daysShifted: 0, shiftedKwh: 0, costBeforePence: 0, costAfterPence: 0, savedPence: 0, savedKgCo2e: 0, targetBlock: null };
  if (base === null) return out;
  const byDay = new Map<string, SlotRow[]>();
  for (const r of rows) (byDay.get(localDate(r.ts)) ?? byDay.set(localDate(r.ts), []).get(localDate(r.ts))!).push(r);
  const kgParts: number[] = [];
  const blockStarts = new Map<number, number>();
  for (const [, day] of [...byDay].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (day.length !== T.SLOTS_PER_DAY) continue;
    out.daysUsed++;
    const dayCost = sum(day.map((r) => r.kwh * r.p));
    out.costBeforePence += dayCost;
    const peak = day.map((r, k) => ({ r, k })).filter((x) => bandOf(x.r.ts) === "peak");
    const flex = peak.map((x) => Math.max(0, x.r.kwh - base));
    const F = sum(flex);
    const moved = Math.min(F, cap);
    let after = dayCost;
    if (moved > 1e-9) {
      const f = moved / F;
      // cheapest contiguous block of n slots that does not touch the peak band
      let best = -1, bestMean = Infinity;
      for (let s = 0; s + n <= day.length; s++) {
        const blk = day.slice(s, s + n);
        if (blk.some((r) => bandOf(r.ts) === "peak")) continue;
        const m = mean(blk.map((r) => r.p));
        if (m < bestMean - 1e-12) { bestMean = m; best = s; }
      }
      if (best >= 0) {
        const blk = day.slice(best, best + n);
        const removed = sum(peak.map((x, i) => flex[i] * f * x.r.p));
        const added = (moved / n) * sum(blk.map((r) => r.p));
        if (removed - added > 1e-9) {
          after = dayCost - removed + added;
          out.daysShifted++; out.shiftedKwh += moved;
          blockStarts.set(best, (blockStarts.get(best) ?? 0) + 1);
          const ci = [...peak.map((x) => x.r.intensity), ...blk.map((r) => r.intensity)];
          if (ci.some((v) => v === null)) kgParts.push(NaN);
          else kgParts.push((sum(peak.map((x, i) => flex[i] * f * (x.r.intensity as number))) - (moved / n) * sum(blk.map((r) => r.intensity as number))) / 1000);
        }
      }
    }
    out.costAfterPence += after;
  }
  out.savedPence = out.costBeforePence - out.costAfterPence;
  out.savedKgCo2e = kgParts.some((x) => Number.isNaN(x)) ? null : sum(kgParts);
  if (blockStarts.size) {
    const modal = [...blockStarts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]; // slot k of a complete local day starts at k/2 hours local
    out.targetBlock = `${hhmm(modal / 2)}-${hhmm((modal + n) / 2)}`;
  }
  return out;
}

export async function recommend(ctx: HypCtx, opts: ShiftOptions = {}): Promise<Recommendation> {
  const cap = opts.maxKwhPerDay ?? T.REC_MAX_KWH_PER_DAY, n = opts.blockSlots ?? T.REC_BLOCK_SLOTS;
  const empty = { daysUsed: 0, daysShifted: 0, shiftedKwh: 0, costBeforeGbp: 0, costAfterGbp: 0, savedGbp: 0, savedKgCo2e: 0 as number | null };
  const { rows, evidence: ev } = await loadSlots(ctx, "REC", `Counterfactual load shift on window-B prices (${ctx.scope.label})`);
  const sites = ctx.sites.map((s) => ({ ...planShift(rows.filter((r) => r.win === "B" && r.site === s), opts), site: s }));
  if (sites.every((s) => s.daysUsed === 0)) return { scope: ctx.scope.label, ok: false, reason: "no complete local days in window B", maxKwhPerDay: cap, blockSlots: n, sites, total: empty, text: "no recommendation: no complete local days in window B", evidence: [ev.id] };
  const total = {
    daysUsed: Math.max(...sites.map((s) => s.daysUsed)), daysShifted: sum(sites.map((s) => s.daysShifted)), shiftedKwh: sum(sites.map((s) => s.shiftedKwh)),
    costBeforeGbp: gbp(sum(sites.map((s) => s.costBeforePence))), costAfterGbp: gbp(sum(sites.map((s) => s.costAfterPence))), savedGbp: gbp(sum(sites.map((s) => s.savedPence))),
    savedKgCo2e: sites.some((s) => s.savedKgCo2e === null) ? null : sum(sites.map((s) => s.savedKgCo2e as number)),
  };
  ctx.evidence.addMetrics(ev.id, metricMap({
    shifted_kwh: [total.shiftedKwh, "kWh"], days_shifted_site_days: [total.daysShifted, "site-days"], days_used: [total.daysUsed, "days"],
    cost_before: [total.costBeforeGbp, "GBP"], cost_after: [total.costAfterGbp, "GBP"], saved: [total.savedGbp, "GBP"], saved_kgco2e: [total.savedKgCo2e, "kgCO2e"],
    max_kwh_per_day: [cap, "kWh/day/site"], block_slots: [n, "slots"],
  }));
  const blocks = [...new Set(sites.map((s) => s.targetBlock).filter((b): b is string => !!b))];
  const text = total.shiftedKwh > 0
    ? `Move the peak-band (16:00-19:00) load above the night baseline (up to ${cap} kWh/day per site; ${round(total.shiftedKwh, 1)} kWh in total over ${total.daysUsed} days) into the cheapest ${n / 2}-hour block of the same day${blocks.length ? ` (typically ${blocks.join(", ")})`: ""}: saves £${total.savedGbp.toFixed(2)}${total.savedKgCo2e === null ? "" : ` and ${total.savedKgCo2e.toFixed(2)} kgCO2e`} on window-B prices (SAMPLE meter data).`
    : "No flexible peak-band load above the night baseline was found, so shifting would save nothing (SAMPLE meter data).";
  return { scope: ctx.scope.label, ok: true, maxKwhPerDay: cap, blockSlots: n, sites, total, text, evidence: [ev.id] };
}
