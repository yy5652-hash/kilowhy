// Synthetic data layer for tests: no Zetaris, fully deterministic. NOT a test file (it is imported by the *.test.ts files).
// All numbers are made up (maths tests), not meter data.
import { addDays } from "../bands.ts";
import type { ContractRow, CoverageRow, DailyRow, DataLayer, Fetched, FetchMeta, OpsEvent, QualityRow, SlotRow, TariffRow, Windows } from "../data.ts";
import { makeEvidence, type EvidenceSource, type Row } from "../evidence.ts";
import { WINDOW_A, WINDOW_B, type DateWindow } from "../windows.ts";
import { buildContext } from "./context.ts";
import type { HypCtx } from "./types.ts";

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

type Win = "A" | "B";
export interface SynthOpts {
  sites?: string[];
  siteNames?: Record<string, string>;
  /** kWh of a half-hour slot; `day` 0..27 within the window, `slot` 0..47 (UTC half-hour of day) */
  kwh?: (site: string, win: Win, day: number, slot: number, date: string) => number;
  price?: (win: Win, day: number, slot: number) => number;
  intensity?: (win: Win, day: number, slot: number) => number | null;
  wind?: (win: Win, day: number, slot: number) => number | null;
  gas?: (win: Win, day: number, slot: number) => number | null;
  imports?: (win: Win, day: number, slot: number) => number | null;
  temp?: (win: Win, day: number, date: string) => number;           // daily mean temperature, C
  ops?: OpsEvent[];
  contract?: ContractRow[];
  drop?: (site: string, win: Win, day: number, slot: number) => boolean; // omit these meter rows
  qualityIssues?: QualityRow[];
  /** flat comparison tariff: rate periods (UTC ISO bounds, `to` null = open), ex-VAT p/kWh and ex-VAT standing p/day; default one period at 30 p and 50 p/day */
  flat?: { from: string; to: string | null; excP: number; standingExc: number }[];
  noise?: number;                                                     // relative noise on kWh, default 0.01
  seed?: number;
}

export const DEFAULT_CONTRACT: ContractRow[] = [
  { src: "contract", productCode: "AGILE-24-10-01", tariffCode: "E-1R-AGILE-24-10-01-C", standingPencePerDay: 37.65, vatRate: 0.05, validFrom: "2026-08-27" },
  { src: "agile_standing", productCode: null, tariffCode: null, standingPencePerDay: 37.65, vatRate: null, validFrom: "2024-09-30" },
];

/** Daily temperature pattern that repeats in both windows (so HDD does not change between them). */
export const sameTemp = (_w: Win, day: number): number => 11 + 4 * Math.sin(day * 0.9) + (day % 3);

const slotIso = (date: string, slot: number): string => new Date(Date.parse(date + "T00:00:00Z") + slot * 1800e3).toISOString().replace(".000Z", "Z");

export interface Synth { data: DataLayer; rows: SlotRow[]; windows: Windows; sites: string[]; opts: SynthOpts }

