/* The gate suite. Every gate is one named invariant; the suite passes only when all do.
   Run: node tests/verify.mjs */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const jiti = createJiti(import.meta.url);

const { CanonStore, normalize, CAPSULE_CHARS } = await jiti.import(join(projectRoot, "extensions/lib/store.ts"));
const { advise, BODY_WARN_CHARS, BODY_LARGE_CHARS } = await jiti.import(join(projectRoot, "extensions/lib/lint.ts"));
const { Surfacer, SESSION_BUDGET_CHARS } = await jiti.import(join(projectRoot, "extensions/lib/surfacing.ts"));
const { registerPiCanon } = await jiti.import(join(projectRoot, "extensions/canon.ts"));

let gates = 0;
const pass = (name) => console.log(`ok ${String(++gates).padStart(2)} ${name}`);

const work = mkdtempSync(join(tmpdir(), "pi-canon-verify-"));
const projDir = join(work, "proj");
mkdirSync(join(projDir, "src/core"), { recursive: true });
writeFileSync(join(projDir, "src/core/config.ts"), "export const x = 1;\n");
writeFileSync(join(projDir, "src/core/other.ts"), "export const y = 2;\n");

const store = new CanonStore(join(projDir, ".canon"));
const today = new Date().toISOString().slice(0, 10);

/* --- addresses ------------------------------------------------------------------ */

assert.equal(normalize("src/core/config.ts"), "src/core/config");
assert.equal(normalize("./src/core/"), "src/core");
assert.equal(normalize("lake/fundamentals/market_cap"), "lake/fundamentals/market_cap");
pass("normalize drops extensions and edges, keeps directory dots");

assert.equal(normalize(".env"), ".env");
assert.equal(normalize("src/.env"), "src/.env");
pass("normalize never empties a hidden file name");

assert.equal(normalize(`${projDir}/src/core/config.ts`, projDir), "src/core/config");
pass("normalize strips the project prefix");

/* --- store ---------------------------------------------------------------------- */

store.write("src/core/config", {
  capsule: "Loads layered config; env beats file.",
  body: "Current truth about config loading.",
  aliases: ["src/config"],
});
const back = store.read("src/core/config");
assert.equal(back.capsule, "Loads layered config; env beats file.");
assert.deepEqual(back.aliases, ["src/config"]);
assert.equal(back.body.trim(), "Current truth about config loading.");
pass("write and read round trip");

assert.equal(back.updated, today);
pass("write stamps updated");

writeFileSync(join(projDir, ".canon/wiki/src/handmade.md"), "---\ncapsule: Hand written.\ntags: [a, b]\nunknown: kept\n---\nBody.\n");
const handmade = store.read("src/handmade");
assert.equal(handmade.capsule, "Hand written.");
assert.equal(handmade.body.trim(), "Body.");
pass("foreign front matter keys are tolerated, not errors");

assert.equal(store.resolve("src/core/config.ts", "").path, "src/core/config");
pass("resolve hits the exact address");

assert.equal(store.resolve("src/core/config/deep/child.ts").path, "src/core/config");
assert.equal(store.resolve("no/such/thing"), undefined);
pass("resolve walks to the nearest ancestor and misses honestly");

assert.equal(store.resolve("src/config").path, "src/core/config");
assert.equal(store.lookup("src/config").path, "src/core/config");
pass("aliases keep old addresses resolving");

const j1 = store.journal({ body: "Project inception.", slug: "inception", subject: ["src/core/config"] });
const j2 = store.journal({ body: "Second entry, same slug.", slug: "inception" });
assert.notEqual(j1, j2);
assert.match(readFileSync(j1, "utf8"), /subject: \[src\/core\/config\]/);
assert.match(readFileSync(j1, "utf8"), /Project inception\./);
pass("journal entries are immutable files; a repeat slug gets a fresh file");

assert.match(j1.split("/").at(-1), new RegExp(`^${today}-inception\\.md$`));
pass("journal files carry their date");

const mapped = store.map();
assert.match(mapped, /src\/core\/config: Loads layered config/);
assert.match(store.map("src/core"), /config/);
assert.equal(store.map("absent"), "No articles under absent.");
pass("map lists addresses with capsules");

/* --- lint ----------------------------------------------------------------------- */

const bigBody = "x".repeat(BODY_WARN_CHARS + 1);
assert.ok(advise({ ...back, body: bigBody }, store).some((a) => a.includes("warn past")));
assert.ok(advise({ ...back, body: "x".repeat(BODY_LARGE_CHARS + 1) }, store).some((a) => a.includes("large past")));
pass("size bands warn and never block");

store.write("src/core/config/tiny", { capsule: "Tiny.", body: "short" });
assert.ok(advise(store.read("src/core/config/tiny"), store).some((a) => a.includes("folding it into src/core/config")));
pass("a tiny child with a parent draws a fold up hint");

assert.ok(advise({ ...back, capsule: "" }, store).some((a) => a.includes("No capsule")));
assert.ok(advise({ ...back, capsule: "y".repeat(CAPSULE_CHARS + 1) }, store).some((a) => a.includes("cap")));
pass("capsule advice: missing and oversized");

assert.ok(advise({ ...back, path: "ops/logs/2026-08-10" }, store).some((a) => a.includes("journal")));
pass("journalish addresses draw a redirect to the journal");

