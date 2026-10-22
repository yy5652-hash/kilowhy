// D2a real-data run: exact bill-change decomposition (volume / price / timing / standing + weather split of volume)
// for window A (2026-08-27..09-23) vs window B (2026-09-24..10-21), per site and all sites combined.
// Data comes from Zetaris SQL. Meter kWh are SAMPLE data; Agile prices and temperatures are real public data.
// Output: eval/decompose_d2.json. Exit code 1 if an identity or reconciliation check fails.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { zsql } from "./zetaris_client.ts";
import {
  decompose, weatherSplit, topDayShare, dailyDeltaCost, allocateRounded, sum,
  type Slot, type Window, type DailyPoint, type DecomposeOk, type WeatherSplit,
} from "../server/src/decompose.ts";

const A = { from: "2026-08-27", to: "2026-09-24" } as const; // [from, to) UTC, 28 days, starts Thursday
const B = { from: "2026-09-24", to: "2026-10-22" } as const;
const DAYS = 28, SLOTS = DAYS * 48, HDD_BASE_C = 15.5;
const ts = (d: string) => `timestamp '${d} 00:00:00'`;
const iso = (z: string) => z.replace(" ", "T").replace(/\.0+$/, "") + "Z";

const sqlText = {
  contract: `SELECT standing_charge_p_per_day FROM kilowhy.contract`,
  slots: (w: { from: string; to: string }) =>
    `SELECT m.site_id, m.ts, m.kwh, r.p_kwh_inc_vat AS p\nFROM kilowhy.meter_hh m JOIN kilowhy.agile_rates r ON m.ts = r.slot_start\nWHERE m.ts >= ${ts(w.from)} AND m.ts < ${ts(w.to)}\nORDER BY m.site_id, m.ts`,
  dailyKwh: `SELECT site_id, CAST(ts AS DATE) AS d, SUM(kwh) AS kwh FROM kilowhy.meter_hh\nWHERE ts >= ${ts(A.from)} AND ts < ${ts(B.to)}\nGROUP BY 1, 2 ORDER BY 1, 2`,
  dailyTemp: `SELECT CAST(ts AS DATE) AS d, AVG(temp_c) AS t_mean, COUNT(*) AS n FROM kilowhy.temp_hourly\nWHERE ts >= ${ts(A.from)} AND ts < ${ts(B.to)}\nGROUP BY 1 ORDER BY 1`,
};

async function run(name: string, sql: string): Promise<{ rows: string[][]; runId: string }> {
  const z = await zsql(sql);
  if (!z.ok || !Array.isArray(z.body?.data)) { console.error(`Zetaris query "${name}" failed`, JSON.stringify(z.body).slice(0, 400)); process.exit(2); }
  return { rows: z.body.data, runId: z.runId };
}

const checks: { check: string; pass: boolean; detail?: string }[] = [];
const check = (name: string, pass: boolean, detail?: string) => { checks.push({ check: name, pass, detail }); if (!pass) console.error(`CHECK FAIL: ${name} ${detail ?? ""}`); };

// ---- load
const contract = await run("contract", sqlText.contract);
const sc = Number(contract.rows[0][0]); // pence/day inc VAT
const sA = await run("slots_A", sqlText.slots(A));
const sB = await run("slots_B", sqlText.slots(B));
const dK = await run("daily_kwh", sqlText.dailyKwh);
const dT = await run("daily_temp", sqlText.dailyTemp);

const bySite = (rows: string[][]) => {
  const m = new Map<string, Slot[]>();
  for (const [site, t, kwh, p] of rows) (m.get(site) ?? m.set(site, []).get(site)!).push({ ts: iso(t), kwh: Number(kwh), p: Number(p) });
  return m;
};
const slotsA = bySite(sA.rows), slotsB = bySite(sB.rows);
const sites = [...slotsA.keys()].sort();
check("same sites in both windows", JSON.stringify(sites) === JSON.stringify([...slotsB.keys()].sort()), sites.join(","));

// ---- alignment: every window has 1344 half-hours, slot i of B is exactly 28 days after slot i of A
for (const s of sites) {
  const a = slotsA.get(s)!, b = slotsB.get(s)!;
  const aligned = a.length === SLOTS && b.length === SLOTS && a.every((x, i) => Date.parse(b[i].ts) - Date.parse(x.ts) === DAYS * 864e5 && (i === 0 || Date.parse(x.ts) - Date.parse(a[i - 1].ts) === 1800e3));
  check(`${s} windows aligned (${SLOTS} slots, +28 days)`, aligned, `${a.length}/${b.length}`);
}