export function synth(o: SynthOpts = {}): Synth {
  const sites = o.sites ?? ["S1"];
  const rnd = mulberry32(o.seed ?? 42);
  const noise = o.noise ?? 0.01;
  const kwhFn = o.kwh ?? ((_s, _w, _d, slot, date) => 0.6 + (slot >= 6 && slot < 18 ? 1.2 : 0) + (new Date(date + "T00:00:00Z").getUTCDay() === 0 ? -0.2 : 0));
  const priceFn = o.price ?? ((_w, day, slot) => (slot >= 32 && slot < 38 ? 35 : slot < 14 ? 12 : 22) + (day % 5));
  const rows: SlotRow[] = [];
  for (const [w, win] of [[WINDOW_A, "A"], [WINDOW_B, "B"]] as [DateWindow, Win][]) {
    for (let day = 0; day < w.days; day++) {
      const date = addDays(w.from, day);
      for (const site of sites) for (let slot = 0; slot < 48; slot++) {
        if (o.drop?.(site, win, day, slot)) continue;
        rows.push({
          site, ts: slotIso(date, slot), win, kwh: Math.max(0, kwhFn(site, win, day, slot, date) * (1 + (rnd() - 0.5) * 2 * noise)), p: priceFn(win, day, slot),
          intensity: o.intensity ? o.intensity(win, day, slot) : 100, windPct: o.wind ? o.wind(win, day, slot) : 30, gasPct: o.gas ? o.gas(win, day, slot) : 10, importsPct: o.imports ? o.imports(win, day, slot) : 15,
        });
      }
    }
  }
  const windows: Windows = { A: WINDOW_A, B: WINDOW_B };
  const tempFn = o.temp ?? sameTemp;

  const wrap = <T>(meta: FetchMeta, title: string, rowsT: T[], asRows: Row[], sources: EvidenceSource[]): Fetched<T> => ({
    rows: rowsT, evidence: makeEvidence(meta.store, { hypothesisId: meta.hypothesisId, title: meta.title || title, sql: `FAKE ${title}`, zetarisRunId: "fake-run", rows: asRows, sources }),
  });
  const mine = (sitesQ: string[]) => rows.filter((r) => sitesQ.includes(r.site));

  const data: DataLayer = {
    async siteIds() { return sites; },
    async siteInfo() { return sites.map((id) => ({ id, name: o.siteNames?.[id] ?? `Test Bakery ${id}` })); },
    async slots(q, meta) { const r = mine(q.sites); return wrap(meta, "slots", r, r as unknown as Row[], [{ view: "meter_hh", kind: "FILE: sample" }]); },
    async daily(q, meta) {
      const out: DailyRow[] = [];
      for (const site of q.sites) {
        const by = new Map<string, { kwh: number; n: number; win: Win; day: number }>();
        for (const r of rows.filter((x) => x.site === site)) { const d = r.ts.slice(0, 10); const e = by.get(d) ?? { kwh: 0, n: 0, win: r.win, day: Math.round((Date.parse(d + "T00:00:00Z") - Date.parse((r.win === "A" ? WINDOW_A : WINDOW_B).from + "T00:00:00Z")) / 864e5) }; e.kwh += r.kwh; e.n++; by.set(d, e); }
        for (const [date, e] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) out.push({ site, date, kwh: e.kwh, nSlots: e.n, tMean: tempFn(e.win, e.day, date), nHours: 24 });
      }
      return wrap(meta, "daily", out, out as unknown as Row[], [{ view: "meter_hh", kind: "FILE: sample" }, { view: "temp_hourly", kind: "REST: Open-Meteo" }]);
    },
    async opsLog(q, meta) { const r = (o.ops ?? []).filter((e) => q.sites.includes(e.siteId)); return wrap(meta, "ops", r, r as unknown as Row[], [{ view: "ops_log", kind: "FILE: sample" }]); },
    async contract(meta) { const r = o.contract ?? DEFAULT_CONTRACT; return wrap(meta, "contract", r, r as unknown as Row[], [{ view: "contract", kind: "FILE: sample" }, { view: "agile_standing", kind: "REST: Octopus" }]); },
    async quality(q, meta) {
      const summary: QualityRow[] = q.sites.map((s) => ({ check: "rows", site: s, start: "2026-08-27 00:00:00", end: "2026-10-21 23:30:00", n: rows.filter((r) => r.site === s).length, value: 0 }));
      const r = [...(o.qualityIssues ?? []).filter((i) => q.sites.includes(i.site)), ...summary];
      return wrap(meta, "quality", r, r as unknown as Row[], [{ view: "meter_hh", kind: "FILE: sample" }]);
    },
    async tariff(q, meta) {
      const periods = o.flat ?? [{ from: "2026-05-31T23:00:00Z", to: null, excP: 30, standingExc: 50 }];
      const out: TariffRow[] = [];
      for (const site of q.sites) for (const win of ["A", "B"] as Win[]) {
        const rs = rows.filter((r) => r.site === site && r.win === win);
        let n = 0, kwh = 0, agile = 0, flat = 0, standing = 0, lo = Infinity, hi = -Infinity;
        for (const r of rs) {
          const t = Date.parse(r.ts), per = periods.find((p) => t >= Date.parse(p.from) && (p.to === null || t < Date.parse(p.to)));
          if (!per) continue; // inner join: slots without a flat rate drop out, as in the Zetaris query
          n++; kwh += r.kwh; agile += r.kwh * r.p; flat += r.kwh * per.excP; standing += per.standingExc / 48; lo = Math.min(lo, per.excP); hi = Math.max(hi, per.excP);
        }
        if (n) out.push({ site, win, nSlots: n, kwh, agileIncPence: agile, flatExcPence: flat, flatStandingExcPence: standing, flatRateMinExc: lo, flatRateMaxExc: hi });
      }
      return wrap(meta, "tariff", out, out as unknown as Row[], [{ view: "meter_hh", kind: "FILE: sample" }, { view: "agile_rates", kind: "REST: Octopus" }, { view: "flat_tariff", kind: "REST: Octopus" }]);
    },
    async coverage(q, meta) {
      const out: CoverageRow[] = [];
      for (const site of q.sites) for (const win of ["A", "B"] as Win[]) {
        const rs = rows.filter((r) => r.site === site && r.win === win);
        if (rs.length) out.push({ site, win, nMeter: rs.length, nPriced: rs.length, nCarbon: rs.filter((r) => r.intensity !== null).length });
      }
      return wrap(meta, "coverage", out, out as unknown as Row[], [{ view: "meter_hh", kind: "FILE: sample" }]);
    },
  };
  return { data, rows, windows, sites, opts: o };
}

/** Builds the investigation context over a synthetic data layer. */
export function ctxFor(s: Synth, label?: string, sitesInScope?: string[]): Promise<HypCtx> {
  const sc = sitesInScope ?? s.sites;
  return buildContext({ data: s.data, scope: { label: label ?? (sc.length === 1 ? sc[0] : "ALL"), sites: sc }, windowA: WINDOW_A, windowB: WINDOW_B });
}
