/* The gate suite. Every gate is one named invariant; the suite passes only when all do.
   Run: node tests/verify.mjs */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

assert.equal(normalize("../../journal/x"), "journal/x");
assert.equal(normalize("a/../../../outside/pwned"), "a/outside/pwned");
pass("dot segments are removed everywhere; no address escapes the tree");

assert.equal(normalize(`${projDir}-vendor/src/thing.ts`, projDir), `${projDir.slice(1)}-vendor/src/thing`);
pass("the prefix strip respects the path boundary");

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

store.write("src/wikilinked", { capsule: "[[src/core]] parent; env beats file.", body: "b" });
assert.equal(store.read("src/wikilinked").capsule, "[[src/core]] parent; env beats file.");
pass("a capsule opening with a wikilink survives the round trip");

writeFileSync(
  join(projDir, ".canon/wiki/src/handmade.md"),
  "---\ncapsule: Hand written.\ntags:\n  - a\n  - b\nowner: shane\n---\nBody.\n",
);
const handmade = store.read("src/handmade");
assert.equal(handmade.capsule, "Hand written.");
assert.equal(handmade.body.trim(), "Body.");
pass("foreign front matter keys are tolerated, not errors");

store.write("src/handmade", { body: "New body." });
const rewritten = readFileSync(join(projDir, ".canon/wiki/src/handmade.md"), "utf8");
assert.match(rewritten, /tags:\n {2}- a\n {2}- b/);
assert.match(rewritten, /owner: shane/);
assert.match(rewritten, /capsule: Hand written\./);
pass("foreign keys survive a write, multi-line blocks included");

const escaped = store.write("../../journal/clobber", { body: "contained" });
assert.equal(escaped.path, "journal/clobber");
assert.ok(escaped.file.includes("/.canon/wiki/journal/clobber.md"));
pass("a traversal address is contained inside wiki/");

assert.equal(store.resolve("src/core/config.ts", "").path, "src/core/config");
pass("resolve hits the exact address");

assert.equal(store.resolve("src/core/config/deep/child.ts").path, "src/core/config");
assert.equal(store.resolve("no/such/thing"), undefined);
pass("resolve walks to the nearest ancestor and misses honestly");

assert.equal(store.resolve("src/config").path, "src/core/config");
assert.equal(store.lookup("src/config").path, "src/core/config");
pass("aliases keep old addresses resolving");

const aliasFile = join(projDir, ".canon/wiki/src/core/config.md");
const primed = store.resolve("src/config");
assert.ok(primed);
const edited = readFileSync(aliasFile, "utf8").replace("aliases: [src/config]", "aliases: [src/config, src/legacy]");
writeFileSync(aliasFile, edited);
const soon = new Date(Date.now() + 5000);
utimesSync(aliasFile, soon, soon);
assert.equal(store.resolve("src/legacy").path, "src/core/config");
pass("a hand-edited alias resolves without a restart");

const j1 = store.journal({ body: "Project inception.", slug: "inception", subject: ["src/core/config"] });
const j2 = store.journal({ body: "Second entry, same slug.", slug: "inception" });
assert.notEqual(j1, j2);
assert.match(readFileSync(j1, "utf8"), /subject: \[src\/core\/config\]/);
assert.match(readFileSync(j1, "utf8"), /Project inception\./);
assert.match(readFileSync(j2, "utf8"), /Second entry/);
pass("journal entries are immutable files; wx EEXIST is the retry signal");

assert.match(j1.split("/").at(-1), new RegExp(`^${today}-inception\\.md$`));
pass("journal files carry their date");

const mapped = store.map();
assert.match(mapped, /src\/core\/config: Loads layered config/);
assert.match(store.map("src/core"), /config/);
assert.equal(store.map("absent"), "No articles under absent.");
pass("map lists addresses with capsules");

/* --- lint ----------------------------------------------------------------------- */

assert.ok(advise({ ...back, body: "x".repeat(BODY_WARN_CHARS + 1) }, store).some((a) => a.includes("warn past")));
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

const linkAdvice = advise({ ...back, body: "See [[src/config]], [[src/core/config.ts]], [[missing/page]]." }, store);
assert.ok(linkAdvice.some((a) => a.includes("[[missing/page]]")));
assert.ok(!linkAdvice.some((a) => a.includes("[[src/config]]")));
assert.ok(!linkAdvice.some((a) => a.includes("[[src/core/config.ts]]")));
pass("dead links are named; alias and extension-carrying links are not false positives");

/* --- surfacing ------------------------------------------------------------------ */

const surf = new Surfacer(store, projDir);
const paths = surf.pathsIn({ file_path: join(projDir, "src/core/config.ts"), note: "no/such/path" });
assert.deepEqual(paths, [join(projDir, "src/core/config.ts")]);
pass("pathsIn keeps only paths that exist on disk");

const multiline = surf.pathsIn({ command: "grep foo src/core/config.ts\nsrc/core/other.ts\n\tsrc/core/config.ts" });
assert.ok(multiline.includes("src/core/other.ts"));
pass("paths after JSON-escaped newlines and tabs still match");

surf.collect(paths);
const first = surf.flush();
assert.match(first, /src\/core\/config \(updated .*\): Loads layered config/);
surf.collect(paths);
assert.equal(surf.flush(), undefined);
pass("a governing article surfaces once per session");

const surfBatch = new Surfacer(store, projDir);
surfBatch.collect([join(projDir, "src/core/config.ts")]);
surfBatch.collect(["src/wikilinked"]);
const batched = surfBatch.flush();
assert.match(batched, /Governing articles /);
assert.match(batched, /src\/core\/config/);
assert.match(batched, /src\/wikilinked/);
assert.equal(batched.match(/\[pi-canon\]/g).length, 1);
pass("staged touches coalesce into one flushed message");

