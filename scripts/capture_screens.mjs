// Captures the README / slide-deck screenshots of the running Kilowhy app.
//
//   node scripts/capture_screens.mjs [--only=1,2,3] [--no-live] [--url=http://127.0.0.1:5174]
//
// The app (UI + API) must already be running; two live investigations are started through the UI
// (one at a time, the server rejects concurrent ones). Meter kWh in every shot are SAMPLE data.
// --no-live opens the saved answers instead of asking, so shots 2 and 8 are skipped (debugging).
//
// Playwright is not a dependency of this repository; it is imported from the sibling project that
// has it installed (override with PLAYWRIGHT_PATH).
import { mkdirSync, statSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const PLAYWRIGHT =
  process.env.PLAYWRIGHT_PATH ??
  join(os.homedir(), "Documents/Codex/claude-local-projects/takeable-app/node_modules/playwright/index.mjs");
const { chromium } = await import(PLAYWRIGHT);

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "docs", "screenshots");
mkdirSync(OUT, { recursive: true });

const args = process.argv.slice(2);
const opt = (name, dflt) => args.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? dflt;
const BASE = opt("url", "http://127.0.0.1:5174");
const NO_LIVE = args.includes("--no-live");
const ONLY = opt("only", "") ? opt("only", "").split(",").map((s) => s.trim()) : null;
const want = (n) => !ONLY || ONLY.includes(String(n)) || ONLY.includes(String(n).padStart(2, "0"));

const Q1 = "Why did our electricity cost more in the last four weeks?";
const Q2 = "Why did Brixton use more electricity?";
const PAD = 24;
const routesSeen = {};
const notes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
const page = await ctx.newPage();
page.setDefaultTimeout(30_000);

async function settle() {
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(2, 2);
  await sleep(500);
}

/** Screenshot one element with PAD px of page around it (clip computed from boundingBox). */
async function shootEl(loc, name) {
  await loc.scrollIntoViewIfNeeded();
  await settle();
  const box = await loc.boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  const sc = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, w: document.documentElement.scrollWidth }));
  const x = Math.max(0, box.x + sc.x - PAD);
  const y = Math.max(0, box.y + sc.y - PAD);
  const clip = { x, y, width: Math.min(sc.w - x, box.width + 2 * PAD), height: box.height + 2 * PAD };
  await page.screenshot({ path: join(OUT, name), clip, fullPage: true });
  console.log(`saved ${name}`);
}

async function shootViewport(name) {
  await settle();
  await page.screenshot({ path: join(OUT, name) });
  console.log(`saved ${name}`);
}

async function guard(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`FAILED ${label}: ${e.message.split("\n")[0]}`);
    notes.push(`${label} failed: ${e.message.split("\n")[0]}`);
  }
}

const routeLines = async () =>
  page.locator("section.timeline .llm-receipt-toggle").evaluateAll((els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()));

async function setQuestion(q, siteValue) {
  await page.locator("#question-input").fill(q);
  await page.locator(".question-box select").selectOption(siteValue);
}

/** Ask through the UI. When `timelineShot` is set, take it while the run is in progress. */
async function ask(label, timelineShot) {
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Ask Kilowhy" }).click();
  await page.locator("section.timeline").waitFor();
  const done = page.locator("section.timeline .timeline-done");
  let frame = null;
  let lastPrinted = "";
  while (!(await done.count()) && Date.now() - startedAt < 180_000) {
    if (await page.locator(".error-banner").count()) break;
    const ev = await page.locator("section.timeline .evidence-pill").count();
    const llm = await page.locator("section.timeline .llm-routes li").count();
    const stage = await page.locator("section.timeline .stage.active .stage-label").allInnerTexts();
    const state = `evidence ${ev}, llm ${llm}, active [${stage.join(", ")}]`;
    if (state !== lastPrinted) {
      console.log(`  [${label} +${((Date.now() - startedAt) / 1000).toFixed(0)}s] ${state}`);
      lastPrinted = state;
    }
    if (timelineShot && ev >= 6 && llm >= 2) {
      // Keep the latest frame taken before the run ends; it shows the most of the live state.
      const tl = page.locator("section.timeline");
      const box = await tl.boundingBox();
      if (box) {
        const sc = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, w: document.documentElement.scrollWidth }));
        const x = Math.max(0, box.x + sc.x - PAD);
        const y = Math.max(0, box.y + sc.y - PAD);
        const buf = await page.screenshot({
          clip: { x, y, width: Math.min(sc.w - x, box.width + 2 * PAD), height: box.height + 2 * PAD },
          fullPage: true,
        });
        if (!(await done.count())) frame = { buf, state, t: (Date.now() - startedAt) / 1000 };
      }
    }
    await sleep(1500);
  }
  if (timelineShot && frame) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(OUT, timelineShot), frame.buf);
    console.log(`saved ${timelineShot} (frame at +${frame.t.toFixed(0)}s: ${frame.state})`);
    notes.push(`${timelineShot}: ${frame.state} at +${frame.t.toFixed(0)}s`);
  } else if (timelineShot) {
    notes.push(`${timelineShot}: no in-progress frame captured`);
  }
  await done.waitFor({ timeout: 180_000 });
  await page.getByRole("button", { name: "Ask Kilowhy" }).waitFor();
  await page.locator("section.answer-card").waitFor();
  await sleep(2000); // entities fetch, memory refresh
  routesSeen[label] = await routeLines();
  console.log(`  ${label} finished: ${await done.innerText()}`);
  for (const r of routesSeen[label]) console.log(`    route: ${r}`);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.locator(".status-chips .chip").first().waitFor();
