/* The gate suite. Every gate is one named invariant; the suite passes only when all do.
   Run: node tests/verify.mjs */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const jiti = createJiti(import.meta.url);

const { CanonStore, normalize } = await jiti.import(join(projectRoot, "extensions/lib/store.ts"));
const { advise, BODY_WARN_CHARS, BODY_LARGE_CHARS, CAPSULE_CHARS } = await jiti.import(join(projectRoot, "extensions/lib/lint.ts"));
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
assert.equal(normalize("a/../../../outside/pwned"), "outside/pwned");
pass("dot segments clamp at the root; no address escapes the tree");

assert.equal(normalize("src/core/../other.ts"), "src/other");
pass("a .. between segments resolves instead of vanishing");

assert.equal(normalize(`${projDir}-vendor/src/thing.ts`, projDir), `${projDir.slice(1)}-vendor/src/thing`);
pass("the prefix strip respects the path boundary");

/* --- store ---------------------------------------------------------------------- */

store.write("src/core/config", {
  capsule: "Loads layered config; env beats file.",
  body: "Current truth about config loading.",
});
const back = store.read("src/core/config");
assert.equal(back.capsule, "Loads layered config; env beats file.");
assert.equal(back.body.trim(), "Current truth about config loading.");
pass("write and read round trip");

assert.equal(back.updated, today);
pass("write stamps updated");

store.write("src/wikilinked", { capsule: "[[src/core]] parent; env beats file.", body: "b" });
assert.equal(store.read("src/wikilinked").capsule, "[[src/core]] parent; env beats file.");
pass("a capsule opening with a wikilink survives the round trip");

store.write("src/bracket", { capsule: "[deprecated] superseded by [[src/core/config]].", body: "b" });
assert.equal(store.read("src/bracket").capsule, "[deprecated] superseded by [[src/core/config]].");
store.write("src/bracket", { body: "b2" });
assert.equal(store.read("src/bracket").capsule, "[deprecated] superseded by [[src/core/config]].");
pass("a bracketed capsule is a string, not a list, and survives a rewrite");

const yamlish = "Config: env wins; keep # comments current.";
store.write("src/yamlish", { capsule: yamlish, body: "b" });
assert.equal(store.read("src/yamlish").capsule, yamlish);
assert.match(readFileSync(join(projDir, ".canon/wiki/src/yamlish.md"), "utf8"), /capsule: "Config: env wins; keep # comments current\."/);
pass("colons and hashes in a capsule are quoted into valid YAML and read back");

writeFileSync(
  join(projDir, ".canon/wiki/src/crlf.md"),
  "---\r\ncapsule: Windows born.\r\nowner: shane\r\n---\r\nCRLF body.\r\n",
);
store.write("src/crlf", { capsule: "Rewritten." });
const crlf = readFileSync(join(projDir, ".canon/wiki/src/crlf.md"), "utf8");
assert.equal((crlf.match(/^---$/gm) ?? []).length, 2);
assert.match(crlf, /owner: shane/);
assert.match(crlf, /CRLF body\./);
assert.equal(store.read("src/crlf").capsule, "Rewritten.");
pass("a CRLF article survives a capsule-only write without nesting front matter");

writeFileSync(
  join(projDir, ".canon/wiki/src/blocky.md"),
  "---\naliases:\n  - src/old-blocky\ncapsule: Blocky.\n---\nBody.\n",
);
store.write("src/blocky", { body: "New body." });
assert.match(readFileSync(join(projDir, ".canon/wiki/src/blocky.md"), "utf8"), /aliases:\n {2}- src\/old-blocky/);
pass("a block-style aliases list survives a write");

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
assert.ok(existsSync(join(projDir, ".canon/wiki/journal/clobber.md")));
pass("a traversal address is contained inside wiki/");

assert.equal(store.resolve("src/core/config.ts", "").path, "src/core/config");
pass("resolve hits the exact address");

assert.equal(store.resolve("src/core/config/deep/child.ts").path, "src/core/config");
assert.equal(store.resolve("no/such/thing"), undefined);
pass("resolve walks to the nearest ancestor and misses honestly");

const j1 = store.journal({ body: "Project inception.", slug: "inception", subject: ["src/core/config"] });
const j2 = store.journal({ body: "Second entry, same slug.", slug: "inception" });
assert.notEqual(j1, j2);
assert.match(readFileSync(j1, "utf8"), /subject: \[src\/core\/config\]/);
assert.match(readFileSync(j1, "utf8"), /Project inception\./);
assert.match(readFileSync(j2, "utf8"), /Second entry/);
pass("journal entries are immutable files; wx EEXIST is the retry signal");

assert.match(j1.split("/").at(-1), new RegExp(`^${today}-inception\\.md$`));
pass("journal files carry their date");

assert.deepEqual(store.journalMentions("src/core/config"), [`${today}-inception.md`]);
assert.deepEqual(store.journalMentions("no/such/thing"), []);
pass("journal entries index by subject");

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

