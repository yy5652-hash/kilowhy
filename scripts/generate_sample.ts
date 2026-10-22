/**
 * SAMPLE DATA GENERATOR — synthetic electricity meter readings for
 * fictional bakery "Crumb & Co" (3 London sites). Not real meter data.
 * Temperature is real (Open-Meteo archive); kWh values are modelled.
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = join(ROOT, "data/cache/temp.json");
const OUT_DIR = join(ROOT, "data/sample");

const START_MS = Date.parse("2026-08-27T00:00:00Z");
const END_MS = Date.parse("2026-10-21T23:30:00Z");
const SLOT_MS = 30 * 60 * 1000;
export const SLOTS_PER_SITE = Math.floor((END_MS - START_MS) / SLOT_MS) + 1; // 2688
export const HEATING_BALANCE_C = 15.5;

const TEMP_URL =
  "https://archive-api.open-meteo.com/v1/archive?latitude=51.5072&longitude=-0.1276&start_date=2026-08-27&end_date=2026-10-21&hourly=temperature_2m&timezone=UTC";

export type SiteId = "S1" | "S2" | "S3";

export interface Site {
  site_id: SiteId;
  name: string;
  postcode: string;
  region: string;
  mpan_label: string;
  baseKwh: number;
  ovenKwh: number;
  heatingCoeff: number;
  ovenStartHour: number; // UTC weekday start
  ovenEndHour: number; // exclusive
  sundayOvenStart: number;
  sundayOvenEnd: number;
}

export const SITES: Site[] = [
  {
    site_id: "S1",
    name: "Crumb & Co Shoreditch",
    postcode: "E1 6AN",
    region: "London",
    mpan_label: "SAMPLE-MPAN-S1",
    baseKwh: 1.15,
    ovenKwh: 4.6,
    heatingCoeff: 0.09,
    ovenStartHour: 3,
    ovenEndHour: 9,
    sundayOvenStart: 4,
    sundayOvenEnd: 8,
  },
  {
    site_id: "S2",
    name: "Crumb & Co Brixton",
    postcode: "SW9 8PR",
    region: "London",
    mpan_label: "SAMPLE-MPAN-S2",
    baseKwh: 0.98,
    ovenKwh: 3.9,
    heatingCoeff: 0.08,
    ovenStartHour: 3,
    ovenEndHour: 9,
    sundayOvenStart: 4.5,
    sundayOvenEnd: 8,
  },
  {
    site_id: "S3",
    name: "Crumb & Co Hampstead",
    postcode: "NW3 1QE",
    region: "London",
    mpan_label: "SAMPLE-MPAN-S3",
    baseKwh: 0.82,
    ovenKwh: 3.2,
    heatingCoeff: 0.1,
    ovenStartHour: 3.5,
    ovenEndHour: 8.5,
    sundayOvenStart: 5,
    sundayOvenEnd: 8,
  },
];

const OPS_EVENTS = [
  {
    event_id: "E1",
    site_id: "S2" as SiteId,
    event_date: "2026-10-07",
    description:
      "SAMPLE: Oven schedule moved 2h later from this date (new sourdough line).",
  },
  {
    event_id: "E2",
    site_id: "S3" as SiteId,
    event_date: "2026-09-20",
    description:
      "SAMPLE: One-off freezer fault; extra kWh consumed all day.",
  },
  {
    event_id: "E3",
    site_id: "S1" as SiteId,
    event_date: "2026-10-03",
    description:
      "SAMPLE: Extra Saturday opening hours from this date.",
  },
];

/** Mulberry32 seeded PRNG — deterministic across runs. */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function isoSlot(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function dateKey(ms: number): string {
  return isoSlot(ms).slice(0, 10);
}

function utcHourFraction(ms: number): number {
  const d = new Date(ms);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

function weekdayUtc(ms: number): number {
  return new Date(ms).getUTCDay(); // 0=Sun
}

interface TempPayload {
  hourly: { time: string[]; temperature_2m: number[] };
}

export async function loadTemperatures(
  cachePath = CACHE_PATH,
): Promise<Map<string, number>> {
  let raw: string | undefined;
  try {
    await access(cachePath);
    raw = await readFile(cachePath, "utf8");
    console.log("SAMPLE: reusing cached temperature from", cachePath);
  } catch {
    console.log("SAMPLE: fetching real hourly temperature from Open-Meteo…");
    const res = await fetch(TEMP_URL);
    if (!res.ok) {
      throw new Error(`Open-Meteo fetch failed: ${res.status} ${res.statusText}`);
    }
    raw = await res.text();
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, raw);
    console.log("SAMPLE: cached temperature to", cachePath);
  }

  const data = JSON.parse(raw!) as TempPayload;
  const map = new Map<string, number>();
  const times = data.hourly.time;
  const temps = data.hourly.temperature_2m;
  for (let i = 0; i < times.length; i++) {
    // Open-Meteo returns "2026-08-27T00:00" — normalise to Z key by hour
    const key = times[i].length === 16 ? `${times[i]}:00Z` : times[i];
    map.set(key.slice(0, 13), temps[i]); // "2026-08-27T00"
  }
  return map;
}

function tempAt(temps: Map<string, number>, ms: number): number {
  const hourKey = isoSlot(ms).slice(0, 13); // YYYY-MM-DDTHH
  const t = temps.get(hourKey);
  if (t === undefined) {
    throw new Error(`Missing temperature for ${hourKey}`);
  }
  return t;
}

function ovenWindow(
  site: Site,
  ms: number,
  planted = true,
): { start: number; end: number } {
  const dow = weekdayUtc(ms);
  const date = dateKey(ms);
  let start = dow === 0 ? site.sundayOvenStart : site.ovenStartHour;
  let end = dow === 0 ? site.sundayOvenEnd : site.ovenEndHour;

  // S2: from 2026-10-07 oven schedule moved 2h later
  if (planted && site.site_id === "S2" && date >= "2026-10-07") {
    start += 2;
    end += 2;
  }
  return { start, end };
}

function ovenLoad(site: Site, ms: number, planted = true): number {
  const h = utcHourFraction(ms);
  const { start, end } = ovenWindow(site, ms, planted);
  if (h >= start && h < end) return site.ovenKwh;
  return 0;
}

/** Extra opening / fault loads planted as dated events. */
function eventLoad(site: Site, ms: number, planted = true): number {
  if (!planted) return 0;
  const date = dateKey(ms);
  const h = utcHourFraction(ms);
  const dow = weekdayUtc(ms);

  // S3 freezer fault all day 2026-09-20
  if (site.site_id === "S3" && date === "2026-09-20") {
    return 1.35;
  }

  // S1 extra Saturday opening hours from 2026-10-03 (extend evening trade)
  if (
    site.site_id === "S1" &&
    dow === 6 &&
    date >= "2026-10-03" &&
    h >= 16 &&
    h < 20
  ) {
    return 1.8;
  }

  return 0;
}

export interface MeterRow {
  site_id: SiteId;
  ts: string;
  kwh: number;
}

/** The modelled loads of one slot (kWh, before noise). `planted = false` leaves out the dated sample events (the clean baseline used by eval/). */
export function slotLoads(site: Site, ms: number, temps: Map<string, number>, planted = true): { base: number; oven: number; heating: number; events: number } {
  return {
    base: site.baseKwh,
    oven: ovenLoad(site, ms, planted),
    heating: site.heatingCoeff * Math.max(0, HEATING_BALANCE_C - tempAt(temps, ms)),
    events: eventLoad(site, ms, planted),
  };
}

export function generateMeterRows(
  temps: Map<string, number>,
  seed = 0xc0ffee,
  opts: { plantedEvents?: boolean } = {},
): MeterRow[] {
  const planted = opts.plantedEvents ?? true;
  const rand = mulberry32(seed);
  const rows: MeterRow[] = [];

  for (const site of SITES) {
    for (let ms = START_MS; ms <= END_MS; ms += SLOT_MS) {
      const { base, oven, heating, events } = slotLoads(site, ms, temps, planted);
      // Small relative noise ±4% of (base+oven), floored at 0
      const noiseAmp = 0.04 * (base + oven + 0.5);
      const noise = (rand() * 2 - 1) * noiseAmp;
      const kwh = Math.max(0, base + oven + heating + events + noise);
      rows.push({
        site_id: site.site_id,
        ts: isoSlot(ms),
        kwh: Math.round(kwh * 1000) / 1000,
      });
    }
  }
  return rows;
}

function csvEscape(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: Array<Array<string | number>>): string {
  const lines = [
    headers.join(","),
    ...rows.map((r) => r.map(csvEscape).join(",")),
  ];
  return lines.join("\n") + "\n";
}

export async function writeOutputs(rows: MeterRow[]): Promise<{
  totals: Record<SiteId, number>;
}> {
  await mkdir(OUT_DIR, { recursive: true });

  const meterCsv = toCsv(
    ["site_id", "ts", "kwh"],
    rows.map((r) => [r.site_id, r.ts, r.kwh.toFixed(3)]),
  );
  await writeFile(join(OUT_DIR, "meter_hh.csv"), meterCsv);

  const sitesCsv = toCsv(
    ["site_id", "name", "postcode", "region", "mpan_label"],
    SITES.map((s) => [s.site_id, s.name, s.postcode, s.region, s.mpan_label]),
  );
  await writeFile(join(OUT_DIR, "sites.csv"), sitesCsv);

  const opsCsv = toCsv(
    ["event_id", "site_id", "event_date", "description"],
    OPS_EVENTS.map((e) => [e.event_id, e.site_id, e.event_date, e.description]),
  );
  await writeFile(join(OUT_DIR, "ops_log.csv"), opsCsv);

  const contractCsv = toCsv(
    [
      "product_code",
      "tariff_code",
      "standing_charge_p_per_day",
      "vat_rate",
      "valid_from",
    ],
    [["AGILE-24-10-01", "E-1R-AGILE-24-10-01-C", 37.6525, 0.05, "2026-08-27"]],
  );
  await writeFile(join(OUT_DIR, "contract.csv"), contractCsv);

  const totals = { S1: 0, S2: 0, S3: 0 } as Record<SiteId, number>;
  for (const r of rows) totals[r.site_id] += r.kwh;
  return { totals };
}

export async function generateAll(): Promise<{
  rows: MeterRow[];
  totals: Record<SiteId, number>;
}> {
  const temps = await loadTemperatures();
  const rows = generateMeterRows(temps);
  if (rows.length !== SITES.length * SLOTS_PER_SITE) {
    throw new Error(
      `Expected ${SITES.length * SLOTS_PER_SITE} rows, got ${rows.length}`,
    );
  }
  const { totals } = await writeOutputs(rows);
  return { rows, totals };
}

async function main(): Promise<void> {
  console.log(
    "SAMPLE DATA: generating synthetic half-hourly kWh for Crumb & Co (3 sites)…",
  );
  console.log(`SAMPLE: window ${isoSlot(START_MS)} → ${isoSlot(END_MS)}`);
  console.log(`SAMPLE: ${SLOTS_PER_SITE} slots/site × ${SITES.length} sites`);

  const { totals } = await generateAll();

  console.log("SAMPLE: wrote CSVs under data/sample/");
  console.log("SAMPLE: total kWh per site (synthetic):");
  for (const site of SITES) {
    console.log(
      `  ${site.site_id} ${site.name}: ${totals[site.site_id].toFixed(3)} kWh`,
    );
  }
  console.log("SAMPLE: done. All meter kWh values are synthetic sample data.");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
