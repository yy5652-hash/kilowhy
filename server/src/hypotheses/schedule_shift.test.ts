// Tests for schedule-shift detection (H5 extra metric): change point, nearest ops_log event, 10 pp threshold, and the H5 pipeline.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { changePoint, dailyBandShare, nearestEvent, detectScheduleShift, analyseSchedule } from "./schedule_shift.ts";
import { runHypothesis } from "./index.ts";
import { synth, ctxFor } from "./testkit.ts";
import { addDays } from "../bands.ts";
import type { OpsEvent } from "../data.ts";

const pts = (vals: number[], from = "2026-09-01") => vals.map((value, i) => ({ date: addDays(from, i), value }));
const ev = (eventId: string, eventDate: string, siteId = "S1"): OpsEvent => ({ eventId, siteId, eventDate, description: `event ${eventId}` });

describe("changePoint", () => {
  it("finds the first day of the new regime in a clean step", () => {
    const cp = changePoint(pts([...Array(14).fill(0.5), ...Array(10).fill(0.2)]))!;
    assert.equal(cp.date, addDays("2026-09-01", 14));
    assert.ok(Math.abs(cp.meanBefore - 0.5) < 1e-9 && Math.abs(cp.meanAfter - 0.2) < 1e-9 && Math.abs(cp.diff + 0.3) < 1e-9);
  });
  it("is robust to noise around the step", () => {
    const noise = (i: number) => ((i * 37) % 11 - 5) * 0.004;
    const cp = changePoint(pts(Array.from({ length: 40 }, (_, i) => (i < 22 ? 0.3 : 0.45) + noise(i))))!;
    assert.equal(cp.date, addDays("2026-09-01", 22));
  });
  it("needs two segments of at least 5 days; a step too close to the edge is not chosen over a segment-minimum split", () => {
    assert.equal(changePoint(pts([1, 2, 3, 4, 5, 6, 7, 8, 9])), null);
    const cp = changePoint(pts([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 9]))!; // one outlier on the last day
    assert.equal(cp.date, addDays("2026-09-01", 11)); // earliest/last allowed split, never a 1-day segment
  });
  it("a flat series still returns a split (ties go to the earliest date), with zero difference", () => {
    const cp = changePoint(pts(Array(20).fill(0.25)))!;
    assert.equal(cp.date, addDays("2026-09-01", 5)); assert.equal(cp.diff, 0);
  });
});

describe("nearestEvent", () => {
  const events = [ev("E1", "2026-10-07"), ev("E2", "2026-10-09"), ev("E3", "2026-10-04", "S2"), ev("E4", "2026-10-20")];
  it("takes the closest event of the same site within +-3 days, with the signed offset", () => {
    assert.deepEqual(nearestEvent("S1", "2026-10-08", events), { eventId: "E1", date: "2026-10-07", daysOff: -1, description: "event E1" } as any);
    assert.equal(nearestEvent("S1", "2026-10-07", events)!.daysOff, 0);
  });
  it("ignores other sites and events further than 3 days", () => {
    assert.equal(nearestEvent("S1", "2026-10-04", events)!.eventId, "E1"); // E3 is S2's; E1 is 3 days away
    assert.equal(nearestEvent("S1", "2026-10-03", events), null);          // E1 is 4 days away
    assert.equal(nearestEvent("S1", "2026-10-15", events), null);
  });
  it("on a tie the earlier event wins", () => {
    assert.equal(nearestEvent("S1", "2026-10-08", [ev("A", "2026-10-07"), ev("B", "2026-10-09")])!.eventId, "A");
  });
});

// a block of 2 kWh/slot that moves from UTC 03:00-06:00 (local night) to 07:00-10:00 (local morning) on B day 13 = 2026-10-07
const block = (moveDay: number, from = 6, to = 14) => (_s: string, w: "A" | "B", d: number, slot: number) => {
  const moved = w === "B" && d >= moveDay;
  const start = moved ? to : from;
  return 0.6 + (slot >= start && slot < start + 6 ? 2 : 0);
};
const quiet = { noise: 0.0005 };

describe("detectScheduleShift on synthetic slots", () => {
  it("detects a night-to-morning move of > 10 pp, dates it, and attaches the nearby event", () => {
    const s = synth({ ...quiet, kwh: block(13) });
    const x = detectScheduleShift(s.rows, [ev("E1", "2026-10-07")])!;
    assert.equal(x.site, "S1"); assert.ok(["night", "morning"].includes(x.band));
    // the move happens on day 13 of 28, so window B has 15 of 28 days in the new regime: 15/28 of the full 29 pp shift
    assert.ok(Math.abs(x.deltaPp) > 10 && Math.abs(x.deltaPp) < 20, String(x.deltaPp));
    assert.equal(x.changePoint, "2026-10-07");
    assert.equal(x.nearestEvent!.eventId, "E1"); assert.equal(x.nearestEvent!.daysOff, 0);
    assert.ok(x.bandsOverThreshold.includes("night") && x.bandsOverThreshold.includes("morning"));
    assert.ok(x.meanBefore! > x.meanAfter! === (x.deltaPp < 0));
  });
  it("without a logged event within 3 days the event is null; an event 5 days away does not count", () => {
    const s = synth({ ...quiet, kwh: block(13) });
    assert.equal(detectScheduleShift(s.rows, [])!.nearestEvent, null);
    assert.equal(detectScheduleShift(s.rows, [ev("E1", "2026-10-12")])!.nearestEvent, null);
    assert.equal(detectScheduleShift(s.rows, [ev("E1", "2026-10-05")])!.nearestEvent!.daysOff, -2);
  });
  it("a stable schedule is not a shift (no band moves 10 pp)", () => {
    assert.equal(detectScheduleShift(synth({ ...quiet, kwh: block(99) }).rows, []), null);
  });
  it("the 10 pp threshold is applied to the change in kWh share (just under / just over)", () => {
    // Move x kWh/day (spread over 6 slots) from local night (UTC slots 6-11) to local morning (UTC slots 14-19); daily total 40.8 kWh -> x/40.8 = share change
    const mk = (x: number) => synth({ ...quiet, kwh: (_s, w, _d, slot) => 0.6 + (slot >= 6 && slot < 12 ? 2 : 0) + (w === "B" ? (slot >= 6 && slot < 12 ? -x / 6 : slot >= 14 && slot < 20 ? x / 6 : 0) : 0) });
    assert.equal(detectScheduleShift(mk(3.9).rows, []), null, "3.9/40.8 = 9.6 pp");
    assert.ok(detectScheduleShift(mk(4.3).rows, []), "4.3/40.8 = 10.5 pp");
    // below the threshold the move is still available as a candidate (detected = false) so it can be shown for information
    const c = analyseSchedule(mk(3.9).rows, [ev("E1", "2026-09-30")])!;
    assert.equal(c.detected, false); assert.ok(Math.abs(c.deltaPp) > 9 && Math.abs(c.deltaPp) < 10, String(c.deltaPp)); assert.deepEqual(c.bandsOverThreshold, []);
    assert.equal(analyseSchedule(mk(4.3).rows, [])!.detected, true);
  });
  it("incomplete days are left out of the daily series", () => {
    const s = synth({ ...quiet, kwh: block(13), drop: (_s, w, d, slot) => w === "A" && d === 3 && slot === 0 });
    assert.equal(dailyBandShare(s.rows, "night").length, 55);
  });
});