const linkAdvice = advise({ ...back, body: "See [[src/core/config]], [[src/core/config.ts]], [[missing/page]]." }, store);
assert.ok(linkAdvice.some((a) => a.includes("[[missing/page]]")));
assert.ok(!linkAdvice.some((a) => a.includes("[[src/core/config]]")));
assert.ok(!linkAdvice.some((a) => a.includes("[[src/core/config.ts]]")));
pass("dead links are named; live and extension-carrying links are not false positives");

/* --- surfacing ------------------------------------------------------------------ */

const surf = new Surfacer([{ name: "", dir: projDir, store }]);
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

const surfBatch = new Surfacer([{ name: "", dir: projDir, store }]);
surfBatch.collect([join(projDir, "src/core/config.ts")]);
surfBatch.collect(["src/wikilinked"]);
const batched = surfBatch.flush();
assert.match(batched, /Governing articles /);
assert.match(batched, /src\/core\/config/);
assert.match(batched, /src\/wikilinked/);
assert.equal(batched.match(/\[pi-canon\]/g).length, 1);
pass("staged touches coalesce into one flushed message");

const surfBudget = new Surfacer([{ name: "", dir: projDir, store }]);
store.write("src/core/other", { capsule: "c".repeat(SESSION_BUDGET_CHARS), body: "b" });
surfBudget.collect([join(projDir, "src/core/other.ts")]);
surfBudget.collect([join(projDir, "src/core/config.ts")]);
assert.match(surfBudget.flush(), /1 more staged; they surface next turn/);
assert.match(surfBudget.flush(), /article exists\. Read it/);
pass("a flush is bounded, overflow carries to the next turn, and a spent budget degrades capsules to pointers");

store.write("src/core", { capsule: "Core module truths.", body: "b" });
const surfNew = new Surfacer([{ name: "", dir: projDir, store }]);
const newPaths = surfNew.pathsIn({ file_path: join(projDir, "src/core/brandnew.ts") });
assert.deepEqual(newPaths, [join(projDir, "src/core/brandnew.ts")]);
surfNew.collect(newPaths);
assert.match(surfNew.flush(), /src\/core \(updated .*\): Core module truths/);
pass("a file about to be created surfaces its governing ancestor");

writeFileSync(join(projDir, "package.json"), "{}\n");
store.write("package", { capsule: "Package manifest truths.", body: "b" });
const surfRoot = new Surfacer([{ name: "", dir: projDir, store }]);
surfRoot.collect(surfRoot.pathsIn({ file_path: "package.json" }));
assert.match(surfRoot.flush(), /package \(updated .*\): Package manifest truths/);
pass("root files with no slash still surface");

const surfSeen = new Surfacer([{ name: "", dir: projDir, store }]);
surfSeen.collect([join(projDir, "src/core/config.ts")]);
surfSeen.markSeen("src/core/config");
assert.equal(surfSeen.flush(), undefined);
assert.equal(surfSeen.stats.spent, 0);
pass("reading an article withdraws its staged nudge and spends no budget");

const surfSettle = new Surfacer([{ name: "", dir: projDir, store }]);
surfSettle.collect([join(projDir, "src/core/config.ts")]);
surfSettle.flush();
const settle = surfSettle.settleNudge();
assert.match(settle, /Touched but not updated: src\/core\/config/);
assert.equal(surfSettle.settleNudge(), undefined);
pass("settle reminds once per batch of touches");

const surfDone = new Surfacer([{ name: "", dir: projDir, store }]);
surfDone.collect([join(projDir, "src/core/config.ts")]);
surfDone.flush();
surfDone.markUpdated("src/core/config");
assert.equal(surfDone.settleNudge(), undefined);
pass("an updated article draws no settle reminder");

surfDone.collect([join(projDir, "src/core/config.ts")]);
assert.match(surfDone.settleNudge(), /Touched but not updated: src\/core\/config/);
pass("an update does not exempt an article from later batches");

const surfOrder = new Surfacer([{ name: "", dir: projDir, store }]);
surfOrder.markUpdated("src/core/config");
surfOrder.collect([join(projDir, "src/core/config.ts")]);
assert.match(surfOrder.settleNudge(), /Touched but not updated: src\/core\/config/);
pass("a touch after an update still draws the reminder");

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
assert.match(result.content[0].text, new RegExp(`journal: ${today}-inception\\.md`));
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
const walked = await tools[0].execute("id", { action: "read", path: "src/core/config/deep" }, undefined, undefined, ctx);
assert.match(walked.content[0].text, /src\/core\/config governs src\/core\/config\/deep/);
assert.match(walked.content[0].text, /Current truth about config loading/);
const misread = await tools[0].execute("id", { action: "read", path: "no/such/thing" }, undefined, undefined, ctx);
assert.match(misread.content[0].text, /No article governs no\/such\/thing/);
pass("the tool strips absolute paths to addresses, writes with advice, journals, and read resolves to the governing article");

