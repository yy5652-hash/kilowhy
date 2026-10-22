// Clean baseline bakery site for the evaluation: the Crumb & Co generator (scripts/generate_sample.ts, SAMPLE data) for site S1 with the
// dated sample events switched off, driven by the REAL hourly temperature of the snapshot. Same seed as the sample (0xc0ffee), so the noise
// stream is the sample's S1 stream. kWh are SAMPLE data; price, carbon and weather come from eval/data/real_windows.json.
import { SITES, generateMeterRows, slotLoads, type Site } from "../scripts/generate_sample.ts";
import type { RealWindows } from "./real.ts";

export const EVAL_SITE_ID = "S1";
export const EVAL_SEED = 0xc0ffee;
export const N_SLOTS = 2688;          // 56 days x 48 half-hours: window A then window B
export const SLOTS_A = 1344;

export interface Baseline {
  site: Site;
  kwh: number[];       // clean metered kWh per slot (slot i = UTC half-hour i since the start of window A), 3 decimals
  heating: number[];   // heating component of kWh (modelled, before noise)
  oven: number[];      // oven component of kWh (modelled, before noise)
}

/** Hourly temperature map keyed "YYYY-MM-DDTHH" (UTC), the form the generator expects. */
export const tempMap = (real: RealWindows): Map<string, number> => new Map(real.temps.map((t) => [t.ts.slice(0, 13), t.tempC]));

export function buildBaseline(real: RealWindows, seed: number = EVAL_SEED): Baseline {
  const site = SITES.find((s) => s.site_id === EVAL_SITE_ID)!;
  const temps = tempMap(real);
  const rows = generateMeterRows(temps, seed, { plantedEvents: false }).filter((r) => r.site_id === EVAL_SITE_ID);
  if (rows.length !== N_SLOTS) throw new Error(`baseline has ${rows.length} slots, expected ${N_SLOTS}`);
  const loads = rows.map((r) => slotLoads(site, Date.parse(r.ts), temps, false));
  return { site, kwh: rows.map((r) => r.kwh), heating: loads.map((l) => l.heating), oven: loads.map((l) => l.oven) };
}
