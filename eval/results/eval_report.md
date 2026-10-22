# Kilowhy evaluation report

**SAMPLE meter data.** Meter kWh are SAMPLE data (synthetic, Crumb & Co site S1, generator seed 0xc0ffee, dated sample events switched off). Prices (Octopus Agile), carbon intensity and generation mix (NESO), and temperature (Open-Meteo) are the real series of eval/data/real_windows.json.

Question: how well does the deterministic hypothesis layer (decomposition, H1-H11, recommendation) recover causes that are planted in a clean baseline site, on the real Octopus Agile / NESO / Open-Meteo windows (A: 2026-08-27 to 2026-09-24, B: 2026-09-24 to 2026-10-22, exclusive)? Expected statuses were written down from the plants before any scenario was run (`eval/scenarios.ts`); thresholds are the fixed constants of `server/src/hypotheses/thresholds.ts` and were not changed.

## Result

| Measure | Value |
|---|---|
| Scenarios with every scored hypothesis exactly as expected | 5 of 12 |
| Scored (scenario, hypothesis) pairs matching exactly | 83 of 91 |
| "supported" precision | 100.0% (30 true positives, 0 false positives) |
| "supported" recall | 93.8% (30 of 32; 0 ruled out, 2 inconclusive) |
| "supported" F1 | 96.8% |
| Planted causes only (supported labels that come from a plant) | precision 100.0%, recall 94.1%, F1 97.0% (16 of 17) |
| Real-data causes only (cold snap for H3, 17 Oct price day for H6) | recall 93.3% (14 of 15) |
| Expected "ruled out" answered "inconclusive" (hedged) | 6 of 59 |
| Decomposition identity: V+L+T+S equals dC to within 1 pence (0.01 GBP) | 12 of 12 scenarios (largest error 0 pence in a plain sum, 5.5e-12 pence compensated) |
| Planted cause named correctly (event, day, change point, standing effect) | 16 of 17 |
| Real-data hypotheses H1, H2, H10 same as scenario 1 | 36 of 36 (reference: H1 supported, H2 supported, H10 supported) |
| Load-shift recommendation finds flexible peak load exactly where it is planted | 12 of 12 scenarios |

Positive class is "supported". A false negative is an expected "supported" answered "ruled out" or "inconclusive". The supported labels split into causes planted in the series and effects that the real data carries in every scenario: the real windows are about 3.3 C colder in B (heating kWh of the site 46 to 251, weather about 43% of the baseline change) and 17 Oct, whose baseline partner 19 Sep was a very cheap windy day, is about 31% of it. Both are labelled "supported" by the arithmetic of the true series and are marked *real* below.

## Per hypothesis

| Hypothesis | Pairs | TP | FP | FN | TN | Hedged | Precision | Recall | F1 |
|---|---|---|---|---|---|---|---|---|---|
| H3 | 12 | 11 | 0 | 1 | 0 | 0 | 100.0% | 91.7% | 95.7% |
| H4 | 12 | 2 | 0 | 1 | 3 | 6 | 100.0% | 66.7% | 80.0% |
| H5 | 12 | 2 | 0 | 0 | 10 | 0 | 100.0% | 100.0% | 100.0% |
| H6 | 7 | 7 | 0 | 0 | 0 | 0 | 100.0% | 100.0% | 100.0% |
| H7 | 12 | 2 | 0 | 0 | 10 | 0 | 100.0% | 100.0% | 100.0% |
| H8 | 12 | 1 | 0 | 0 | 11 | 0 | 100.0% | 100.0% | 100.0% |
| H9 | 12 | 1 | 0 | 0 | 11 | 0 | 100.0% | 100.0% | 100.0% |
| H11 | 12 | 4 | 0 | 0 | 8 | 0 | 100.0% | 100.0% | 100.0% |

## Expected versus got, all scenarios

Cell: expected / got (SUP supported, OUT ruled out, INC inconclusive; "-" not scored). Lower-case *r* marks a supported label that comes from real data. Last three columns: H1, H2, H10 against the scenario-1 reference.