await page.locator("section.recent-answers li").first().waitFor();
const chips = await page.locator(".status-chips .chip").allInnerTexts();
console.log("status chips:", chips.map((c) => c.trim()).join(" | "));
if (await page.locator(".offline-notice").count()) throw new Error("UI is in offline demo mode; the API is not reachable");
if (await page.locator("html[data-theme=dark]").count()) await page.getByRole("button", { name: "Toggle light and dark" }).click();

// 1. home
if (want(1)) await guard("01", () => shootViewport("01-home.png"));

// 2. live run of the electricity-cost question, timeline while it runs
const needFirstAnswer = [2, 3, 4, 5, "5a", 6, 9].some(want);
if (needFirstAnswer) {
  await guard("run1", async () => {
    if (NO_LIVE) {
      await page.locator("section.recent-answers .recent-item").filter({ hasText: /last four weeks/ }).first().click();
      await page.locator("section.answer-card").waitFor();
      await sleep(2500);
    } else {
      await setQuestion(Q1, "ALL");
      await ask("run1", want(2) ? "02-live-timeline.png" : null);
    }
  });
}

const answer = page.locator("section.answer-card");

// 3. finished answer card
if (want(3)) await guard("03", () => shootEl(answer, "03-answer.png"));

// 4. evidence drawer for the price evidence
if (want(4)) {
  await guard("04", async () => {
    await answer.scrollIntoViewIfNeeded();
    let chip = page.locator("section.timeline .evidence-pill").filter({ hasText: "Price level A vs B" }).first();
    if (!(await chip.count())) {
      chip = page.locator("section.answer-card p.sentence", { hasText: /price/i }).locator("button.cite-e").first();
    }
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await page.locator(".evidence-drawer.open").waitFor();
    await sleep(900);
    await page.locator(".evidence-drawer.open pre").waitFor();
    const idText = await page.locator(".evidence-drawer .drawer-id").innerText();
    const title = await page.locator(".evidence-drawer .drawer-head h2").innerText();
    console.log(`  drawer: ${idText} ${title}`);
    notes.push(`04 drawer shows ${idText} ${title}`);
    await shootViewport("04-evidence-drawer.png");
    await page.keyboard.press("Escape");
    await page.locator(".evidence-drawer.open").waitFor({ state: "detached" });
    await sleep(500);
  });
}

// 5. recommendation + ruled out
if (want(5)) await guard("05", () => shootEl(page.locator("section.rec-card"), "05-recommendation.png"));
if (want("5a")) await guard("05a", () => shootEl(page.locator("section.ruled-out"), "05a-ruled-out.png"));

// 6. receipts + Markovian chart, one Nightshift receipt expanded (and one more if there is one)
if (want(6)) {
  await guard("06", async () => {
    const how = page.locator("section.how-answer");
    await how.scrollIntoViewIfNeeded();
    const toggles = how.locator(".llm-receipt-toggle:not([disabled])");
    const nightshift = how.locator(".llm-receipt:not(.fallback) .llm-receipt-toggle:not([disabled])");
    const nCount = await nightshift.count();
    if (nCount > 0) {
      await nightshift.first().click();
      notes.push(`06 expanded a Nightshift receipt (${nCount} Nightshift receipt line(s) in the section)`);
    } else if ((await toggles.count()) > 0) {
      await toggles.first().click();
      notes.push("06 NO Nightshift receipt in this answer; expanded a NVIDIA direct (fallback) receipt instead");
    }
    await sleep(300);
    await shootEl(how, "06-receipts-markovian.png");
    // The chart alone, for a slide where the tall section does not fit.
    await shootEl(how.locator("figure.markov-chart"), "06a-markovian-chart.png");
  });
}

