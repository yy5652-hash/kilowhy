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
import { FLAT_TARIFF } from "./flat_tariff.ts";
import type { HypCtx } from "./hypotheses/types.ts";
import { fetchMeta, gbp, metricMap, round } from "./hypotheses/util.ts";

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

// ---------------------------------------------------------------- v2: tariff counterfactual (flat business tariff vs the actual Agile bill)

export const TARIFF_NOT_ADVICE = "Historical counterfactual on the same kWh over the two analysis windows, not advice: it ignores future price changes, contract terms, switching rules and VAT status.";

export interface TariffSide { energyGbp: number; standingGbp: number; totalGbp: number }
export interface TariffWindow {
  win: "A" | "B"; slots: number; days: number; kwh: number;
  agile: TariffSide;                        // actual: Agile energy (inc VAT) + contract standing charge
  flat: TariffSide;                         // counterfactual: flat unit rate and standing charge, VAT at the contract rate
  flatMinusAgileGbp: number;                // > 0: the flat tariff would have cost more
  flatUnitRateRangeP: [number, number];     // ex VAT, p/kWh, over the slots of the window
  coverageComplete: boolean;                // every half-hour of the window had a flat rate in force
}
export interface TariffComparison {
  scope: string; ok: boolean; reason?: string;
  historicalCounterfactual: true; notAdvice: string;
  tariff: { productCode: string; tariffCode: string; name: string; region: string; why: string; vatRate: number | null; vatBasis: string };
  windows: { A: TariffWindow; B: TariffWindow } | null;
  sites: { site: string; A: TariffWindow; B: TariffWindow }[];
  cheaperInWindowB: "agile" | "flat" | "equal" | null;
  text: string;
  evidence: string[];
}

const sideOf = (energyPence: number, standingPence: number): TariffSide => ({ energyGbp: gbp(energyPence), standingGbp: gbp(standingPence), totalGbp: gbp(energyPence + standingPence) });

