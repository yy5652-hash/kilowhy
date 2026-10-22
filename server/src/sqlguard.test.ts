// Tests for the read-only SQL guard. Literals and comments must never hide (or fake) a statement, keyword or table.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { guardSql, ALLOWED_VIEWS, MAX_LIMIT } from "./sqlguard.ts";

const ok = (sql: string): string => { const r = guardSql(sql); assert.equal(r.ok, true, `expected ok for: ${sql} -> ${JSON.stringify(r)}`); return r.ok ? r.sql : ""; };
const bad = (sql: string, re?: RegExp): void => {
  const r = guardSql(sql);
  assert.equal(r.ok, false, `expected rejection for: ${sql}`);
  if (re && !r.ok) assert.match(r.reason, re);
};

describe("guardSql: accepted statements", () => {
  it("appends LIMIT 5000 when there is none", () => {
    assert.equal(ok("SELECT * FROM kilowhy.meter_hh"), "SELECT * FROM kilowhy.meter_hh LIMIT 5000");
  });
  it("keeps a small LIMIT, clamps a large one, leaves exactly 5000 alone", () => {
    assert.equal(ok("SELECT * FROM kilowhy.sites LIMIT 10"), "SELECT * FROM kilowhy.sites LIMIT 10");
    assert.equal(ok("SELECT * FROM kilowhy.sites LIMIT 100000"), "SELECT * FROM kilowhy.sites LIMIT 5000");
    assert.equal(ok("select * from kilowhy.sites limit 5000"), "select * from kilowhy.sites limit 5000");
    assert.equal(ok("SELECT * FROM kilowhy.sites LIMIT 99999999999999999999"), "SELECT * FROM kilowhy.sites LIMIT 5000");
    assert.equal(ok("SELECT * FROM kilowhy.sites LIMIT 9000 OFFSET 20"), "SELECT * FROM kilowhy.sites LIMIT 5000 OFFSET 20");
  });
  it("a LIMIT inside a subquery does not count: the outer statement still gets its own", () => {
    assert.equal(ok("SELECT * FROM (SELECT * FROM kilowhy.meter_hh LIMIT 3) t"), "SELECT * FROM (SELECT * FROM kilowhy.meter_hh LIMIT 3) t LIMIT 5000");
  });
  it("accepts every allow-listed view, any case, and a trailing ORDER BY", () => {
    for (const v of ALLOWED_VIEWS) ok(`SELECT * FROM kilowhy.${v}`);
    assert.match(ok("select a from KILOWHY.METER_HH order by a"), /LIMIT 5000$/);
  });
  it("accepts joins, comma joins, UNION ALL and CTEs over allow-listed views", () => {
    ok("SELECT m.kwh, r.p_kwh_inc_vat FROM kilowhy.meter_hh m JOIN kilowhy.agile_rates r ON m.ts = r.slot_start LEFT JOIN kilowhy.ci_london c ON m.ts = c.slot_start");
    ok("SELECT * FROM kilowhy.sites s, kilowhy.contract c WHERE s.site_id IS NOT NULL");
    ok("SELECT site_id FROM kilowhy.sites UNION ALL SELECT site_id FROM kilowhy.ops_log");
    const g = guardSql("WITH k AS (SELECT site_id, SUM(kwh) AS kwh FROM kilowhy.meter_hh GROUP BY site_id), t(x) AS (SELECT 1) SELECT * FROM k JOIN t ON 1 = 1");
    assert.equal(g.ok, true);
    if (g.ok) assert.deepEqual(g.tables, ["kilowhy.meter_hh"]);
  });
  it("accepts backticked identifiers, including keyword-named columns and a quoted schema.view", () => {
    ok("SELECT `set`, `drop`, `from` FROM kilowhy.sites");
    ok("SELECT * FROM `kilowhy`.`meter_hh`");
    ok("SELECT d.`from` FROM kilowhy.ci_london d");
  });
  it("FROM inside extract/trim/IS DISTINCT FROM is not a table reference; date_add is not ADD", () => {
    ok("SELECT extract(hour FROM ts), trim(BOTH ' ' FROM site_id), date_add(ts, 1) FROM kilowhy.meter_hh WHERE kwh IS DISTINCT FROM 0");
  });
});

