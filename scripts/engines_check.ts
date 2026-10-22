// Runs each vendored Meterless engine's own test suite (npm install + npm test in vendor/meterless/<engine>/reference) and prints the pass counts.
// Usage: node scripts/engines_check.ts [--skip-install]    Exit code 1 if any suite fails. Needs network on the first run (npm install of vitest and tsx).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

export const ENGINES = ["hmem", "world-model", "markovian"] as const;
const ANSI = /\u001b\[[0-9;]*m/g;

/** Pulls the vitest summary ("Tests  12 passed | 1 failed (13)") out of the output. */
export function parseVitest(output: string): { passed: number; failed: number; total: number } | null {
  const line = output.replace(ANSI, "").split("\n").find((l) => /^\s*Tests\s+\d/.test(l));
  if (!line) return null;
  const n = (word: string) => Number(line.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0);
  return { passed: n("passed"), failed: n("failed"), total: Number(line.match(/\((\d+)\)/)?.[1] ?? n("passed") + n("failed")) };
}

function run(cwd: string, args: string[]): { ok: boolean; output: string } {
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 600_000 });
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

if (import.meta.main) {
  const skipInstall = process.argv.includes("--skip-install");
  let failed = 0;
  console.log("Vendored Meterless engines: each engine's own test suite (vendor/meterless/<engine>/reference)");
  for (const name of ENGINES) {
    const dir = new URL(`../vendor/meterless/${name}/reference/`, import.meta.url).pathname;
    if (!existsSync(dir)) { console.log(`FAIL ${name}: ${dir} missing`); failed++; continue; }
    if (!skipInstall || !existsSync(`${dir}node_modules`)) {
      const i = run(dir, ["install", "--no-audit", "--no-fund", "--loglevel=error"]);
      if (!i.ok) { console.log(`FAIL ${name}: npm install failed\n${i.output.slice(-400)}`); failed++; continue; }
    }
    const t = run(dir, ["test"]);
    const s = parseVitest(t.output);
    const ok = t.ok && s !== null && s.failed === 0 && s.passed > 0;
    console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(12)} ${s ? `${s.passed} passed, ${s.failed} failed (${s.total} tests)` : "no vitest summary found"}`);
    if (!ok) { failed++; console.log(t.output.replace(ANSI, "").split("\n").slice(-15).join("\n")); }
  }
  process.exit(failed ? 1 : 0);
}