| # | Scenario | H3 | H4 | H5 | H6 | H7 | H8 | H9 | H11 | H1 | H2 | H10 | Identity | Rec |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | baseline | SUPr / SUP | OUT / INC **x** | OUT / OUT | SUPr / SUP | OUT / OUT | OUT / OUT | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 2 | heating_up | SUP / SUP | OUT / INC **x** | OUT / OUT | - | OUT / OUT | OUT / OUT | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 3 | ops_step_up | SUPr / SUP | SUP / SUP | OUT / OUT | - | OUT / OUT | OUT / OUT | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 4 | schedule_shift | SUPr / SUP | OUT / INC **x** | SUP / SUP | - | OUT / OUT | OUT / OUT | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 5 | fault_day_A | SUPr / INC **x** | OUT / INC **x** | OUT / OUT | SUPr / SUP | OUT / OUT | OUT / OUT | OUT / OUT | SUP / SUP | SUP | SUP | SUP | ok | ok |
| 6 | fault_day_B | SUPr / SUP | OUT / OUT | OUT / OUT | SUP / SUP | OUT / OUT | OUT / OUT | OUT / OUT | SUP / SUP | SUP | SUP | SUP | ok | ok |
| 7 | meter_fault | SUPr / SUP | OUT / OUT | OUT / OUT | SUPr / SUP | SUP / SUP | OUT / OUT | OUT / OUT | SUP / SUP | SUP | SUP | SUP | ok | ok |
| 8 | data_gap | SUPr / SUP | OUT / INC **x** | OUT / OUT | - | SUP / SUP | OUT / OUT | SUP / SUP | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 9 | tariff_change | SUPr / SUP | OUT / INC **x** | OUT / OUT | SUPr / SUP | OUT / OUT | SUP / SUP | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 10 | ops_step_down | SUPr / SUP | SUP / INC **x** | OUT / OUT | SUPr / SUP | OUT / OUT | OUT / OUT | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 11 | shift_and_step | SUPr / SUP | SUP / SUP | SUP / SUP | - | OUT / OUT | OUT / OUT | OUT / OUT | OUT / OUT | SUP | SUP | SUP | ok | ok |
| 12 | fault_and_heating | SUP / SUP | OUT / OUT | OUT / OUT | SUP / SUP | OUT / OUT | OUT / OUT | OUT / OUT | SUP / SUP | SUP | SUP | SUP | ok | ok |

## Misses

Every scored pair whose answer differs from the expectation, with the measured statistic against the rule's threshold (thresholds untouched).

| # | Hypothesis | Expected | Got | Kind | Measured | Threshold |
|---|---|---|---|---|---|---|
| 1 | H4 | ruled_out | inconclusive | hedged | V_op = 9.3% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |
| 2 | H4 | ruled_out | inconclusive | hedged | V_op = 13.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |
| 4 | H4 | ruled_out | inconclusive | hedged | V_op = 5.3% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: E1 | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |
| 5 | H3 | supported | inconclusive | missed (inconclusive) | weather = 66.1% of the change (rule >= 10.0%), beta t = 1.0 (rule >= 2) | >= 10.0% and beta t >= 2 |
| 5 | H4 | ruled_out | inconclusive | hedged | V_op = 72.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |
| 8 | H4 | ruled_out | inconclusive | hedged | V_op = 10.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |
| 9 | H4 | ruled_out | inconclusive | hedged | V_op = 9.0% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |
| 10 | H4 | supported | inconclusive | missed (inconclusive) | V_op = 6.5% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: E1 | >= 10.0% with an event step (abs t >= 2); ruled out below 5.0% |

## Bugs found and fixed

None. Every miss above is a threshold or model outcome, not a defect.

## Scenarios

<details><summary>#1 baseline: Nothing planted (real price and weather effects only) (not all as expected, 7 of 8)</summary>

No cause is planted. Real windows: B is colder (heating kWh 46 -> 251) so weather carries ~43% of the change; the 17 Oct vs 19 Sep day pair carries ~31%.