const dotted = await tools[0].execute(
  "id",
  { action: "write", path: join(projDir, "src/core/config.test.ts"), body: "Test notes.", capsule: "Covers config." },
  undefined,
  undefined,
  ctx,
);
assert.match(dotted.content[0].text, /Wrote src\/core\/config\.test\./);
assert.equal(store.read("src/core/config.test").body.trim(), "Test notes.");
assert.equal(store.read("src/core/config").body.trim(), "Current truth about config loading.");
pass("writing config.test.ts lands beside config, never on top of it");

await tools[0].execute("id", { action: "write", path: "src/newthing", body: "", capsule: "" }, undefined, undefined, ctx);
assert.equal(store.read("src/newthing").body.trim(), "New.");
pass("an empty-string body or capsule leaves stored content untouched");

const mapped2 = await tools[0].execute("id", { action: "map", path: "src/core" }, undefined, undefined, ctx);
assert.match(mapped2.content[0].text, /src\/core\/config: Loads layered config/);
const bogus = await tools[0].execute("id", { action: "bogus" }, undefined, undefined, ctx);
assert.match(bogus.content[0].text, /Unknown action "bogus"/);
pass("map answers through the tool and unknown actions name themselves");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 2);
pass("a quiet session stays quiet");

assert.equal(commands.length, 1);
await commands[0].def.handler("", ctx);
assert.equal(notices.length, 1);
assert.match(notices[0].msg, /articles, \d+ journal entries; \d+ seen this session/);
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

const rootTools = [];
registerPiCanon({ on() {}, registerTool: (t) => rootTools.push(t), registerCommand() {} }, { root: "kb" });
await rootTools[0].execute("id", { action: "write", path: "notes/a", body: "A.", capsule: "A." }, undefined, undefined, ctx);
assert.ok(existsSync(join(projDir, "kb/wiki/notes/a.md")));
const absRoot = join(work, "abs-canon");
const absTools = [];
registerPiCanon({ on() {}, registerTool: (t) => absTools.push(t), registerCommand() {} }, { root: absRoot });
await absTools[0].execute("id", { action: "write", path: "notes/b", body: "B.", capsule: "B." }, undefined, undefined, ctx);
assert.ok(existsSync(join(absRoot, "wiki/notes/b.md")));
pass("root places the store, relative to the project or absolute");

const imported = spawnSync(
  process.execPath,
  ["--input-type=module", "-e", `await import(${JSON.stringify(join(projectRoot, "extensions/index.js"))});`],
  { encoding: "utf8" },
);
assert.equal(imported.status, 0, imported.stderr);
pass("the entry point loads under plain node, no jiti");

const lakeDir = join(work, "lake");
mkdirSync(join(lakeDir, "fundamentals"), { recursive: true });
writeFileSync(join(lakeDir, "fundamentals/market_cap.csv"), "data\n");
const lakeTools = [];
registerPiCanon({ on() {}, registerTool: (t) => lakeTools.push(t), registerCommand() {} }, { mounts: [lakeDir] });
await lakeTools[0].execute(
  "id",
  { action: "write", path: "lake:fundamentals/market_cap", body: "Market cap truths.", capsule: "Free-float market cap, daily." },
  undefined,
  undefined,
  ctx,
);
assert.ok(existsSync(join(lakeDir, ".canon/wiki/fundamentals/market_cap.md")));
const lakeRead = await lakeTools[0].execute(
  "id",
  { action: "read", path: join(lakeDir, "fundamentals/market_cap.csv") },
  undefined,
  undefined,
  ctx,
);
assert.match(lakeRead.content[0].text, /lake:fundamentals\/market_cap/);
assert.match(lakeRead.content[0].text, /Market cap truths/);
pass("a mounted directory carries its own store, addressed by name or absolute path");

const lakeStore = new CanonStore(join(lakeDir, ".canon"));
const surfLake = new Surfacer([
  { name: "", dir: projDir, store },
  { name: "lake", dir: lakeDir, store: lakeStore },
]);
surfLake.collect(surfLake.pathsIn({ command: `python etl.py ${join(lakeDir, "fundamentals/market_cap.csv")}` }));
assert.match(surfLake.flush(), /lake:fundamentals\/market_cap \(updated .*\): Free-float market cap, daily/);
pass("a mounted asset surfaces under its qualified address");

const entry = await jiti.import(join(projectRoot, "extensions/index.js"));
const entryTools = [];
entry.default({ on() {}, registerTool: (t) => entryTools.push(t), registerCommand() {} });
assert.equal(entryTools[0].name, "pi_canon");
assert.equal(typeof entry.registerPiCanon, "function");
pass("the package entry exposes the default and named exports pi loads");

console.log(`\nall ${gates} gates green`);
