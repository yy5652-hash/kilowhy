// H10 carbon (Q3): the same exact decomposition with grid carbon intensity (gCO2/kWh, NESO London) in place of price.
// V_c = volume (more kWh at the old average intensity), L_c = intensity level (new intensity on the old shape), T_c = timing (usage moved between clean and dirty slots).
// Location-based Scope 2 estimate. Meter kWh are SAMPLE data.
import { decompose } from "../decompose.ts";
import type { Hypothesis, Status } from "./types.ts";
import { THRESHOLDS as T } from "./thresholds.ts";
import { loadSlots } from "./context.ts";
import { gradeEffect, metricMap, pctText, result, round, unavailable } from "./util.ts";

export type Component = "volume" | "intensity_level" | "timing";
export interface H10Decision { status: Status; components: Record<Component, { kg: number; share: number; status: Status }> }
/** Per component like H1 (same direction as the change, >= 20% of |dE|). Overall: ruled_out if emissions did not rise, supported if any component qualifies, else inconclusive. */
export function decideH10(volumeKg: number, levelKg: number, timingKg: number, deltaKg: number): H10Decision {
  const c = (kg: number) => { const g = gradeEffect(kg, deltaKg, T.H10_SHARE); return { kg, share: g.share, status: g.status }; };
  const components = { volume: c(volumeKg), intensity_level: c(levelKg), timing: c(timingKg) };
  let status: Status;
  if (deltaKg === 0) status = "inconclusive";
  else if (deltaKg < 0) status = "ruled_out";
  else status = Object.values(components).some((x) => x.status === "supported") ? "supported" : "inconclusive";
  return { status, components };
}

export const H10: Hypothesis = {
  id: "H10", name: "carbon", title: "Carbon emissions",
  description: "Why were emissions higher? The same exact decomposition applied to grid carbon intensity (gCO2/kWh): volume, intensity level and timing effects in kgCO2e, window B vs A.",
  async run(ctx) {
    const d = ctx.decomposition;
    if (!d.ok) return unavailable("H10", "carbon", d.error ?? "decomposition unavailable");
    const { evidence: ev, aligned } = await loadSlots(ctx, "H10", `Carbon emissions decomposition (${ctx.scope.label})`);
    const missing = [...aligned.A, ...aligned.B].filter((s) => s.intensity === null).length;
    if (missing > 0) return unavailable("H10", "carbon", `carbon intensity missing for ${missing} slots`, [ev.id]);
    const win = (slots: typeof aligned.A, days: number) => ({ slots: slots.map((s) => ({ ts: s.ts, kwh: s.kwh, p: s.intensity as number })), days, standingPencePerDay: 0 });
    const r = decompose(win(aligned.A, ctx.windowA.days), win(aligned.B, ctx.windowB.days));
    if (!r.ok) return unavailable("H10", "carbon", r.message, [ev.id]);
    const kg = (g: number) => g / 1000;
    const dE = kg(r.deltaTotal);
    const dec = decideH10(kg(r.volume), kg(r.price), kg(r.timing), dE);
    ctx.evidence.addMetrics(ev.id, metricMap({
      emissions_A: [kg(r.CA), "kgCO2e"], emissions_B: [kg(r.CB), "kgCO2e"], delta_emissions: [dE, "kgCO2e"],
      avg_intensity_A: [r.pbarA, "gCO2/kWh"], avg_intensity_B: [r.pbarB, "gCO2/kWh"], avg_intensity_B_on_A_shape: [r.pbarBStar, "gCO2/kWh"],
      volume_Vc: [kg(r.volume), "kgCO2e"], intensity_level_Lc: [kg(r.price), "kgCO2e"], timing_Tc: [kg(r.timing), "kgCO2e"], identity_error: [r.identityError, "g"],
    }));
    const part = (k: Component, label: string) => `${label} ${round(dec.components[k].kg, 1)} (${pctText(dec.components[k].share)})`;
    return result("H10", "carbon", dec.status,
      `emissions ${round(kg(r.CA), 1)} -> ${round(kg(r.CB), 1)} kgCO2e (${dE >= 0 ? "+" : ""}${round(dE, 1)}): ${part("volume", "volume")}, ${part("intensity_level", "intensity level")}, ${part("timing", "timing")} kg`,
      { emissions_A_kg: round(kg(r.CA), 3), emissions_B_kg: round(kg(r.CB), 3), delta_kg: round(dE, 3), volume_kg: round(dec.components.volume.kg, 3), intensity_level_kg: round(dec.components.intensity_level.kg, 3), timing_kg: round(dec.components.timing.kg, 3),
        volume_status: dec.components.volume.status, intensity_level_status: dec.components.intensity_level.status, timing_status: dec.components.timing.status, avg_intensity_A: round(r.pbarA, 2), avg_intensity_B: round(r.pbarB, 2) },
      [ev.id], [`rule per component like H1: same direction as the change and >= ${T.H10_SHARE * 100}% of |change|; ruled out if emissions did not rise`, "location-based Scope 2 estimate from regional carbon intensity; meter kWh are SAMPLE data"], { components: dec.components });
  },
};