Bill change dC £122.48 = volume £53.47 + price level £69.84 + timing £-0.82 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £122.48. True shares of the change: weather 42.7%, operational step 0.0%, timing 0.7%, largest day 31.4% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 34.3% of the change (rule >= 10.0%), beta t = 21.3 (rule >= 2) |
| H4 | ruled_out | inconclusive | tn_hedged | V_op = 9.3% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 0.7% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-17 = 31.4% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.8 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 57.0% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 96.9 kgCO2e |

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#2 heating_up: Heating sensitivity doubles from 3 Oct (not all as expected, 6 of 7)</summary>

Extra heating makes weather-driven volume ~60% of the change. No operational step, timing change, fault day, meter, tariff or gap cause is planted.

Bill change dC £183.47 = volume £110.89 + price level £74.64 + timing £-2.06 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £183.47. True shares of the change: weather 59.8%, operational step 0.0%, timing 1.1%, largest day 24.9% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 47.4% of the change (rule >= 10.0%), beta t = 34.4 (rule >= 2) |
| H4 | ruled_out | inconclusive | tn_hedged | V_op = 13.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 1.1% of the change (rule >= 10.0%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.5 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 40.7% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 122.7 kgCO2e |

H6 not scored: exact largest-day share is ~25%, inside the rule's own inconclusive band.

Cause identification:

- heating sensitivity x2 from 2026-10-03: measured; H3 weather volume estimate £86.92 vs true £109.70 (ratio 0.79)

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#3 ops_step_up: Operational step: +12 kWh/day from 6 Oct (extra opening), logged (pass, 7 of 7)</summary>

A sustained +12 kWh/day in the 05:00-09:00 UTC half-hours is ~27% of the change (volume only; timing effect ~1.5%).

Bill change dC £179.21 = volume £102.5 + price level £73.94 + timing £2.77 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £179.21. True shares of the change: weather 29.2%, operational step 27.4%, timing 1.6%, largest day 23.4% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 35.6% of the change (rule >= 10.0%), beta t = 16.7 (rule >= 2) |
| H4 | supported | supported | tp | V_op = 21.6% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: E1 |
| H5 | ruled_out | ruled_out | tn | T = 1.6% of the change (rule >= 10.0%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.4 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 41.3% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 123.0 kgCO2e |

H6 not scored: exact largest-day share is ~23%, inside the rule's own inconclusive band.

Cause identification:

- operational step +12 kWh/day from 2026-10-06: found; H4 events with a daily-kWh step: E1; planted event E1

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#4 schedule_shift: Oven schedule moves 10 h later (into the 16-19 local peak) from 1 Oct, logged (not all as expected, 6 of 7)</summary>

Energy-neutral move of the bake into dear half-hours; timing effect ~43% of the change; no volume change.

Bill change dC £216.61 = volume £53.47 + price level £69.84 + timing £93.31 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £216.61. True shares of the change: weather 24.1%, operational step 0.0%, timing 43.1%, largest day 20.4% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 19.4% of the change (rule >= 10.0%), beta t = 21.3 (rule >= 2) |
| H4 | ruled_out | inconclusive | tn_hedged | V_op = 5.3% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: E1 |
| H5 | supported | supported | tp | T = 43.1% of the change (rule >= 10.0%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.8 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 32.2% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 99.6 kgCO2e |

H6 not scored: exact largest-day share is ~20%, inside the rule's own inconclusive band.

Cause identification:

- oven schedule shift from 2026-10-01: found; H5 schedule shift detected: true, band peak, change point 2026-10-01 (planted 2026-10-01)

Recommendation: shifts 210 kWh over 21 site-days, saves £56.66; flexible peak load planted: yes, found: yes.

</details>

<details><summary>#5 fault_day_A: One-off fault day in A (16 Sep, oven on all day), logged (not all as expected, 6 of 8)</summary>

The fault inflates window A, so it works AGAINST the bill increase: H6's day in the direction of the change is the real 17 Oct day, the fault is the opposite day; H11 should flag 16 Sep.

Bill change dC £49.37 = volume £-2.98 + price level £53.03 + timing £-0.68 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £49.37. True shares of the change: weather 108.0%, operational step 0.0%, timing 1.4%, largest day 77.8% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | inconclusive | fn_hedged | weather = 66.1% of the change (rule >= 10.0%), beta t = 1.0 (rule >= 2) |
| H4 | ruled_out | inconclusive | tn_hedged | V_op = 72.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 1.4% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-17 = 77.8% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | supported | supported | tp | largest |z| 6.8 (rule >= 4), 1 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 107.4% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 68.8 kgCO2e |

Cause identification:

- one-off fault day 2026-09-16: found; H11 flagged days: 2026-09-16
- one-off fault day 2026-09-16 as H6's day: **not found**; H6 opposite day 2026-10-14 (a baseline-window fault works against the increase; largest day in the direction of the change: 2026-10-17)

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#6 fault_day_B: One-off fault day in B (19 Oct, oven on all day), logged (pass, 8 of 8)</summary>

The fault day alone is ~40% of the change and the largest day; the fault also puts 13.8 kWh into the peak band that day.

Bill change dC £200.78 = volume £109.86 + price level £74.55 + timing £16.37 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £200.78. True shares of the change: weather 26.0%, operational step 0.0%, timing 8.2%, largest day 42.1% (2026-10-19).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 54.6% of the change (rule >= 10.0%), beta t = 3.7 (rule >= 2) |
| H4 | ruled_out | ruled_out | tn | V_op = 0.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 8.2% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-19 = 42.1% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | supported | supported | tp | largest |z| 6.8 (rule >= 4), 1 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 37.1% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 139.7 kgCO2e |

Cause identification:

- one-off fault day 2026-10-19: found; H11 flagged days: 2026-10-19
- one-off fault day 2026-10-19 as H6's day: found; H6 largest day 2026-10-19

Recommendation: shifts 10 kWh over 1 site-days, saves £2.55; flexible peak load planted: yes, found: yes.

</details>

<details><summary>#7 meter_fault: Meter fault in B: zero run (9 Oct) and flatline (14 Oct) (pass, 8 of 8)</summary>

8 zero half-hours and 16 repeated readings are planted; the zero run removes ~47 kWh from 9 Oct (an anomalous day), the flatline repeats a normal night reading.

Bill change dC £115.25 = volume £41.96 + price level £68.88 + timing £4.41 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £115.25. True shares of the change: weather 45.4%, operational step 0.0%, timing 3.8%, largest day 33.3% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 40.5% of the change (rule >= 10.0%), beta t = 7.2 (rule >= 2) |
| H4 | ruled_out | ruled_out | tn | V_op = 4.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 3.8% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-17 = 33.3% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | supported | supported | tp | 1 zero run(s), 1 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | supported | supported | tp | largest |z| 6.5 (rule >= 4), 1 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 59.8% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 94.1 kgCO2e |

Cause identification:

- zero run on 2026-10-09: found; H7 issues: zero_run 2026-10-09T04:00; flatline 2026-10-14T17:30
- zero-run day 2026-10-09 as an unusual day: found; H11 flagged days: 2026-10-09
- flatline on 2026-10-14: found; H7 issues: zero_run 2026-10-09T04:00; flatline 2026-10-14T17:30

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#8 data_gap: Data gap in B: 30 missing half-hours (2 and 12 Oct) (not all as expected, 6 of 7)</summary>

30 meter rows are missing: H9 (rows != 1344) and H7 (days without 48 slots) are both true by their definitions.

Bill change dC £113.64 = volume £53.36 + price level £60.94 + timing £-0.66 + standing £0; identity error 0 pence; 1314 of 1344 half-hours aligned; the true series (independent calculation) gives dC £122.48. True shares of the change: weather 42.7%, operational step 0.0%, timing 0.7%, largest day 31.4% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 36.9% of the change (rule >= 10.0%), beta t = 21.0 (rule >= 2) |
| H4 | ruled_out | inconclusive | tn_hedged | V_op = 10.1% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 0.6% of the change (rule >= 10.0%) |
| H7 | supported | supported | tp | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 2 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | supported | supported | tp | 1 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.8 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 53.6% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 3.9 pp, wind -2.9 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 89.6 kgCO2e |

H6 not scored: H6 abstains by design when day pairs are incomplete (inconclusive), so no label exists for the observable data.

Cause identification:

- missing meter rows on 2026-10-02: found; H9 supported, H7 supported: 1 of 2 site-windows have missing or extra rows
- missing meter rows on 2026-10-12: found; H9 supported, H7 supported: 1 of 2 site-windows have missing or extra rows

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#9 tariff_change: Standing charge 37.65 -> 52.00 p/day from the start of B (not all as expected, 7 of 8)</summary>

The contract row changes between the windows (S = +£4.02).

Bill change dC £126.5 = volume £53.47 + price level £69.84 + timing £-0.82 + standing £4.02; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £126.5. True shares of the change: weather 41.3%, operational step 0.0%, timing 0.7%, largest day 30.5% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 33.2% of the change (rule >= 10.0%), beta t = 21.3 (rule >= 2) |
| H4 | ruled_out | inconclusive | tn_hedged | V_op = 9.0% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 0.7% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-17 = 30.5% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | supported | supported | tp | standing 37.6525 -> 52 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.8 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 55.2% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 96.9 kgCO2e |

Cause identification:

- standing charge change from 2026-09-24: found; H8 supported; standing effect S 4.02 GBP (true 4.02)

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#10 ops_step_down: Operational decrease: -10 kWh/day from 8 Oct (early shift dropped), logged (not all as expected, 7 of 8)</summary>

A sustained -10 kWh/day is ~54% of the (smaller) change; the real 17 Oct day is ~47% of it.

Bill change dC £81.98 = volume £17.71 + price level £66.85 + timing £-2.58 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £81.98. True shares of the change: weather 63.8%, operational step 43.6%, timing 3.1%, largest day 43.3% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 28.1% of the change (rule >= 10.0%), beta t = 6.5 (rule >= 2) |
| H4 | supported | inconclusive | fn_hedged | V_op = 6.5% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: E1 |
| H5 | ruled_out | ruled_out | tn | T = 3.1% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-17 = 43.3% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 3.1 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 81.5% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 79.9 kgCO2e |

Cause identification:

- operational step -10 kWh/day from 2026-10-08: found; H4 events with a daily-kWh step: E1; planted event E1

Recommendation: shifts 0 kWh over 0 site-days, saves £0; flexible peak load planted: no, found: no.

</details>

<details><summary>#11 shift_and_step: Combination: oven shift to the peak (1 Oct) + operational step +12 kWh/day (8 Oct) (pass, 7 of 7)</summary>

Both causes are planted at the sizes of scenarios 3 and 4; each stays above its threshold in the larger change.

Bill change dC £265.21 = volume £96.37 + price level £73.43 + timing £95.42 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £265.21. True shares of the change: weather 19.7%, operational step 16.2%, timing 36.0%, largest day 18.0% (2026-10-17).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 24.5% of the change (rule >= 10.0%), beta t = 16.6 (rule >= 2) |
| H4 | supported | supported | tp | V_op = 11.9% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: E1,E2 |
| H5 | supported | supported | tp | T = 36.0% of the change (rule >= 10.0%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | ruled_out | ruled_out | tn | largest |z| 2.5 (rule >= 4), 0 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 27.7% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 120.0 kgCO2e |

H6 not scored: exact largest-day share is ~17%, inside the rule's own inconclusive band.

Cause identification:

- oven schedule shift from 2026-10-01: found; H5 schedule shift detected: true, band night, change point 2026-10-01 (planted 2026-10-01)
- operational step +12 kWh/day from 2026-10-08: found; H4 events with a daily-kWh step: E1,E2; planted event E2

Recommendation: shifts 210 kWh over 21 site-days, saves £56.66; flexible peak load planted: yes, found: yes.

</details>

<details><summary>#12 fault_and_heating: Combination: one-off fault day in B (19 Oct) + heating sensitivity doubles from 3 Oct (pass, 8 of 8)</summary>

Fault ~32% of the change (largest day), heating ~43%; the fault day puts 13.8 kWh into the peak band.

Bill change dC £261.77 = volume £167.28 + price level £79.36 + timing £15.13 + standing £0; identity error 0 pence; 1344 of 1344 half-hours aligned; the true series (independent calculation) gives dC £261.77. True shares of the change: weather 41.9%, operational step 0.0%, timing 5.8%, largest day 35.0% (2026-10-19).

| Hypothesis | Expected | Got | Result | Measured statistic against threshold |
|---|---|---|---|---|
| H3 | supported | supported | tp | weather = 59.0% of the change (rule >= 10.0%), beta t = 5.3 (rule >= 2) |
| H4 | ruled_out | ruled_out | tn | V_op = 4.9% of the change (rule >= 10.0% and an event step; ruled out below 5.0%), events with a step: none |
| H5 | ruled_out | ruled_out | tn | T = 5.8% of the change (rule >= 10.0%) |
| H6 | supported | supported | tp | top day 2026-10-19 = 35.0% of the change (rule >= 25.0%; ruled out below 12.5%) |
| H7 | ruled_out | ruled_out | tn | 0 zero run(s), 0 flatline(s), 0 duplicate ts, 0 short day(s) |
| H8 | ruled_out | ruled_out | tn | standing 37.6525 -> 37.6525 p/day, product AGILE-24-10-01 -> AGILE-24-10-01 |
| H9 | ruled_out | ruled_out | tn | 0 of 2 site-windows incomplete |
| H11 | supported | supported | tp | largest |z| 6.8 (rule >= 4), 1 flagged |
| H1 (reference) | supported | supported | same_as_reference | L = 30.3% of the change (rule: supported at >= 20.0%) |
| H2 (reference) | supported | supported | same_as_reference | corr -0.34, gas 4.2 pp, wind -3.1 pp |
| H10 (reference) | supported | supported | same_as_reference | emissions 165.5 kgCO2e |

Cause identification:

- heating sensitivity x2 from 2026-10-03: measured; H3 weather volume estimate £154.43 vs true £109.70 (ratio 1.41)
- one-off fault day 2026-10-19: found; H11 flagged days: 2026-10-19
- one-off fault day 2026-10-19 as H6's day: found; H6 largest day 2026-10-19

Recommendation: shifts 10 kWh over 1 site-days, saves £2.55; flexible peak load planted: yes, found: yes.

</details>

## Method

- Baseline: `scripts/generate_sample.ts` (Crumb & Co generator, site S1, seed 0xc0ffee) with the dated sample events off, driven by the real hourly temperature; heating responds to temperature per half-hour, the analysis windows use daily mean temperature (HDD base 15.5 C).
- Plants (`eval/plants.ts`): heating sensitivity, sustained kWh step with a logged ops_log event, oven schedule shift with an event, one-off fault day with an event (oven load 4.6 kWh per half-hour all day), zero run, flatline, missing rows, standing-charge change.
- Truth (`eval/oracle.ts`, `eval/labels.ts`): the bill split, the weather-driven and operational costs and the largest day are computed from the planted series and the real prices by a separate implementation, not by the hypothesis library. `eval/scenarios.test.ts` checks every expected status against it.
- Data layer: the injectable layer of `server/src/hypotheses/testkit.ts` filled with the planted series and the real snapshot; Zetaris is used only by `scripts/eval_snapshot.ts`. H7's four SQL checks (zero run >= 4, flatline >= 12, duplicate timestamps, days without 48 slots) are re-implemented over the planted rows with the same rules.
- H1, H2 and H10 depend on real data only, so their expected status is the one measured on scenario 1 (nothing planted); they are reported, not scored. A planted cause that enlarges the change can lower the share H1 or H10 test, so a difference from the reference would be a dilution effect, not a detection error.
- Snapshot: Zetaris runs slots a3bc0c31-1f71-4c75-a5d4-2dc80287e206 (2688 rows, sha256 4d6266022006...), temps bdc9e499-d35b-431a-a746-ade2066b786f (1344 rows, sha256 916e627e9575...), standing 870866c3-717d-4ee8-a2b3-a4d274dc0ff6 (1 rows, sha256 204446bb0d33...).
- Reproduce: `node scripts/eval_snapshot.ts` (needs Zetaris; optional, the snapshot is committed), then `node scripts/eval_run.ts`.

