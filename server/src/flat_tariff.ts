// The flat (single-rate) comparison tariff used by the tariff counterfactual: Octopus business variable tariff, region C (London).
// Chosen from the public product list (https://api.octopus.energy/v1/products/?is_business=true, checked 2026-10-22).
// Shared by scripts/zetaris_ddl.ts (REST tables + view kilowhy.flat_tariff) and server/src/recommend.ts.
export const FLAT_TARIFF = {
  productCode: "BUS-VAR-AUG25",
  tariffCode: "E-1R-BUS-VAR-AUG25-C",
  name: "Flexible Octopus Business (August 2025)",
  region: "C",
  why: "The only business product that is variable ('Flexible'), single-register (one flat unit rate at every time of day), still on sale (available_to is empty, on sale since 2025-08-04) and priced for region C (London). " +
    "Fixed-term business products were re-priced on 2026-10-19 (no history for the analysis windows) and the BUS-HH-* / TOU-MHHS products are half-hourly or time-of-use, not flat.",
  baseUrl: "https://api.octopus.energy/v1/products/BUS-VAR-AUG25/electricity-tariffs/E-1R-BUS-VAR-AUG25-C",
  vatNote: "The API quotes this business product ex VAT (value_inc_vat equals value_exc_vat for the newest period). The comparison therefore uses value_exc_vat and applies the contract's VAT rate to BOTH tariffs, so it is on the same basis as the Agile figures in the rest of the report.",
} as const;

export const flatRatesEndpoint = (fromDay: string, toExclusiveDay: string): string =>
  `${FLAT_TARIFF.baseUrl}/standard-unit-rates/?period_from=${fromDay}T00:00:00Z&period_to=${toExclusiveDay}T00:00:00Z&page_size=1500`;
export const flatStandingEndpoint = (fromDay: string, toExclusiveDay: string): string =>
  `${FLAT_TARIFF.baseUrl}/standing-charges/?period_from=${fromDay}T00:00:00Z&period_to=${toExclusiveDay}T00:00:00Z&page_size=1500`;

/**
 * kilowhy.flat_tariff: one row per unit-rate period of the flat tariff with the standing charge in force at its start.
 * valid_to is NULL for the open-ended current period. p_kwh_inc_vat / standing_p_day are the API's inc-VAT values (see FLAT_TARIFF.vatNote);
 * the *_exc_vat columns are the ones the comparison uses.
 */
export const flatViewSql = (rest = "KILOWHY_REST"): string => {
  const explode = (t: string) => `SELECT r.valid_from, r.valid_to, r.value_exc_vat, r.value_inc_vat FROM ${rest}.${t} LATERAL VIEW explode(results) t AS r`;
  return `SELECT to_timestamp(u.valid_from) AS valid_from, to_timestamp(u.valid_to) AS valid_to, u.value_exc_vat AS p_kwh_exc_vat, u.value_inc_vat AS p_kwh_inc_vat, ` +
    `s.value_exc_vat AS standing_p_day_exc_vat, s.value_inc_vat AS standing_p_day\n` +
    `FROM (${explode("flat_rates_raw")}) u LEFT JOIN (${explode("flat_standing_raw")}) s\n` +
    `ON to_timestamp(s.valid_from) <= to_timestamp(u.valid_from) AND (s.valid_to IS NULL OR to_timestamp(u.valid_from) < to_timestamp(s.valid_to))`;
};
