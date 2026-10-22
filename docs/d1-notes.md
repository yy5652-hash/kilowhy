# D1 (2026-10-22) setup notes
- Zetaris local platform (Docker); sample CSVs are copied into the driver container (`docker cp ... zetaris-driver-1:/home/zetaris/customer-data/shared/kw_*.csv`) and registered as FILESTORE tables via `file:///` paths.
- Views live in schemastore container `kilowhy` (query as `kilowhy.<view>`): agile_rates, agile_standing, ci_london, temp_hourly, fuel_hh, meter_hh, sites, ops_log, contract.
- Data window: 2026-08-27..2026-10-21 UTC (8 weeks); A = 08-27..09-23, B = 09-24..10-21. Tariff: AGILE-24-10-01 region C (domestic product, inc 5% VAT) as in contract.csv.
- Row counts: agile_rates 2688, ci_london 2688, temp_hourly 1344, fuel_hh 53760, meter_hh 8064 (sample).
- Nightshift smoke test: docs/nightshift-smoke.json. Note: the reply from meterless/auto contained a leaked reasoning tag (`</think>`); strip it in provider.ts.