// 9. dark theme answer card (same answer)
if (want(9)) {
  await guard("09", async () => {
    await page.getByRole("button", { name: "Toggle light and dark" }).click();
    await page.locator("html[data-theme=dark]").waitFor();
    await sleep(500);
    await shootEl(answer, "09-dark-answer.png");
    await page.getByRole("button", { name: "Toggle light and dark" }).click();
    await page.locator("html[data-theme=light]").waitFor();
  });
}

// 8. Brixton answer with the recalled memory, then 7 (memory panel with the note and its audit trail)
if (want(7) || want(8)) {
  await guard("run2", async () => {
    if (NO_LIVE) {
      await page.locator("section.recent-answers .recent-item").filter({ hasText: Q2 }).first().click();
      await page.locator("section.answer-card").waitFor();
      await sleep(2500);
      await page.locator(".question-box select").selectOption("S2");
    } else {
      await setQuestion(Q2, "S2");
      await ask("run2", null);
    }
  });
  const recall = await page.locator("section.answer-card .recall-banner").count();
  const mChipsInBody = await page.locator("section.answer-card .answer-body .cite-m").count();
  const mChipsAll = await page.locator("section.answer-card .cite-m").count();
  console.log(`  recall banner: ${recall}, M chips in sentences: ${mChipsInBody}, M chips anywhere in card: ${mChipsAll}`);
  notes.push(`08 recall banner ${recall ? "present" : "ABSENT"}; [M#] chips: ${mChipsInBody} in sentences, ${mChipsAll} in the card`);

  if (want(8)) await guard("08", () => shootEl(page.locator("section.answer-card"), "08-brixton-memory-answer.png"));

  if (want(7)) {
    await guard("07", async () => {
      const panel = page.locator("section.memory-panel");
      // The memory chip in the answer opens the panel and highlights the remembered note.
      const chip = page.locator("section.answer-card .recall-banner button.cite-m").first();
      if (await chip.count()) await chip.click();
      else await panel.locator("button.memory-toggle").click();
      await panel.locator(".memory-body").waitFor();
      const item = panel.locator("li.memory-item", { hasText: "oven schedule" }).first();
      await item.waitFor();
      await item.getByRole("button", { name: "Audit trail" }).click();
      await item.locator("ol.audit-list").waitFor();
      await sleep(900);
      // The panel lists every site; show it down to the end of the first (Brixton) group when it is long.
      const group = panel.locator(".memory-group").first();
      const pb = await panel.boundingBox();
      const gb = await group.boundingBox();
      const head = await panel.locator("button.memory-toggle").boundingBox();
      await panel.scrollIntoViewIfNeeded();
      await settle();
      const sc = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY, w: document.documentElement.scrollWidth }));
      const pb2 = await panel.boundingBox();
      const gb2 = await group.boundingBox();
      console.log(`  memory panel h=${pb2.height.toFixed(0)}, first group h=${gb2.height.toFixed(0)}`);
      const x = Math.max(0, pb2.x + sc.x - PAD);
      const y = Math.max(0, pb2.y + sc.y - PAD);
      const bottom = pb2.height > 1400 ? gb2.y + gb2.height - pb2.y : pb2.height;
      await page.screenshot({
        path: join(OUT, "07-memory.png"),
        clip: { x, y, width: Math.min(sc.w - x, pb2.width + 2 * PAD), height: bottom + 2 * PAD },
        fullPage: true,
      });
      console.log("saved 07-memory.png");
      notes.push(`07 panel ${pb2.height > 1400 ? "clipped after the first (Brixton) group" : "whole panel"}`);
    });
  }
}

await browser.close();

// Verify every file opens.
console.log("\nfiles:");
const { readdirSync } = await import("node:fs");
for (const f of readdirSync(OUT).filter((n) => n.endsWith(".png")).sort()) {
  const buf = readFileSync(join(OUT, f));
  const isPng = buf.subarray(1, 4).toString() === "PNG";
  console.log(`${f}  ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}  ${(statSync(join(OUT, f)).size / 1024).toFixed(0)} KB  ${isPng ? "png ok" : "NOT A PNG"}`);
}
console.log("\nroutes:", JSON.stringify(routesSeen, null, 1));
console.log("\nnotes:\n- " + notes.join("\n- "));