/** Same kWh, two tariffs, both windows. Agile = actual bill (energy inc VAT + contract standing charge); flat = flat unit rate + standing charge ex VAT with the contract's VAT rate applied. */
export async function recommendTariff(ctx: HypCtx): Promise<TariffComparison> {
  const vat = ctx.decomposition.vatRate;
  const base = { scope: ctx.scope.label, historicalCounterfactual: true as const, notAdvice: TARIFF_NOT_ADVICE,
    tariff: { productCode: FLAT_TARIFF.productCode, tariffCode: FLAT_TARIFF.tariffCode, name: FLAT_TARIFF.name, region: FLAT_TARIFF.region, why: FLAT_TARIFF.why, vatRate: vat, vatBasis: FLAT_TARIFF.vatNote } };
  const none = (reason: string, evidence: string[] = []): TariffComparison => ({ ...base, ok: false, reason, windows: null, sites: [], cheaperInWindowB: null, text: `no tariff comparison: ${reason}`, evidence });
  if (vat === null) return none("no VAT rate in the contract, so the two tariffs cannot be put on the same basis");
  const f = await ctx.data.tariff({ sites: ctx.sites, windows: { A: ctx.windowA, B: ctx.windowB } }, fetchMeta(ctx, "REC-TARIFF", `Flat tariff vs Agile on the same kWh (${ctx.scope.label})`));
  const standing = ctx.decomposition.standing;
  const expected = { A: ctx.windowA.days * T.SLOTS_PER_DAY, B: ctx.windowB.days * T.SLOTS_PER_DAY };
  const win = (rows: typeof f.rows, w: "A" | "B", nSites: number): TariffWindow | null => {
    const rs = rows.filter((r) => r.win === w);
    if (rs.length === 0) return null;
    const slots = sum(rs.map((r) => r.nSlots)), days = slots / T.SLOTS_PER_DAY;
    const agile = sideOf(sum(rs.map((r) => r.agileIncPence)), days * standing[w]);
    const flat = sideOf(sum(rs.map((r) => r.flatExcPence)) * (1 + vat), sum(rs.map((r) => r.flatStandingExcPence)) * (1 + vat));
    return {
      win: w, slots, days, kwh: sum(rs.map((r) => r.kwh)), agile, flat, flatMinusAgileGbp: round(flat.totalGbp - agile.totalGbp, 2),
      flatUnitRateRangeP: [Math.min(...rs.map((r) => r.flatRateMinExc)), Math.max(...rs.map((r) => r.flatRateMaxExc))],
      coverageComplete: rs.length === nSites && rs.every((r) => r.nSlots === expected[w]),
    };
  };
  const sites = ctx.sites.map((s) => ({ site: s, A: win(f.rows.filter((r) => r.site === s), "A", 1), B: win(f.rows.filter((r) => r.site === s), "B", 1) }));
  if (sites.some((s) => !s.A || !s.B)) return none("a site has no half-hours with both an Agile price and a flat-tariff rate in one of the windows", [f.evidence.id]);
  const okSites = sites as { site: string; A: TariffWindow; B: TariffWindow }[];
  const total = (w: "A" | "B"): TariffWindow => {
    const parts = okSites.map((s) => s[w]);
    const addSide = (k: "agile" | "flat"): TariffSide => ({ energyGbp: round(sum(parts.map((p) => p[k].energyGbp)), 2), standingGbp: round(sum(parts.map((p) => p[k].standingGbp)), 2), totalGbp: round(sum(parts.map((p) => p[k].totalGbp)), 2) });
    const agile = addSide("agile"), flat = addSide("flat");
    return { win: w, slots: sum(parts.map((p) => p.slots)), days: parts[0].days, kwh: sum(parts.map((p) => p.kwh)), agile, flat, flatMinusAgileGbp: round(flat.totalGbp - agile.totalGbp, 2),
      flatUnitRateRangeP: [Math.min(...parts.map((p) => p.flatUnitRateRangeP[0])), Math.max(...parts.map((p) => p.flatUnitRateRangeP[1]))], coverageComplete: parts.every((p) => p.coverageComplete) };
  };
  const windows = { A: total("A"), B: total("B") };
  const cheaperInWindowB = windows.B.flatMinusAgileGbp > 0.005 ? "agile" : windows.B.flatMinusAgileGbp < -0.005 ? "flat" : "equal";
  const m: Record<string, [number | string | boolean | null, string]> = { vat_rate: [vat, "ratio"] };
  for (const w of ["A", "B"] as const) {
    const x = windows[w];
    m[`agile_total_${w}`] = [x.agile.totalGbp, "GBP"]; m[`flat_total_${w}`] = [x.flat.totalGbp, "GBP"]; m[`flat_minus_agile_${w}`] = [x.flatMinusAgileGbp, "GBP"];
    m[`agile_energy_${w}`] = [x.agile.energyGbp, "GBP"]; m[`flat_energy_${w}`] = [x.flat.energyGbp, "GBP"]; m[`agile_standing_${w}`] = [x.agile.standingGbp, "GBP"]; m[`flat_standing_${w}`] = [x.flat.standingGbp, "GBP"];
    m[`flat_unit_rate_min_ex_vat_${w}`] = [x.flatUnitRateRangeP[0], "p/kWh"]; m[`flat_unit_rate_max_ex_vat_${w}`] = [x.flatUnitRateRangeP[1], "p/kWh"]; m[`kwh_${w}`] = [x.kwh, "kWh"];
  }
  m.product_code = [FLAT_TARIFF.productCode, "code"]; m.coverage_complete = [windows.A.coverageComplete && windows.B.coverageComplete, "flag"];
  ctx.evidence.addMetrics(f.evidence.id, metricMap(m));
  const sentence = (w: "A" | "B") => { const x = windows[w]; return `${x.flatMinusAgileGbp >= 0 ? "£" + x.flatMinusAgileGbp.toFixed(2) + " more" : "£" + Math.abs(x.flatMinusAgileGbp).toFixed(2) + " less"} (£${x.flat.totalGbp.toFixed(2)} flat vs £${x.agile.totalGbp.toFixed(2)} Agile)`; };
  const text = `Historical counterfactual, not advice: on the same kWh, the flat ${FLAT_TARIFF.name} tariff (${FLAT_TARIFF.productCode}, region ${FLAT_TARIFF.region}) would have cost ${sentence("B")} in window B and ${sentence("A")} in window A, energy plus standing charge, VAT at the contract rate (SAMPLE meter data).`
    + (windows.A.coverageComplete && windows.B.coverageComplete ? "" : " Some half-hours had no flat rate or no Agile price and are left out of both sides.");
  return { ...base, ok: true, windows, sites: okSites, cheaperInWindowB, text, evidence: [f.evidence.id] };
}