describe("guardSql: string literals and comments cannot fool it", () => {
  it("forbidden words, semicolons and LIMIT inside string literals are just text", () => {
    ok("SELECT * FROM kilowhy.ops_log WHERE description LIKE '%DROP TABLE x; --%'");
    ok("SELECT 'DELETE FROM x; UPDATE y' AS s, \"CREATE;\" AS t");
    assert.equal(ok("SELECT 'LIMIT 10' AS s"), "SELECT 'LIMIT 10' AS s LIMIT 5000");
    ok("SELECT 'it''s; a trap' AS s");
    ok("SELECT 'a FROM other.secret' AS s");
  });
  it("forbidden words and semicolons inside comments are ignored, and the comment cannot swallow the appended LIMIT", () => {
    assert.equal(ok("SELECT 1 AS x -- ; DROP TABLE kilowhy.sites"), "SELECT 1 AS x LIMIT 5000");
    assert.equal(ok("SELECT /* DROP; */ 1 AS x"), "SELECT   1 AS x LIMIT 5000");
    assert.equal(ok("SELECT 1 AS x -- LIMIT 10"), "SELECT 1 AS x LIMIT 5000");
    assert.equal(ok("SELECT 1 AS x /* LIMIT 10 */"), "SELECT 1 AS x LIMIT 5000");
  });
  it("comment markers inside strings do not start a comment and do not hide what follows", () => {
    bad("SELECT '--' AS a; DROP TABLE kilowhy.sites", /;/);
    bad("SELECT '/*' AS a FROM kilowhy.sites; DROP TABLE x --*/", /;/);
    bad("SELECT '--' AS a FROM other.t");
    bad("SELECT '/*' AS a FROM other.t WHERE x = '*/'");
  });
  it("the classic quote-closing injection is caught, because the ';' ends up outside a literal", () => {
    bad("SELECT * FROM kilowhy.sites WHERE site_id = 'S1'; DROP TABLE kilowhy.sites", /;/);
    bad("SELECT * FROM kilowhy.sites WHERE site_id = 'S1' OR '1'='1'; DELETE FROM kilowhy.ops_log");
  });
  it("rejects unterminated strings, comments and identifiers (they could swallow what the engine sees)", () => {
    bad("SELECT 'abc FROM kilowhy.sites", /unterminated string/);
    bad("SELECT \"abc FROM kilowhy.sites", /unterminated string/);
    bad("SELECT 1 /* never closed", /unterminated block comment/);
    bad("SELECT `abc FROM kilowhy.sites", /unterminated backtick/);
  });
  it("rejects backslash-escaped quotes and nested comments, whose meaning differs between SQL engines", () => {
    bad("SELECT 'a\\' , x FROM other.t WHERE y = ''", /backslash/);
    bad("SELECT 1 /* a /* b */ ; DROP TABLE x /* */ */", /nested/);
  });
  it("a backslash that does not escape a quote is fine (regex patterns)", () => {
    ok("SELECT * FROM kilowhy.ops_log WHERE description RLIKE '\\\\d+'");
  });
  it("rejects NUL and empty input", () => {
    bad("SELECT 1\0", /NUL/);
    bad("", /empty/);
    bad("   -- only a comment", /empty/);
  });
});

