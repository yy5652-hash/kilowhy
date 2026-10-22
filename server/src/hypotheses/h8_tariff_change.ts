// H8 tariff_change: product code, tariff code or standing charge differs between the windows (or changes inside one).
import type { Hypothesis, Status } from "./types.ts";
import type { ContractRow } from "../data.ts";
import { contractFor } from "./context.ts";
import { fetchMeta, gbp, metricMap, result, signedGbp } from "./util.ts";

export interface H8Diff { productChanged: boolean; tariffChanged: boolean; standingChanged: boolean; midWindow: number }
export function decideH8(a: ContractRow | null, b: ContractRow | null, midWindow: number): { status: Status; diff: H8Diff } {
  if (!a || !b) return { status: "inconclusive", diff: { productChanged: false, tariffChanged: false, standingChanged: false, midWindow } };
  const diff: H8Diff = {
    productChanged: a.productCode !== b.productCode, tariffChanged: a.tariffCode !== b.tariffCode,
    standingChanged: a.standingPencePerDay !== b.standingPencePerDay, midWindow,
  };
  return { status: diff.productChanged || diff.tariffChanged || diff.standingChanged || midWindow > 0 ? "supported" : "ruled_out", diff };
}

export const H8: Hypothesis = {
  id: "H8", name: "tariff_change", title: "Tariff change",
  description: "Did the tariff change? Compares product code, tariff code and standing charge of the contract in force in each window (and checks the published Agile standing charge).",
  async run(ctx) {
    const f = await ctx.data.contract(fetchMeta(ctx, "H8", "Contract and standing charge by window"));
    const ca = contractFor(f.rows, ctx.windowA), cb = contractFor(f.rows, ctx.windowB);
    const { status, diff } = decideH8(ca.row, cb.row, ca.midWindowChanges.length + cb.midWindowChanges.length);
    const published = f.rows.filter((r) => r.src === "agile_standing" && r.validFrom >= ctx.windowA.from && r.validFrom < ctx.windowB.toExclusive);
    const latestPub = f.rows.filter((r) => r.src === "agile_standing" && r.validFrom < ctx.windowB.toExclusive).sort((x, y) => x.validFrom.localeCompare(y.validFrom)).pop();
    const s = ctx.decomposition.result;
    ctx.evidence.addMetrics(f.evidence.id, metricMap({
      standing_A: [ca.row?.standingPencePerDay ?? null, "p/day"], standing_B: [cb.row?.standingPencePerDay ?? null, "p/day"],
      product_A: [ca.row?.productCode ?? null, "code"], product_B: [cb.row?.productCode ?? null, "code"],
      standing_effect_S: [s ? gbp(s.standing) : null, "GBP"], published_standing_changes_in_span: [published.length, "rows"],
    }));
    const notes = ["rule: ruled out if product code, tariff code and standing charge are equal in both windows and no contract row starts inside a window"];
    if (latestPub && ca.row && latestPub.standingPencePerDay !== ca.row.standingPencePerDay) notes.push(`contract standing charge ${ca.row.standingPencePerDay} p/day differs from the published Agile standing charge ${latestPub.standingPencePerDay} p/day`);
    const sText = s ? `; standing-charge effect S = ${signedGbp(s.standing)}` : "";
    return result("H8", "tariff_change", status,
      status === "ruled_out" ? `unchanged: ${ca.row?.productCode}, standing ${ca.row?.standingPencePerDay} p/day in both windows${sText}` : status === "supported" ? `tariff or standing charge changed between the windows${sText}` : "no contract row in force for one of the windows",
      { product_A: ca.row?.productCode ?? null, product_B: cb.row?.productCode ?? null, standing_A_p_per_day: ca.row?.standingPencePerDay ?? null, standing_B_p_per_day: cb.row?.standingPencePerDay ?? null, standing_effect_gbp: s ? gbp(s.standing) : null, changes_inside_a_window: diff.midWindow },
      [f.evidence.id, ...(ctx.decomposition.contractEvidenceId ? [ctx.decomposition.contractEvidenceId] : [])], notes, { diff });
  },
};