describe("H5 pipeline: schedule shift next to the cost-based status", () => {
  const price = (cost: "neutral" | "changes") => (w: "A" | "B", d: number, slot: number) =>
    (cost === "neutral" ? 20 : slot < 14 ? 12 : 22) + (d % 5) + (w === "B" ? 5 : 0);
  const ops = [ev("E1", "2026-10-07")];
  it("shift detected but cost unchanged: H5 stays ruled out, flag and date are in the metrics, and the note says it did not change cost", async () => {
    const ctx = await ctxFor(synth({ ...quiet, kwh: block(13), price: price("neutral"), ops }));
    const h5 = await runHypothesis("H5", ctx);
    assert.equal(h5.status, "ruled_out");
    assert.equal(h5.summary.schedule_shift_detected, true); assert.equal(h5.summary.schedule_shift_change_point, "2026-10-07"); assert.equal(h5.summary.schedule_shift_event_id, "E1");
    assert.ok(Math.abs(h5.summary.schedule_shift_delta_pp as number) > 10);
    assert.ok(h5.notes.some((n) => n.includes("schedule shift detected") && n.includes("did not change cost") && n.includes("E1")));
    const e = ctx.evidence.get(h5.evidence[1])!;
    assert.equal(e.metrics.schedule_shift_detected.value, true); assert.equal(e.metrics.schedule_shift_change_point.value, "2026-10-07");
    assert.match(String(e.metrics.schedule_shift_event.value), /E1 \(2026-10-07, \+0 d\)/);
    assert.ok(h5.evidence.every((id) => ctx.evidence.get(id)));
  });
  it("shift detected and it moves cost: H5 supported, the note says it also changed cost", async () => {
    const ctx = await ctxFor(synth({ ...quiet, kwh: block(13), price: price("changes"), ops }));
    const h5 = await runHypothesis("H5", ctx);
    assert.equal(h5.status, "supported"); assert.equal(h5.summary.schedule_shift_detected, true);
    assert.ok(h5.notes.some((n) => n.includes("it also changed cost")));
  });
  it("no shift: flag false, no shift note", async () => {
    const h5 = await runHypothesis("H5", await ctxFor(synth({ ...quiet, kwh: block(99), price: price("neutral") })));
    assert.equal(h5.summary.schedule_shift_detected, false); assert.equal(h5.summary.schedule_shift_change_point, null);
    assert.ok(!h5.notes.some((n) => n.includes("schedule shift detected")));
  });
  it("a move just under 10 pp is NOT flagged, but the largest candidate and its change point are reported as below threshold", async () => {
    // the full shift is 29 pp; it starts on B day 20 (8 of 28 days in the new regime) -> 8 of 28 x 29 = 8.4 pp between the windows
    const h5 = await runHypothesis("H5", await ctxFor(synth({ ...quiet, kwh: block(20), price: price("neutral"), ops: [ev("E1", "2026-10-14")] })));
    assert.equal(h5.summary.schedule_shift_detected, false);
    assert.ok(Math.abs(h5.summary.schedule_candidate_delta_pp as number) > 8 && Math.abs(h5.summary.schedule_candidate_delta_pp as number) < 10, String(h5.summary.schedule_candidate_delta_pp));
    assert.equal(h5.summary.schedule_candidate_change_point, "2026-10-14"); assert.equal(h5.summary.schedule_candidate_event_id, "E1");
    assert.ok(h5.notes.some((n) => n.includes("no schedule shift at the 10 pp threshold") && n.includes("2026-10-14")));
  });
  it("in a multi-site scope the shift is found per site (the diluted scope-level share would hide it)", async () => {
    const kwh = (s: string, w: "A" | "B", d: number, slot: number, date: string) => (s === "S2" ? block(13)(s, w, d, slot) : 0.6 + (slot >= 6 && slot < 12 ? 2 : 0));
    const h5 = await runHypothesis("H5", await ctxFor(synth({ ...quiet, sites: ["S1", "S2", "S3"], kwh, price: price("neutral") })));
    assert.equal(h5.summary.schedule_shift_sites, "S2");
  });
});