const linked = { ...back, body: "See [[src/config]] and [[missing/page]]." };
const linkAdvice = advise(linked, store);
assert.ok(linkAdvice.some((a) => a.includes("[[missing/page]]")));
assert.ok(!linkAdvice.some((a) => a.includes("[[src/config]]")));
pass("dead links are named; alias links are not false positives");

/* --- surfacing ------------------------------------------------------------------ */

const surf = new Surfacer(store, projDir);
const paths = surf.pathsIn({ file_path: join(projDir, "src/core/config.ts"), note: "no/such/path" });
assert.deepEqual(paths, [join(projDir, "src/core/config.ts")]);
pass("pathsIn keeps only paths that exist on disk");

const first = surf.nudge(paths);
assert.match(first, /src\/core\/config \(updated .*\): Loads layered config/);
assert.equal(surf.nudge(paths), undefined);
pass("a governing article surfaces once per session");

const surfBudget = new Surfacer(store, projDir);
store.write("src/core/other", { capsule: "c".repeat(SESSION_BUDGET_CHARS), body: "b" });
surfBudget.nudge([join(projDir, "src/core/other.ts")]);
const pointer = surfBudget.nudge([join(projDir, "src/core/config.ts")]);
assert.match(pointer, /article exists\. Read it/);
pass("a spent budget degrades capsules to pointers");

const surfSettle = new Surfacer(store, projDir);
surfSettle.nudge([join(projDir, "src/core/config.ts")]);
const settle = surfSettle.settleNudge();
assert.match(settle, /Touched but not updated: src\/core\/config/);
assert.equal(surfSettle.settleNudge(), undefined);
pass("settle reminds once per batch of touches");

const surfDone = new Surfacer(store, projDir);
surfDone.nudge([join(projDir, "src/core/config.ts")]);
surfDone.markUpdated("src/core/config");
assert.equal(surfDone.settleNudge(), undefined);
pass("an updated article draws no settle reminder");

/* --- wiring --------------------------------------------------------------------- */

assert.throws(() => registerPiCanon({ on() {}, registerTool() {}, registerCommand() {} }, { budget: 1 }), /unknown option "budget"/);
pass("unknown options throw by name");

const handlers = {};
const sent = [];
const tools = [];
const fakePi = {
  on: (name, fn) => (handlers[name] ??= []).push(fn),
  registerTool: (t) => tools.push(t),
  registerCommand: () => {},
  sendMessage: (msg, opts) => sent.push({ msg, opts }),
};
registerPiCanon(fakePi, {});
assert.equal(tools.length, 1);
assert.equal(tools[0].name, "pi_canon");
assert.ok(handlers.tool_call && handlers.session_start && handlers.agent_settled);
pass("registration wires the tool and the three events");

const ctx = { cwd: projDir };
for (const fn of handlers.session_start) fn({ reason: "startup" }, ctx);
for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t1", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
assert.equal(sent.length, 1);
assert.match(sent[0].msg.content, /Loads layered config/);
assert.equal(sent[0].opts.deliverAs, "steer");
pass("a touched asset surfaces its capsule as a steer message");

for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t2", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
assert.equal(sent.length, 1);
for (const fn of handlers.tool_call) fn({ toolName: "pi_canon", toolCallId: "t3", input: { action: "read", path: "src/core/config" } }, ctx);
assert.equal(sent.length, 1);
pass("repeat touches and pi_canon's own calls stay silent");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 2);
assert.match(sent[1].msg.content, /Touched but not updated/);
assert.equal(sent[1].opts.deliverAs, "nextTurn");
pass("settle delivers the write after reminder for the next turn");

const result = await tools[0].execute("id", { action: "read", path: "src/core/config" }, undefined, undefined, ctx);
assert.match(result.content[0].text, /Current truth about config loading/);
const written = await tools[0].execute("id", { action: "write", path: "src/newthing", body: "New.", capsule: "" }, undefined, undefined, ctx);
assert.match(written.content[0].text, /Wrote src\/newthing/);
assert.match(written.content[0].text, /No capsule/);
const logged = await tools[0].execute("id", { action: "journal", body: "Something happened.", slug: "event" }, undefined, undefined, ctx);
assert.match(logged.content[0].text, /Logged .*event\.md/);
const misread = await tools[0].execute("id", { action: "read", path: "src/core/config/deep" }, undefined, undefined, ctx);
assert.match(misread.content[0].text, /Nearest governing article: src\/core\/config/);
pass("the tool reads, writes with advice, journals, and teaches on a miss");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 2);
pass("a quiet session stays quiet");

const surfOff = { on: (n, f) => (surfOffHandlers[n] ??= []).push(f), registerTool() {}, registerCommand() {}, sendMessage: () => surfOffSent.push(1) };
const surfOffHandlers = {};
const surfOffSent = [];
registerPiCanon(surfOff, { surface: false });
for (const fn of surfOffHandlers.session_start ?? []) fn({ reason: "startup" }, ctx);
for (const fn of surfOffHandlers.tool_call ?? []) fn({ toolName: "read", toolCallId: "t", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
assert.equal(surfOffSent.length, 0);
pass("surface: false silences every nudge");

console.log(`\nall ${gates} gates green`);