const surfBudget = new Surfacer(store, projDir);
store.write("src/core/other", { capsule: "c".repeat(SESSION_BUDGET_CHARS), body: "b" });
surfBudget.collect([join(projDir, "src/core/other.ts")]);
surfBudget.collect([join(projDir, "src/core/config.ts")]);
assert.match(surfBudget.flush(), /article exists\. Read it/);
pass("a spent budget degrades capsules to pointers");

const surfSeen = new Surfacer(store, projDir);
surfSeen.collect([join(projDir, "src/core/config.ts")]);
surfSeen.markSeen("src/core/config");
assert.equal(surfSeen.flush(), undefined);
pass("reading an article withdraws its staged nudge");

const surfSettle = new Surfacer(store, projDir);
surfSettle.collect([join(projDir, "src/core/config.ts")]);
surfSettle.flush();
const settle = surfSettle.settleNudge();
assert.match(settle, /Touched but not updated: src\/core\/config/);
assert.equal(surfSettle.settleNudge(), undefined);
pass("settle reminds once per batch of touches");

const surfDone = new Surfacer(store, projDir);
surfDone.collect([join(projDir, "src/core/config.ts")]);
surfDone.flush();
surfDone.markUpdated("src/core/config");
assert.equal(surfDone.settleNudge(), undefined);
pass("an updated article draws no settle reminder");

/* --- wiring --------------------------------------------------------------------- */

assert.throws(
  () => registerPiCanon({ on() {}, registerTool() {}, registerCommand() {} }, { budget: 1 }),
  /unknown option "budget"/,
);
pass("unknown options throw by name");

const handlers = {};
const sent = [];
const tools = [];
const commands = [];
const fakePi = {
  on: (name, fn) => (handlers[name] ??= []).push(fn),
  registerTool: (t) => tools.push(t),
  registerCommand: (name, def) => commands.push({ name, def }),
  sendMessage: (msg, opts) => sent.push({ msg, opts }),
};
registerPiCanon(fakePi, {});
assert.equal(tools.length, 1);
assert.equal(tools[0].name, "pi_canon");
assert.ok(handlers.tool_call && handlers.session_start && handlers.turn_end && handlers.agent_settled);
pass("registration wires the tool and the four events");

const notices = [];
const ctx = { cwd: projDir, ui: { notify: (msg, level) => notices.push({ msg, level }) } };
for (const fn of handlers.session_start) fn({ reason: "startup" }, ctx);
for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t1", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t2", input: { path: join(projDir, ".canon/wiki/src/wikilinked.md") } }, ctx);
assert.equal(sent.length, 0);
for (const fn of handlers.turn_end) fn({ turnIndex: 0 }, ctx);
assert.equal(sent.length, 1);
assert.match(sent[0].msg.content, /Loads layered config/);
assert.equal(sent[0].opts.deliverAs, "steer");
pass("touches stage silently; the turn flushes one steer message");

for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t3", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
for (const fn of handlers.tool_call) fn({ toolName: "pi_canon", toolCallId: "t4", input: { action: "read", path: "src/core/config" } }, ctx);
for (const fn of handlers.turn_end) fn({ turnIndex: 1 }, ctx);
assert.equal(sent.length, 1);
pass("repeat touches and pi_canon's own calls stay silent");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 2);
assert.match(sent[1].msg.content, /Touched but not updated/);
assert.equal(sent[1].opts.deliverAs, "nextTurn");
pass("settle delivers the write after reminder for the next turn");

const result = await tools[0].execute("id", { action: "read", path: "src/core/config" }, undefined, undefined, ctx);
assert.match(result.content[0].text, /Current truth about config loading/);
const absolute = await tools[0].execute(
  "id",
  { action: "write", path: join(projDir, "src/newthing.ts"), body: "New.", capsule: "" },
  undefined,
  undefined,
  ctx,
);
assert.match(absolute.content[0].text, /Wrote src\/newthing\./);
assert.match(absolute.content[0].text, /No capsule/);
const logged = await tools[0].execute("id", { action: "journal", body: "Something happened.", slug: "event" }, undefined, undefined, ctx);
assert.match(logged.content[0].text, /Logged .*event\.md/);
const misread = await tools[0].execute("id", { action: "read", path: "src/core/config/deep" }, undefined, undefined, ctx);
assert.match(misread.content[0].text, /Nearest governing article: src\/core\/config/);
pass("the tool strips absolute paths to addresses, writes with advice, journals, and teaches on a miss");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 2);
pass("a quiet session stays quiet");

assert.equal(commands.length, 1);
await commands[0].def.handler("", ctx);
assert.equal(notices.length, 1);
assert.match(notices[0].msg, /articles, \d+ journal entries; \d+ surfaced this session/);
assert.equal(notices[0].level, "info");
assert.equal(sent.length, 2);
pass("the status command notifies the user and tells the model nothing");

const surfOffHandlers = {};
const surfOffSent = [];
const surfOff = {
  on: (n, f) => (surfOffHandlers[n] ??= []).push(f),
  registerTool() {},
  registerCommand() {},
  sendMessage: () => surfOffSent.push(1),
};
registerPiCanon(surfOff, { surface: false });
for (const fn of surfOffHandlers.session_start ?? []) fn({ reason: "startup" }, ctx);
for (const fn of surfOffHandlers.tool_call ?? []) fn({ toolName: "read", toolCallId: "t", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
for (const fn of surfOffHandlers.turn_end ?? []) fn({ turnIndex: 0 }, ctx);
for (const fn of surfOffHandlers.agent_settled ?? []) fn(undefined, ctx);
assert.equal(surfOffSent.length, 0);
pass("surface: false silences every nudge");

console.log(`\nall ${gates} gates green`);
