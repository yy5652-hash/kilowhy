// Cause identification: beyond the status, did the library name the planted cause (the right event, day, change point)? Reported next to the scores, not part of precision/recall.
import { THRESHOLDS as T } from "../server/src/hypotheses/thresholds.ts";
import type { HypothesisResult } from "../server/src/hypotheses/types.ts";
import { WINDOW_B } from "../server/src/windows.ts";
import type { ScenarioRun } from "./run.ts";

export interface Identification { scenario: number; cause: string; found: boolean | null; detail: string }
const days = (a: string, b: string): number => Math.abs(Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(b + "T00:00:00Z")) / 864e5));

export function identify(run: ScenarioRun): Identification[] {
  const n = run.scenario.n, res = (id: string): HypothesisResult => run.results.find((r) => r.id === id)!;
  const out: Identification[] = [];
  const events = run.planted.ops;
  run.scenario.plants.forEach((p) => {
    switch (p.kind) {
      case "step": {
        const ev = events.find((e) => e.eventDate === p.from && e.description.includes(p.event))!;
        const steps = String(res("H4").summary.steps).split(",");
        out.push({ scenario: n, cause: `operational step ${p.kwhPerDay > 0 ? "+" : ""}${p.kwhPerDay} kWh/day from ${p.from}`, found: steps.includes(ev.eventId), detail: `H4 events with a daily-kWh step: ${res("H4").summary.steps}; planted event ${ev.eventId}` });
        break;
      }
      case "shift": {
        const s = res("H5").summary, cp = s.schedule_shift_change_point as string | null;
        out.push({ scenario: n, cause: `oven schedule shift from ${p.from}`, found: s.schedule_shift_detected === true && cp !== null && days(cp, p.from) <= T.H5_EVENT_DAYS, detail: `H5 schedule shift detected: ${s.schedule_shift_detected}, band ${s.schedule_shift_band}, change point ${cp} (planted ${p.from})` });
        break;
      }
      case "fault_day": {
        const inB = p.date >= WINDOW_B.from;
        const h6 = res("H6").summary, flagged = ((res("H11").details?.flagged as { date: string }[] | undefined) ?? []).map((a) => a.date);
        out.push({ scenario: n, cause: `one-off fault day ${p.date}`, found: flagged.includes(p.date), detail: `H11 flagged days: ${flagged.join(", ") || "none"}` });
        out.push({ scenario: n, cause: `one-off fault day ${p.date} as H6's day`, found: inB ? h6.top_day === p.date : h6.opposite_day === p.date, detail: inB ? `H6 largest day ${h6.top_day}` : `H6 opposite day ${h6.opposite_day} (a baseline-window fault works against the increase; largest day in the direction of the change: ${h6.top_day})` });
        break;
      }
      case "zero_run": case "flatline": {
        const issues = (res("H7").details?.issues as { check: string; start: string }[] | undefined) ?? [];
        out.push({ scenario: n, cause: `${p.kind === "zero_run" ? "zero run" : "flatline"} on ${p.date}`, found: issues.some((i) => i.check === p.kind && i.start.slice(0, 10) === p.date), detail: `H7 issues: ${issues.map((i) => `${i.check} ${i.start.slice(0, 16)}`).join("; ") || "none"}` });
        if (p.kind === "zero_run") {
          const flagged = ((res("H11").details?.flagged as { date: string }[] | undefined) ?? []).map((a) => a.date);
          out.push({ scenario: n, cause: `zero-run day ${p.date} as an unusual day`, found: flagged.includes(p.date), detail: `H11 flagged days: ${flagged.join(", ") || "none"}` });
        }
        break;
      }
      case "gap": out.push({ scenario: n, cause: `missing meter rows on ${p.date}`, found: res("H9").status === "supported" && res("H7").status === "supported", detail: `H9 ${res("H9").status}, H7 ${res("H7").status}: ${res("H9").headline}` }); break;
      case "standing": out.push({ scenario: n, cause: `standing charge change from ${p.from}`, found: res("H8").status === "supported" && Math.abs((res("H8").summary.standing_effect_gbp as number) - run.truth.S / 100) < 0.011, detail: `H8 ${res("H8").status}; standing effect S ${res("H8").summary.standing_effect_gbp} GBP (true ${(run.truth.S / 100).toFixed(2)})` }); break;
      case "heating": {
        const est = res("H3").summary.v_weather_gbp as number, tru = run.truth.weatherEffect / 100;
        out.push({ scenario: n, cause: `heating sensitivity x${p.factor} from ${p.from}`, found: null, detail: `H3 weather volume estimate £${est.toFixed(2)} vs true £${tru.toFixed(2)} (ratio ${(est / tru).toFixed(2)})` });
        break;
      }
    }
  });
  return out;
}
