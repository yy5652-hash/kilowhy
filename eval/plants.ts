// Planted causes. Each plant changes the clean baseline series in a known way; the scenario's truth labels are derived from these definitions.
// Slot i = UTC half-hour i since 2026-08-27T00:00Z (window A = 0..1343, window B = 1344..2687). All kWh are SAMPLE data.
import { addDays } from "../server/src/bands.ts";
import type { ContractRow, OpsEvent } from "../server/src/data.ts";
import { WINDOW_A } from "../server/src/windows.ts";
import { N_SLOTS, EVAL_SITE_ID, type Baseline } from "./baseline.ts";

export type Plant =
  | { kind: "heating"; from: string; factor: number }                                  // heating kWh x factor from this UTC date (the building responds more to cold)
  | { kind: "step"; from: string; kwhPerDay: number; slots: [number, number]; event: string } // +/- kWh per day spread over UTC half-hours [s0, s1), with a logged ops event
  | { kind: "shift"; from: string; hours: number; event: string }                       // oven load moved `hours` later from this date (energy neutral)
  | { kind: "fault_day"; date: string; kwhPerSlot: number; event: string }              // extra kWh in every half-hour of one day
  | { kind: "zero_run"; date: string; fromSlot: number; slots: number }                 // meter reads 0 for `slots` half-hours
  | { kind: "flatline"; date: string; fromSlot: number; slots: number }                 // meter repeats its previous reading for `slots` half-hours
  | { kind: "gap"; date: string; fromSlot: number; slots: number }                      // meter rows missing
  | { kind: "standing"; from: string; pencePerDay: number };                            // standing charge changes

export type Cause = "heating" | "step" | "shift" | "fault_day" | "zero_run" | "flatline";
export interface Part { cause: Cause; plantIndex: number; delta: number[] }             // kWh change this plant made to each slot

export interface Planted {
  kwh: number[];                 // final metered kWh per slot (gaps still hold their value; see `dropped`)
  heating: number[];             // heating kWh per slot after any sensitivity plant (the weather-driven part, truth for H3)
  parts: Part[];
  dropped: boolean[];            // meter rows that do not exist
  ops: OpsEvent[];
  contract: ContractRow[];
  standingPencePerDay: { A: number; B: number };
}

export const BASE_STANDING_P = 37.6525;
export const dateOfSlot = (i: number): string => addDays(WINDOW_A.from, Math.floor(i / 48));
export const slotOfDate = (date: string, slot = 0): number => Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(WINDOW_A.from + "T00:00:00Z")) / 864e5) * 48 + slot;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;

/** Contract rows as the sample contract.csv plus the published Agile standing charge (real); a standing plant adds a contract row valid from its date. */
function contractRows(plants: Plant[]): ContractRow[] {
  const rows: ContractRow[] = [
    { src: "contract", productCode: "AGILE-24-10-01", tariffCode: "E-1R-AGILE-24-10-01-C", standingPencePerDay: BASE_STANDING_P, vatRate: 0.05, validFrom: WINDOW_A.from },
    { src: "agile_standing", productCode: null, tariffCode: null, standingPencePerDay: BASE_STANDING_P, vatRate: null, validFrom: "2024-09-30" },
  ];
  for (const p of plants) if (p.kind === "standing") rows.push({ src: "contract", productCode: "AGILE-24-10-01", tariffCode: "E-1R-AGILE-24-10-01-C", standingPencePerDay: p.pencePerDay, vatRate: 0.05, validFrom: p.from });
  return rows;
}

export function applyPlants(base: Baseline, plants: Plant[]): Planted {
  const heating = [...base.heating];
  const delta = (): number[] => new Array(N_SLOTS).fill(0);
  const parts: Part[] = [];
  const ops: OpsEvent[] = [];
  const dropped = new Array<boolean>(N_SLOTS).fill(false);
  const overrides: { plantIndex: number; cause: "zero_run" | "flatline"; from: number; n: number }[] = [];
  const addEvent = (date: string, description: string) => ops.push({ eventId: `E${ops.length + 1}`, siteId: EVAL_SITE_ID, eventDate: date, description: `SAMPLE: ${description}` });

  plants.forEach((p, plantIndex) => {
    if (p.kind === "standing") return;
    const d = delta();
    if (p.kind === "heating") {
      for (let i = 0; i < N_SLOTS; i++) if (dateOfSlot(i) >= p.from) { d[i] = (p.factor - 1) * base.heating[i]; heating[i] = base.heating[i] * p.factor; }
      parts.push({ cause: "heating", plantIndex, delta: d });
    } else if (p.kind === "step") {
      const n = p.slots[1] - p.slots[0];
      for (let i = 0; i < N_SLOTS; i++) if (dateOfSlot(i) >= p.from && i % 48 >= p.slots[0] && i % 48 < p.slots[1]) d[i] = p.kwhPerDay / n;
      parts.push({ cause: "step", plantIndex, delta: d }); addEvent(p.from, p.event);
    } else if (p.kind === "shift") {
      for (let i = 0; i < N_SLOTS; i++) {
        if (dateOfSlot(i) < p.from || base.oven[i] === 0) continue;
        const j = i + p.hours * 2;
        if (Math.floor(j / 48) !== Math.floor(i / 48)) throw new Error(`oven shift of ${p.hours} h leaves the day at slot ${i}`);
        d[i] -= base.oven[i]; d[j] += base.oven[i];
      }
      parts.push({ cause: "shift", plantIndex, delta: d }); addEvent(p.from, p.event);
    } else if (p.kind === "fault_day") {
      for (let k = 0; k < 48; k++) d[slotOfDate(p.date, k)] = p.kwhPerSlot;
      parts.push({ cause: "fault_day", plantIndex, delta: d }); addEvent(p.date, p.event);
    } else if (p.kind === "gap") {
      for (let k = 0; k < p.slots; k++) dropped[slotOfDate(p.date, p.fromSlot + k)] = true;
    } else overrides.push({ plantIndex, cause: p.kind, from: slotOfDate(p.date, p.fromSlot), n: p.slots });
  });

  const kwh = base.kwh.map((x, i) => Math.max(0, r3(x + parts.reduce((s, q) => s + q.delta[i], 0))));
  for (const o of overrides) {
    const before = [...kwh];
    const held = o.cause === "flatline" ? kwh[o.from - 1] : 0;
    for (let k = 0; k < o.n; k++) kwh[o.from + k] = held;
    parts.push({ cause: o.cause, plantIndex: o.plantIndex, delta: kwh.map((x, i) => x - before[i]) });
  }
  const standing = plants.filter((p): p is Extract<Plant, { kind: "standing" }> => p.kind === "standing");
  const standingB = standing.length ? standing[standing.length - 1].pencePerDay : BASE_STANDING_P;
  return { kwh, heating, parts, dropped, ops, contract: contractRows(plants), standingPencePerDay: { A: BASE_STANDING_P, B: standingB } };
}
