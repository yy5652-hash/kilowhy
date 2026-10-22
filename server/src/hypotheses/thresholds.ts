// Decision thresholds for the hypothesis library. All constants live here (spec section 12); nothing is tuned to a data set.
// Direction: effects are compared in the direction of the total change (an increase of cost for the usual "why more?" question).
// "near miss": below the support threshold but at least NEAR_MISS_FRACTION of it -> inconclusive; below that -> ruled_out.
export const THRESHOLDS = {
  HDD_BASE_C: 15.5,

  // H1 price_level: price-level effect L >= 20% of |dC|
  H1_SHARE: 0.20,
  // H2 price_driver_generation: gas up >= 3 pp or wind down >= 3 pp, and corr(price, wind) in window B <= -0.3
  H2_GAS_PP: 3,
  H2_WIND_PP: 3,
  H2_CORR: -0.3,
  // H3 weather_volume: beta > 0, t(beta) >= 2, V_weather >= 10% of |dC|
  H3_T: 2,
  H3_SHARE: 0.10,
  // H4 operational_change: |V_operational| >= 10% of |dC| and an ops_log event with |t| >= 2 (Welch, weather-adjusted daily kWh)
  H4_SHARE: 0.10,
  H4_T: 2,
  H4_MIN_DAYS_PER_SIDE: 5,
  // H5 timing_shift: |T| >= 10% of |dC|
  H5_SHARE: 0.10,
  // H6 one_off_day: the largest single day >= 25% of the total change (section 3 mentions 40% as the "spike" rule; the H6 table row says 25%)
  H6_SHARE: 0.25,
  // H7 meter_fault: zero runs >= 4 slots, flatlines >= 12 identical non-zero readings, duplicate timestamps, days without 48 slots
  H7_ZERO_RUN_SLOTS: 4,
  H7_FLATLINE_SLOTS: 12,
  SLOTS_PER_DAY: 48,
  // H10 carbon: per component, like H1
  H10_SHARE: 0.20,

  NEAR_MISS_FRACTION: 0.5,

  // recommendation: flexible load = peak-band kWh above the site's night-band median per slot, capped per day
  REC_MAX_KWH_PER_DAY: 10,
  REC_BLOCK_SLOTS: 6,            // length of the block that is moved (6 half-hours = the 3 h peak band)
} as const;
export type Thresholds = typeof THRESHOLDS;