describe("guardSql: statement kinds and keywords", () => {
  it("rejects anything that does not start with SELECT or WITH", () => {
    for (const s of ["DROP TABLE kilowhy.sites", "SHOW TABLES", "EXPLAIN SELECT 1", "DESCRIBE kilowhy.sites", "(SELECT 1)", "TABLE kilowhy.sites", "FROM kilowhy.sites SELECT *"]) bad(s, /only SELECT or WITH/);
  });
  it("rejects a semicolon anywhere, including a single trailing one", () => {
    bad("SELECT 1;", /;/);
    bad("SELECT 1; SELECT 2", /;/);
  });
  it("rejects every DDL/DML/admin keyword outside literals", () => {
    for (const kw of ["CREATE", "DROP", "INSERT", "UPDATE", "DELETE", "ALTER", "CACHE", "UNCACHE", "GRANT", "REVOKE", "REFRESH", "SET", "TRUNCATE", "MERGE", "USE", "ADD", "LOAD"]) {
      bad(`SELECT * FROM kilowhy.sites WHERE x = 1 ${kw} y`, new RegExp(`forbidden keyword: ${kw}`));
      bad(`select * from kilowhy.sites where x = 1 ${kw.toLowerCase()} y`, new RegExp(`forbidden keyword: ${kw}`));
    }
  });
  it("rejects DML smuggled behind a CTE", () => {
    bad("WITH x AS (SELECT 1) INSERT INTO kilowhy.sites SELECT * FROM x", /INSERT/);
    bad("WITH x AS (SELECT 1) DELETE FROM kilowhy.sites", /DELETE/);
  });
  it("rejects functions that can run JVM code", () => {
    bad("SELECT reflect('java.lang.Runtime', 'getRuntime')", /reflect/);
    bad("SELECT java_method('java.lang.System', 'exit', 0)", /java_method/);
  });
  it("rejects unbalanced parentheses", () => {
    bad("SELECT (1 FROM kilowhy.sites", /unbalanced/);
    bad("SELECT 1) FROM kilowhy.sites", /unbalanced/);
  });
});

describe("guardSql: table allow-list", () => {
  it("rejects tables outside kilowhy.* views, unqualified names and extra path parts", () => {
    bad("SELECT * FROM other.t", /table not allowed/);
    bad("SELECT * FROM meter_hh", /table not allowed/);
    bad("SELECT * FROM kilowhy.nope", /table not allowed/);
    bad("SELECT * FROM KILOWHY_FILES.meter_hh_raw", /table not allowed/);
    bad("SELECT * FROM KILOWHY_REST.agile_a_raw", /table not allowed/);
    bad("SELECT * FROM a.kilowhy.meter_hh", /table not allowed/);
    bad("SELECT * FROM parquet.`/etc/passwd`", /table not allowed/);
  });
  it("rejects a disallowed table anywhere: join, comma join, subquery, CTE body, set operation", () => {
    bad("SELECT * FROM kilowhy.sites s JOIN other.t o ON 1 = 1", /other\.t/);
    bad("SELECT * FROM kilowhy.sites s, other.t o", /other\.t/);
    bad("SELECT * FROM (SELECT * FROM other.t) x", /other\.t/);
    bad("SELECT * FROM kilowhy.sites WHERE site_id IN (SELECT site_id FROM other.t)", /other\.t/);
    bad("WITH x AS (SELECT * FROM other.t) SELECT * FROM x", /other\.t/);
    bad("SELECT 1 UNION ALL SELECT 1 FROM other.t", /other\.t/);
  });
  it("rejects table-valued functions and VALUES", () => {
    bad("SELECT * FROM range(10)", /table-valued/);
    bad("SELECT * FROM kilowhy.sites, explode(array(1,2))", /table-valued/);
    bad("SELECT * FROM VALUES (1, 2)", /table-valued|table not allowed/);
  });
  it("a CTE name only works as an unqualified reference, and an undefined name is not a CTE", () => {
    ok("WITH meter AS (SELECT * FROM kilowhy.meter_hh) SELECT * FROM meter");
    bad("WITH meter AS (SELECT * FROM kilowhy.meter_hh) SELECT * FROM other.meter", /table not allowed/);
    bad("SELECT * FROM meter", /table not allowed/);
  });
  it("a comma in a SELECT list or GROUP BY after FROM is not mistaken for a table separator", () => {
    ok("SELECT a, b FROM kilowhy.meter_hh GROUP BY a, b ORDER BY a, b");
    ok("SELECT * FROM kilowhy.ci_london LATERAL VIEW explode(array(1,2)) t AS x, y");
  });
});

describe("guardSql: LIMIT shape", () => {
  it("rejects a LIMIT that is not a plain integer or not the last clause", () => {
    bad("SELECT * FROM kilowhy.sites LIMIT 10 + 1", /LIMIT/);
    bad("SELECT * FROM kilowhy.sites LIMIT x", /LIMIT/);
    bad("SELECT * FROM kilowhy.sites LIMIT 5 ORDER BY site_id", /LIMIT/);
    bad("SELECT * FROM kilowhy.sites OFFSET 5", /OFFSET/);
  });
  it("MAX_LIMIT is 5000", () => assert.equal(MAX_LIMIT, 5000));
});
