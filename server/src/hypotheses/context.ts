// Builds the shared context of one investigation: fetches slots + contract in Zetaris (one federated query each), aligns window A with B,
// runs the exact decomposition, and records it as DECOMP evidence. Also holds the slot-alignment and contract helpers.
import { decompose, sum, type Slot } from "../decompose.ts";
import type { ContractRow, DataLayer, SlotRow } from "../data.ts";
import { EvidenceStore } from "../evidence.ts";
import { addDays } from "../bands.ts";
import { slotsInWindow, type DateWindow } from "../windows.ts";
import type { Aligned, Decomp, HypCtx, Scope, SlotAgg } from "./types.ts";
import { gbp, metricMap } from "./util.ts";

/** Sums kWh over the scope's sites per half-hour and aligns slot i of A with slot i of B; slots missing at any site (or in either window) are dropped. */
export function alignSlots(rows: SlotRow[], sites: string[], a: DateWindow, b: DateWindow): Aligned {
  const expected = slotsInWindow(a);
  const bucket = (w: DateWindow): Map<number, SlotAgg> => {
    const from = Date.parse(w.from + "T00:00:00Z");
    const per = new Map<number, { agg: SlotAgg; seen: Set<string> }>();
    for (const r of rows) {
      if (r.win !== w.id || !sites.includes(r.site)) continue;
      const off = Math.round((Date.parse(r.ts) - from) / 1800e3);
      if (off < 0 || off >= slotsInWindow(w)) continue;
      let e = per.get(off);
      if (!e) { e = { agg: { ts: r.ts, kwh: 0, p: r.p, intensity: r.intensity, windPct: r.windPct, gasPct: r.gasPct, importsPct: r.importsPct }, seen: new Set() }; per.set(off, e); }
      if (e.seen.has(r.site)) continue; // duplicate row for the same site and slot: keep the first
      e.seen.add(r.site); e.agg.kwh += r.kwh;
    }
    const out = new Map<number, SlotAgg>();
    for (const [off, e] of per) if (e.seen.size === sites.length) out.set(off, e.agg);
    return out;
  };
  const ma = bucket(a), mb = bucket(b);
  const offs = [...ma.keys()].filter((o) => mb.has(o)).sort((x, y) => x - y);
  return { A: offs.map((o) => ma.get(o)!), B: offs.map((o) => mb.get(o)!), expected, kept: offs.length };
}

export interface EffectiveContract { row: ContractRow | null; midWindowChanges: ContractRow[] }
/** Contract row in force at the start of a window (latest valid_from <= start), plus any row that starts inside the window. */
export function contractFor(rows: ContractRow[], w: DateWindow): EffectiveContract {
  const own = rows.filter((r) => r.src === "contract");
  const upto = own.filter((r) => r.validFrom < w.toExclusive).sort((x, y) => x.validFrom.localeCompare(y.validFrom));
  const before = upto.filter((r) => r.validFrom <= w.from);
  const row = before.length ? before[before.length - 1] : upto[0] ?? null;
  return { row, midWindowChanges: upto.filter((r) => r.validFrom > w.from && r !== row) };
}

export const toDecompSlots = (s: SlotAgg[], pick: (x: SlotAgg) => number): Slot[] => s.map((x) => ({ ts: x.ts, kwh: x.kwh, p: pick(x) }));

export interface BuildArgs { data: DataLayer; scope: Scope; windowA: DateWindow; windowB: DateWindow; evidence?: EvidenceStore }

export async function buildContext(args: BuildArgs): Promise<HypCtx> {
  const { data, scope, windowA, windowB } = args;
  const evidence = args.evidence ?? new EvidenceStore();
  const windows = { A: windowA, B: windowB };
  const slotsF = await data.slots({ sites: scope.sites, windows }, { store: evidence, hypothesisId: "DECOMP", title: `Half-hourly meter x Agile price x carbon, ${scope.label}, windows A and B` });
  const contractF = await data.contract({ store: evidence, hypothesisId: "DECOMP", title: "Contract and standing charge" });
  const aligned = alignSlots(slotsF.rows, scope.sites, windowA, windowB);
  const warnings: string[] = [];
  const ca = contractFor(contractF.rows, windowA), cb = contractFor(contractF.rows, windowB);
  const standing = { A: ca.row?.standingPencePerDay ?? 0, B: cb.row?.standingPencePerDay ?? 0 };
  if (!ca.row || !cb.row) warnings.push("no contract row in force: standing charge taken as 0");
  if (aligned.kept < aligned.expected) warnings.push(`only ${aligned.kept} of ${aligned.expected} slots are present for all sites in both windows`);

  const n = scope.sites.length;
  const wa = { slots: toDecompSlots(aligned.A, (x) => x.p), days: windowA.days, standingPencePerDay: standing.A * n };
  const wb = { slots: toDecompSlots(aligned.B, (x) => x.p), days: windowB.days, standingPencePerDay: standing.B * n };
  const r = decompose(wa, wb);
  const decomp: Decomp = {
    ok: r.ok, error: r.ok ? undefined : r.message, result: r.ok ? r : null, windowA: wa, windowB: wb, aligned, standing,
    evidenceId: slotsF.evidence.id, contractEvidenceId: contractF.evidence.id, warnings,
  };
  if (r.ok) {
    evidence.addMetrics(slotsF.evidence.id, metricMap({
      slots_aligned: [aligned.kept, "slots"],
      kwh_A: [r.QA, "kWh"], kwh_B: [r.QB, "kWh"], cost_A: [gbp(r.CA), "GBP"], cost_B: [gbp(r.CB), "GBP"],
      avg_price_A: [r.pbarA, "p/kWh"], avg_price_B: [r.pbarB, "p/kWh"], avg_price_B_on_A_shape: [r.pbarBStar, "p/kWh"],
      delta_total: [gbp(r.deltaTotal), "GBP"], volume_V: [gbp(r.volume), "GBP"], price_L: [gbp(r.price), "GBP"], timing_T: [gbp(r.timing), "GBP"], standing_S: [gbp(r.standing), "GBP"],
      identity_error: [r.identityError, "pence"],
    }));
    evidence.addMetrics(contractF.evidence.id, metricMap({ standing_A: [standing.A, "p/day/site"], standing_B: [standing.B, "p/day/site"] }));
  }
  return { scope, sites: scope.sites, windowA, windowB, decomposition: decomp, data, evidence };
}

/** Same slot fetch as the decomposition (cached by the data layer), with its own evidence record for the calling hypothesis. */
export async function loadSlots(ctx: HypCtx, hypothesisId: string, title: string) {
  const f = await ctx.data.slots({ sites: ctx.sites, windows: { A: ctx.windowA, B: ctx.windowB } }, { store: ctx.evidence, hypothesisId, title });
  return { rows: f.rows, evidence: f.evidence, aligned: alignSlots(f.rows, ctx.sites, ctx.windowA, ctx.windowB) };
}

export const dayKeys = (w: DateWindow): string[] => Array.from({ length: w.days }, (_, i) => addDays(w.from, i));
export { sum };