// ---- daily series (kWh per site, HDD from daily mean temperature)
const temp = new Map<string, number>();
let tempOk = true;
for (const [d, t, n] of dT.rows) { temp.set(d, Number(t)); if (Number(n) !== 24) tempOk = false; }
check("24 hourly temperatures per day", tempOk && temp.size === 2 * DAYS, `${temp.size} days`);
const hdd = (d: string) => Math.max(0, HDD_BASE_C - (temp.get(d) ?? NaN));
const dayKwh = new Map<string, Map<string, number>>();
for (const [site, d, kwh] of dK.rows) (dayKwh.get(site) ?? dayKwh.set(site, new Map()).get(site)!).set(d, Number(kwh));
const addDays = (d: string, n: number) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const dailySeries = (kwhOf: (d: string) => number, from: string): DailyPoint[] =>
  Array.from({ length: DAYS }, (_, i) => { const date = addDays(from, i); return { date, kwh: kwhOf(date), hdd: hdd(date) }; });

// ---- decompose one scope (a site or all sites combined)
const stage = (a: Slot[], b: Slot[], sites_: number): { A: Window; B: Window } => ({
  A: { slots: a, days: DAYS, standingPencePerDay: sc * sites_ },
  B: { slots: b, days: DAYS, standingPencePerDay: sc * sites_ },
});
const combine = (ws: Slot[][]): Slot[] => ws[0].map((s, i) => ({ ts: s.ts, kwh: sum(ws.map((w) => w[i].kwh)), p: s.p }));

const scopes: { site: string; scope: "site" | "all"; a: Slot[]; b: Slot[]; n: number; kwhOf: (d: string) => number }[] = sites.map((s) => ({
  site: s, scope: "site", a: slotsA.get(s)!, b: slotsB.get(s)!, n: 1, kwhOf: (d) => dayKwh.get(s)?.get(d) ?? NaN,
}));
scopes.push({
  site: "ALL", scope: "all", a: combine(sites.map((s) => slotsA.get(s)!)), b: combine(sites.map((s) => slotsB.get(s)!)), n: sites.length,
  kwhOf: (d) => sum(sites.map((s) => dayKwh.get(s)?.get(d) ?? NaN)),
});
// prices must be identical across sites for the combined series to be valid
check("combined series uses one price per slot", sites.every((s) => slotsA.get(s)!.every((x, i) => x.p === slotsA.get(sites[0])![i].p)));

const recon = JSON.parse(readFileSync(new URL("../eval/reconciliation.json", import.meta.url), "utf8"));
const gbp = (pence: number) => Math.round(pence) / 100;
const results: any[] = [];
for (const sc_ of scopes) {
  const w = stage(sc_.a, sc_.b, sc_.n);
  const d = decompose(w.A, w.B);
  if (!d.ok) { check(`${sc_.site} decompose`, false, d.message); continue; }
  const dailyA = dailySeries(sc_.kwhOf, A.from), dailyB = dailySeries(sc_.kwhOf, B.from);
  // daily kWh from Zetaris must equal the sum of the half-hourly slots that went into the decomposition
  check(`${sc_.site} daily kWh = slot kWh`, Math.abs(sum(dailyA.map((x) => x.kwh)) - d.QA) < 1e-6 && Math.abs(sum(dailyB.map((x) => x.kwh)) - d.QB) < 1e-6);
  const wx = weatherSplit(dailyA, dailyB, d.pbarA);
  if (!wx.ok) { check(`${sc_.site} weatherSplit`, false, wx.message); continue; }
  check(`${sc_.site} identityError < 1e-6 pence`, d.identityError < 1e-6, String(d.identityError));
  check(`${sc_.site} weather volume = decompose volume`, Math.abs(wx.volume - d.volume) < 1e-6);
  // cross-check energy cost against eval/reconciliation.json (one federated SQL, to the penny); standing excluded there
  if (sc_.scope === "site") {
    for (const [win, c] of [["A", d.CA], ["B", d.CB]] as const) {
      const r = recon.rows.find((x: any) => x.site === sc_.site && x.window === win);
      check(`${sc_.site} C_${win} matches reconciliation.json`, !!r && gbp(c) === r.cost_gbp_zetaris, `${gbp(c)} vs ${r?.cost_gbp_zetaris}`);
    }
  } else {
    // combined energy cost = sum of the per-site costs (each of which matches reconciliation.json)
    for (const [win, c] of [["A", d.CA], ["B", d.CB]] as const) {
      const siteSum = sum(results.filter((r) => r.scope === "site").map((r) => r.raw_pence[`C_${win}`]));
      check(`ALL C_${win} = sum of site C_${win}`, Math.abs(c - siteSum) < 1e-6, `${c} vs ${siteSum}`);
    }
  }
  // diagnostic only: re-fit on A+B pooled (window A alone has almost no heating days, see weather.warnings)
  const pooled = weatherSplit(dailyA, dailyB, d.pbarA, [...dailyA, ...dailyB]);
  if (!pooled.ok) { check(`${sc_.site} pooled weatherSplit`, false, pooled.message); continue; }
  results.push(build(sc_.site, sc_.scope, d, wx, pooled, topDayShare(dailyDeltaCost(w.A, w.B))));
}

