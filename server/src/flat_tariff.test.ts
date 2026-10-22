// Tests for the flat-tariff constants and the DDL fragments used by scripts/zetaris_ddl.ts.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { FLAT_TARIFF, flatRatesEndpoint, flatStandingEndpoint, flatViewSql } from "./flat_tariff.ts";

describe("flat tariff definition", () => {
  it("is a business variable single-register tariff for region C, and the reason is recorded", () => {
    assert.equal(FLAT_TARIFF.productCode, "BUS-VAR-AUG25");
    assert.equal(FLAT_TARIFF.tariffCode, `E-1R-${FLAT_TARIFF.productCode}-C`);
    assert.ok(FLAT_TARIFF.baseUrl.endsWith(`/products/${FLAT_TARIFF.productCode}/electricity-tariffs/${FLAT_TARIFF.tariffCode}`));
    assert.ok(FLAT_TARIFF.why.length > 80 && /variable/i.test(FLAT_TARIFF.why) && /region C/.test(FLAT_TARIFF.why));
    assert.match(FLAT_TARIFF.vatNote, /ex VAT/);
  });
  it("endpoints cover the analysis span, 1500 rows per page, date-and-time bounds in UTC", () => {
    const r = flatRatesEndpoint("2026-08-27", "2026-10-22"), s = flatStandingEndpoint("2026-08-27", "2026-10-22");
    assert.match(r, /\/standard-unit-rates\/\?period_from=2026-08-27T00:00:00Z&period_to=2026-10-22T00:00:00Z&page_size=1500$/);
    assert.match(s, /\/standing-charges\/\?period_from=2026-08-27T00:00:00Z&period_to=2026-10-22T00:00:00Z&page_size=1500$/);
  });
  it("the view has the columns the data layer queries, joins standing to unit rates by validity, and keeps an open-ended valid_to", () => {
    const v = flatViewSql();
    for (const c of ["AS valid_from", "AS valid_to", "AS p_kwh_exc_vat", "AS p_kwh_inc_vat", "AS standing_p_day_exc_vat", "AS standing_p_day"]) assert.ok(v.includes(c), c);
    assert.match(v, /KILOWHY_REST\.flat_rates_raw/); assert.match(v, /KILOWHY_REST\.flat_standing_raw/);
    assert.match(v, /LEFT JOIN/); assert.match(v, /s\.valid_to IS NULL OR/); assert.match(v, /explode\(results\)/);
  });
});