function build(site: string, scope: string, d: DecomposeOk, wx: WeatherSplit, pooled: WeatherSplit, top: ReturnType<typeof topDayShare>) {
  // display rounding: components add up to the displayed total change (largest remainder), volume = weather + operational
  const [vW, vO, L, T, S] = allocateRounded([wx.vWeather, wx.vOperational, d.price, d.timing, d.standing]).map((x) => x / 100);
  return {
    site, scope, sample_meter_data: true,
    raw_pence: {
      Q_A_kwh: d.QA, Q_B_kwh: d.QB, C_A: d.CA, C_B: d.CB, standing_A: d.standingA, standing_B: d.standingB,
      pbar_A: d.pbarA, pbar_B: d.pbarB, pbar_B_star: d.pbarBStar, delta_energy: d.deltaEnergy, delta_total: d.deltaTotal,
      volume: d.volume, price: d.price, timing: d.timing, standing: d.standing, identity_error: d.identityError,
      volume_weather: wx.vWeather, volume_operational: wx.vOperational,
    },
    gbp: {
      cost_A_incl_standing: gbp(d.totalA), cost_B_incl_standing: gbp(d.totalB), delta_total: gbp(d.deltaTotal),
      volume: +(vW + vO).toFixed(2), volume_weather: vW, volume_operational: vO, price: L, timing: T, standing: S,
    },
    weather: { hdd_base_c: HDD_BASE_C, beta_kwh_per_hdd: wx.beta, alpha_kwh_per_day: wx.alpha, r2: wx.r2, days_fit: wx.n, sum_hdd_A: wx.sumHddA, sum_hdd_B: wx.sumHddB, delta_kwh_weather: wx.deltaQWeather, delta_kwh_total: d.QB - d.QA, warnings: wx.warnings, ...(wx.flag ? { flag: wx.flag } : {}) },
    weather_pooled_diagnostic: { note: "fit on A+B pooled (56 days); diagnostic, not the primary window-A fit", beta_kwh_per_hdd: pooled.beta, r2: pooled.r2, volume_weather_gbp: gbp(pooled.vWeather), volume_operational_gbp: gbp(pooled.vOperational), warnings: pooled.warnings },
    top_day: top,
  };
}

const pass = checks.every((c) => c.pass) && results.length === scopes.length;
const report = {
  generated_at: new Date().toISOString(),
  note: "meter kWh are SAMPLE data; prices and temperatures are real",
  windows: { A: { from: A.from, to_exclusive: A.to, days: DAYS }, B: { from: B.from, to_exclusive: B.to, days: DAYS } },
  definitions: "V=(Q_B-Q_A)*Pbar_A; L=Q_B*(Pbar_B*-Pbar_A); T=Q_B*(Pbar_B-Pbar_B*); S=days_B*sc_B-days_A*sc_A; V+L+T+S = total bill change. Pbar_B* = window-B prices on window-A usage shape. Weather split: OLS of daily kWh on HDD (base 15.5 C) in window A.",
  weather_caveat: "Window A has almost no heating degree days (sum HDD_A is about 0.6 vs about 45 in B), so the window-A slope is determined by a single day and the weather/operational split is not reliable; see weather.warnings and weather_pooled_diagnostic.",
  assumptions: [`standing charge ${sc} p/day inc VAT per site (kilowhy.contract, constant across both windows), so S = 0`, "GBP display values are rounded to pence with largest-remainder allocation so the parts add up to the displayed total change; raw pence are kept in raw_pence"],
  zetaris_run_ids: { contract: contract.runId, slots_A: sA.runId, slots_B: sB.runId, daily_kwh: dK.runId, daily_temp: dT.runId },
  sql: { contract: sqlText.contract, slots_A: sqlText.slots(A), slots_B: sqlText.slots(B), daily_kwh: sqlText.dailyKwh, daily_temp: sqlText.dailyTemp },
  pass, checks, results,
};
mkdirSync(new URL("../eval", import.meta.url), { recursive: true });
writeFileSync(new URL("../eval/decompose_d2.json", import.meta.url), JSON.stringify(report, null, 2) + "\n");

console.log("SAMPLE meter data (kWh synthetic); Agile prices and temperatures are real. GBP, window B minus window A.");
console.table(results.map((r) => ({
  site: r.site, "dC": r.gbp.delta_total, V: r.gbp.volume, "V weather": r.gbp.volume_weather, "V oper.": r.gbp.volume_operational,
  L: r.gbp.price, T: r.gbp.timing, S: r.gbp.standing, beta: +r.weather.beta_kwh_per_hdd.toFixed(2), r2: +r.weather.r2.toFixed(2), "pooled beta/r2": `${r.weather_pooled_diagnostic.beta_kwh_per_hdd.toFixed(2)}/${r.weather_pooled_diagnostic.r2.toFixed(2)}`, warn: r.weather.warnings.join("+"),
  "top day": `${r.top_day.date} ${(r.top_day.share * 100).toFixed(1)}%`, idErr: r.raw_pence.identity_error,
})));
console.log(pass ? "DECOMPOSE PASS" : "DECOMPOSE FAIL");
process.exit(pass ? 0 : 1);
