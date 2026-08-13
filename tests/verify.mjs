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
const { advise, unretained, BODY_WARN_CHARS, BODY_LARGE_CHARS, CAPSULE_CHARS } = await jiti.import(join(projectRoot, "extensions/lib/lint.ts"));
const { Surfacer } = await jiti.import(join(projectRoot, "extensions/lib/surfacing.ts"));
const { buildRetriever, governsAnAsset, intentQuery, LexicalRetriever, residue, RULE_SCOPE, userIntent } =
  await jiti.import(join(projectRoot, "extensions/lib/retrieval.ts"));
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
assert.match(readFileSync(join(projDir, ".canon/articles/src/yamlish.md"), "utf8"), /capsule: "Config: env wins; keep # comments current\."/);
pass("colons and hashes in a capsule are quoted into valid YAML and read back");

writeFileSync(
  join(projDir, ".canon/articles/src/crlf.md"),
  "---\r\ncapsule: Windows born.\r\nowner: shane\r\n---\r\nCRLF body.\r\n",
);
store.write("src/crlf", { capsule: "Rewritten." });
const crlf = readFileSync(join(projDir, ".canon/articles/src/crlf.md"), "utf8");
assert.equal((crlf.match(/^---$/gm) ?? []).length, 2);
assert.match(crlf, /owner: shane/);
assert.match(crlf, /CRLF body\./);
assert.equal(store.read("src/crlf").capsule, "Rewritten.");
pass("a CRLF article survives a capsule-only write without nesting front matter");

writeFileSync(
  join(projDir, ".canon/articles/src/blocky.md"),
  "---\naliases:\n  - src/old-blocky\ncapsule: Blocky.\n---\nBody.\n",
);
store.write("src/blocky", { body: "New body." });
assert.match(readFileSync(join(projDir, ".canon/articles/src/blocky.md"), "utf8"), /aliases:\n {2}- src\/old-blocky/);
pass("a block-style aliases list survives a write");

writeFileSync(
  join(projDir, ".canon/articles/src/handmade.md"),
  "---\ncapsule: Hand written.\ntags:\n  - a\n  - b\nowner: shane\n---\nBody.\n",
);
const handmade = store.read("src/handmade");
assert.equal(handmade.capsule, "Hand written.");
assert.equal(handmade.body.trim(), "Body.");
pass("foreign front matter keys are tolerated, not errors");

store.write("src/handmade", { body: "New body." });
const rewritten = readFileSync(join(projDir, ".canon/articles/src/handmade.md"), "utf8");
assert.match(rewritten, /tags:\n {2}- a\n {2}- b/);
assert.match(rewritten, /owner: shane/);
assert.match(rewritten, /capsule: Hand written\./);
pass("foreign keys survive a write, multi-line blocks included");

const escaped = store.write("../../journal/clobber", { body: "contained" });
assert.equal(escaped.path, "journal/clobber");
assert.ok(existsSync(join(projDir, ".canon/articles/journal/clobber.md")));
pass("a traversal address is contained inside articles/");

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

/* Ordering is by the recorded instant, not the filename. Names are date plus slug with
   -2, -3 for collisions, so lexicographic order puts -10 before -2 and the unsuffixed
   name after every suffixed one: "the newest three" was not the newest three. */
const seq = [];
for (let n = 1; n <= 11; n += 1) seq.push(store.journal({ body: `Event ${n}.`, slug: "seq", subject: ["src/ordered"] }));
const byTime = store.journalMentions("src/ordered");
assert.deepEqual(byTime, seq.map((f) => f.split("/").at(-1)), "entries come back in the order written");
assert.ok(byTime.at(-1).includes("-11"), "the eleventh entry is last, not the second");
pass("the journal orders by when an entry was recorded, not by how its filename sorts");

/* A subject containing a comma used to split into two nonexistent addresses. */
store.journal({ body: "Odd address.", slug: "comma", subject: ["src/a,b/thing"] });
assert.equal(store.journalMentions("src/a,b/thing").length, 1);
assert.deepEqual(store.journalMentions("src/a"), []);
pass("a subject address containing a comma survives the round trip");

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

/* 2.0 deleted the session budget: no character count decides what an agent sees, so a
   long capsule surfaces whole, in the same flush, alongside every other staged article,
   and nothing is ever held back to a later turn. */
const surfUnbounded = new Surfacer([{ name: "", dir: projDir, store }]);
const longCapsule = "c".repeat(8000);
store.write("src/core/other", { capsule: longCapsule, body: "b" });
surfUnbounded.collect([join(projDir, "src/core/other.ts")]);
surfUnbounded.collect([join(projDir, "src/core/config.ts")]);
const unbounded = surfUnbounded.flush();
assert.ok(unbounded.includes(longCapsule), "a long capsule surfaces whole, never truncated");
assert.match(unbounded, /src\/core\/config/);
assert.doesNotMatch(unbounded, /more staged/);
assert.doesNotMatch(unbounded, /article exists\. Read it/);
assert.equal(surfUnbounded.flush(), undefined, "nothing is held back for a later turn");
pass("no character count gates surfacing: every staged article surfaces whole in one flush");

/* The budget is gone as an option name too, so a caller carrying one gets told. */
assert.throws(
  () => registerPiCanon({ on() {}, registerTool() {}, registerCommand() {} }, { budget: 4000 }),
  /unknown option "budget"/,
);
pass("the deleted budget is not a silently ignored option");

/* Cost is recorded instead of charged: what surfacing took from the window is
   readable per article, which is what the budget constant used to decide in advance. */
const surfCost = new Surfacer([{ name: "", dir: projDir, store }]);
assert.equal(surfCost.stats.chars, 0);
surfCost.collect([join(projDir, "src/core/config.ts")]);
const costed = surfCost.flush();
assert.ok(surfCost.stats.chars > 0, "a surfaced article records what it cost");
assert.ok(
  surfCost.stats.chars < costed.length,
  "cost is the article's own line, not the whole framed message",
);
assert.equal(surfCost.stats.surfaced, 1);
pass("surfacing records context taken per article rather than spending an allowance");

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
assert.equal(surfSeen.stats.chars, 0);
pass("reading an article withdraws its staged nudge and costs no context");

/* --- presence -------------------------------------------------------------------
   Seen means "the agent can see it", not "we sent it once". The projection is the
   only witness: what folded or compacted away is already absent from it. */

const CAPSULE_PRESENT = "Vendor feed pages at 1000 despite the docs; never widen the batch.";
mkdirSync(join(projDir, "src/feed"), { recursive: true });
writeFileSync(join(projDir, "src/feed/sync.ts"), "export const s = 1;\n");
store.write("src/feed/sync", { capsule: CAPSULE_PRESENT, body: "b" });

const surfPresent = new Surfacer([{ name: "", dir: projDir, store }]);
surfPresent.collect([join(projDir, "src/feed/sync.ts")]);
const presentLine = surfPresent.flush();
assert.equal(surfPresent.stats.present, 1);
assert.equal(surfPresent.stats.surfaced, 1);

/* Still in the window: staged again, withheld again. */
surfPresent.observe([{ role: "user", content: `earlier turn\n${presentLine}\nlater turn` }]);
assert.equal(surfPresent.stats.present, 1);
surfPresent.collect([join(projDir, "src/feed/sync.ts")]);
assert.equal(surfPresent.flush(), undefined);
pass("an article still in the projection does not surface a second time");

/* Folded away: the mark is gone, so the next touch surfaces it again. */
surfPresent.observe([{ role: "user", content: "the turn that carried it was folded to a digest" }]);
assert.equal(surfPresent.stats.present, 0, "an absent article stops counting as present");
assert.equal(surfPresent.stats.surfaced, 1, "but it is still counted as surfaced this session");
assert.equal(surfPresent.stats.chars, 0, "and stops occupying context");
surfPresent.collect([join(projDir, "src/feed/sync.ts")]);
assert.match(surfPresent.flush(), /src\/feed\/sync/);
pass("an article folded out of the projection re-surfaces on the next touch");

/* A touch is what re-surfaces it. Absence alone never pushes anything. */
const surfQuiet = new Surfacer([{ name: "", dir: projDir, store }]);
surfQuiet.collect([join(projDir, "src/feed/sync.ts")]);
surfQuiet.flush();
surfQuiet.observe([{ role: "user", content: "nothing of ours survived here" }]);
assert.equal(surfQuiet.flush(), undefined);
pass("departure alone never surfaces anything; only a fresh touch does");

/* Reading through the tool marks presence off the same string the result prints. */
const surfRead = new Surfacer([{ name: "", dir: projDir, store }]);
surfRead.collect([join(projDir, "src/feed/sync.ts")]);
surfRead.markSeen("src/feed/sync", CAPSULE_PRESENT);
assert.equal(surfRead.flush(), undefined);
surfRead.observe([{ role: "toolResult", content: `src/feed/sync\ncapsule: ${CAPSULE_PRESENT}\n\nbody` }]);
surfRead.collect([join(projDir, "src/feed/sync.ts")]);
assert.equal(surfRead.flush(), undefined, "a read article is present while its result is live");
surfRead.observe([{ role: "user", content: "that result got folded" }]);
surfRead.collect([join(projDir, "src/feed/sync.ts")]);
assert.match(surfRead.flush(), /src\/feed\/sync/, "and re-surfaces once the result is gone");
pass("a pi_canon read establishes presence and expires with its own tool result");

/* The case presence exists to catch, and the case a capsule mark got wrong. An article
   read in full carries the rule in its BODY; the capsule is also the text of the
   one-line surfaced nudge, so marking on the capsule kept the article "present" on the
   strength of a line that never held the rule. Marking on what actually entered the
   window makes a folded body an absence, which is what it is. */
const CAPSULE_THIN = "Audit actors follow the scheduler convention for this service.";
const BODY_RULE =
  "An actor counts as automated only when it reads system: followed by an id the " +
  "scheduler registered. The registered jobs are billing-close, inventory-reconcile " +
  "and nightly-dispatch, and an unregistered id lands on a named person.";
store.write("src/audit/actor", { capsule: CAPSULE_THIN, body: BODY_RULE });
mkdirSync(join(projDir, "src/audit"), { recursive: true });
writeFileSync(join(projDir, "src/audit/actor.ts"), "export const a = 4;\n");

const surfBody = new Surfacer([{ name: "", dir: projDir, store }]);
surfBody.collect([join(projDir, "src/audit/actor.ts")]);
surfBody.markSeen("src/audit/actor", `${CAPSULE_THIN}\n${BODY_RULE}`);
surfBody.observe([{ role: "toolResult", content: `src/audit/actor\ncapsule: ${CAPSULE_THIN}\n\n${BODY_RULE}` }]);
assert.equal(surfBody.stats.present, 1, "present while the body it delivered is live");

/* The capsule survives; the body does not. The old mark read this as present. */
surfBody.observe([{ role: "user", content: `[pi-canon] src/audit/actor: ${CAPSULE_THIN}` }]);
assert.equal(surfBody.stats.present, 0, "a surviving capsule is not a surviving article");
surfBody.collect([join(projDir, "src/audit/actor.ts")]);
assert.match(surfBody.flush(), /src\/audit\/actor/);
pass("an article whose body folded away is absent even when its capsule survives");

/* A body is prose, so it has line breaks in it, and the projection arrives through
   JSON.stringify where a break is the two characters \ and n. Both sides have to agree
   across one or the mark never matches and the article re-surfaces on every touch. */
const BODY_PARAS = `Actors are checked in two steps.

First the prefix: an actor is automated only when it reads system: followed by an id.

Then the registry: billing-close, inventory-reconcile and nightly-dispatch are the
registered jobs, and anything else lands on a named person.`;
store.write("src/audit/paras", { capsule: CAPSULE_THIN, body: BODY_PARAS });
writeFileSync(join(projDir, "src/audit/paras.ts"), "export const p = 5;\n");

const surfParas = new Surfacer([{ name: "", dir: projDir, store }]);
surfParas.collect([join(projDir, "src/audit/paras.ts")]);
surfParas.markSeen("src/audit/paras", `${CAPSULE_THIN}\n${BODY_PARAS}`);
surfParas.observe([{ role: "toolResult", content: `src/audit/paras\ncapsule: ${CAPSULE_THIN}\n\n${BODY_PARAS}` }]);
assert.equal(surfParas.stats.present, 1, "a multi-paragraph body is present while it is live");
surfParas.collect([join(projDir, "src/audit/paras.ts")]);
assert.equal(surfParas.flush(), undefined, "and is not re-surfaced under the agent");
pass("a mark spanning a line break still matches the JSON-escaped projection");

/* Writing an article is not a licence to stop checking. markUpdated used to assert
   presence with no evidence, which cleared the mark, and observe() skips a seen path
   that has no mark: the article then stayed present for the whole session and could
   never re-surface however much folded away. */
const surfWrote = new Surfacer([{ name: "", dir: projDir, store }]);
surfWrote.markUpdated("src/feed/sync", `${CAPSULE_PRESENT}\nthe body the agent just wrote`);
surfWrote.observe([{ role: "user", content: "unrelated turn; the write is long gone" }]);
assert.equal(surfWrote.stats.present, 0, "a written article expires like any other");
surfWrote.collect([join(projDir, "src/feed/sync.ts")]);
assert.match(surfWrote.flush(), /src\/feed\/sync/, "and re-surfaces on the next touch");
pass("an article that was written expires from the window like one that was read");

/* Never observing is exactly 1.0: nothing expires, so a harness with no projection
   loses the mechanism and nothing else. Neither is a non-array or unserializable one
   evidence of absence. */
const surfBlind = new Surfacer([{ name: "", dir: projDir, store }]);
surfBlind.collect([join(projDir, "src/feed/sync.ts")]);
surfBlind.flush();
surfBlind.observe(undefined);
surfBlind.observe("not an array");
assert.equal(surfBlind.stats.present, 1);
surfBlind.collect([join(projDir, "src/feed/sync.ts")]);
assert.equal(surfBlind.flush(), undefined);
pass("no usable projection degrades to 1.0 behavior rather than expiring blind");

/* A cycle is not unreadability. Reading the projection's strings directly, rather than
   stringifying it, means a self-referential message array is still a projection and its
   contents still count: this one does not carry the article, so the article is absent
   and says so. Under JSON.stringify the same input threw and was scored as no evidence,
   which kept a departed article present. */
const cyclic = [{ role: "user", content: "nothing of ours here" }];
cyclic[0].self = cyclic;
const surfCycle = new Surfacer([{ name: "", dir: projDir, store }]);
surfCycle.collect([join(projDir, "src/feed/sync.ts")]);
surfCycle.flush();
surfCycle.observe(cyclic);
assert.equal(surfCycle.stats.present, 0, "a cyclic projection is read, not skipped");
pass("a self-referential projection is still read instead of being treated as unreadable");

/* Two collisions Codex demonstrated against the single-tail mark, both in the expensive
   direction: the article is gone and nothing re-surfaces it.

   One, a shared ending. Two articles that end the same way shared a tail, so the
   survivor kept the departed one marked present. Addresses are unique, which is why
   identity is now required alongside liveness. */
store.write("src/left", { capsule: "Left hand side.", body: `Distinct opening for left.\n${"Shared maintenance footer, reviewed quarterly by the platform team.".repeat(3)}` });
store.write("src/right", { capsule: "Right hand side.", body: `Distinct opening for right.\n${"Shared maintenance footer, reviewed quarterly by the platform team.".repeat(3)}` });
writeFileSync(join(projDir, "src/left.ts"), "export const l = 1;\n");
writeFileSync(join(projDir, "src/right.ts"), "export const r = 2;\n");
const surfShared = new Surfacer([{ name: "", dir: projDir, store }]);
surfShared.markSeen("src/left", `Left hand side.\n${store.read("src/left").body}`);
surfShared.observe([{ role: "toolResult", content: `src/right\ncapsule: Right hand side.\n\n${store.read("src/right").body}` }]);
assert.equal(surfShared.stats.present, 0,
  "a different article sharing the tail must not keep this one present");
pass("two articles with a common ending do not stand in for each other");

/* Two, a literal escape sequence. Fingerprinting JSON.stringify output forced escapes to
   be erased, which made an article mentioning a literal backslash-n identical to one
   without it. Reading the projection's strings directly means nothing is erased. */
const ESCAPED = "Delimiter policy: rows are split on a literal \\n and never on \\t.";
const PLAIN = "Delimiter policy: rows are split on a literal  and never on .";
store.write("src/delim", { capsule: "Delimiters.", body: ESCAPED });
writeFileSync(join(projDir, "src/delim.ts"), "export const d = 3;\n");
const surfEsc = new Surfacer([{ name: "", dir: projDir, store }]);
surfEsc.markSeen("src/delim", `Delimiters.\n${ESCAPED}`);
surfEsc.observe([{ role: "toolResult", content: `src/delim\ncapsule: Delimiters.\n\n${PLAIN}` }]);
assert.equal(surfEsc.stats.present, 0,
  "text with the escapes stripped is not the article that contained them");
surfEsc.markSeen("src/delim", `Delimiters.\n${ESCAPED}`);
surfEsc.observe([{ role: "toolResult", content: `src/delim\ncapsule: Delimiters.\n\n${ESCAPED}` }]);
assert.equal(surfEsc.stats.present, 1, "and the real text still reads as present");
pass("a literal escape sequence is content, not whitespace to be erased");

/* A capsule too short to be distinctive is never expired: a missed re-surface costs
   one nudge that does not happen, a false expiry spams the window every turn. */
store.write("src/core/terse", { capsule: "Cache.", body: "b" });
writeFileSync(join(projDir, "src/core/terse.ts"), "export const z = 3;\n");
const surfTerse = new Surfacer([{ name: "", dir: projDir, store }]);
surfTerse.collect([join(projDir, "src/core/terse.ts")]);
surfTerse.flush();
surfTerse.observe([{ role: "user", content: "unrelated" }]);
assert.equal(surfTerse.stats.present, 1);
pass("a capsule too short to test is never expired");

/* --- retrieval ------------------------------------------------------------------
   The residue is what the spine can never reach: articles at addresses that govern no
   asset on disk. Everything else is answered by address, for free, and must not be
   ranked, or retrieval would compete with the address instead of completing it. */

store.write("policy/rounding", {
  capsule: "Ledger totals round half to even; never round half up in reconciliation.",
  body: "Decided after a vendor reconciliation mismatch. Applies wherever money is summed.",
});
store.write("policy/timezones", {
  capsule: "Every stored timestamp is UTC; display converts, storage never does.",
  body: "A local timestamp in the lake is a bug regardless of which service wrote it.",
});

const free = residue(store, projDir).map((c) => c.path);
assert.ok(free.includes("policy/rounding"), "an article governing no asset is residue");
assert.ok(!free.includes("src/core/config"), "an article governing a real file is not");
assert.ok(!free.includes("src/feed/sync"), "extension-dropped addresses still match their asset");
pass("the residue is exactly the articles no asset address can reach");

assert.equal(governsAnAsset(projDir, "src/core/config"), true);
assert.equal(governsAnAsset(projDir, "src/core"), true, "a directory is an asset");
assert.equal(governsAnAsset(projDir, "policy/rounding"), false);
assert.equal(governsAnAsset(projDir, "src/core/config.test"), false, "a longer stem is not a match");
pass("an address governs an asset only when something on disk normalizes back to it");

/* none is the control: 1.0 exactly, nothing unaddressed ever surfaces. */
const surfNone = new Surfacer([{ name: "", dir: projDir, store }]);
surfNone.noteIntent("read", { file_path: "ledger/reconcile.py" });
surfNone.retrieve();
assert.equal(surfNone.flush(), undefined);
pass("retrieval none never surfaces an unaddressed article");

/* lexical ranks the residue against this turn's intent. */
const surfLex = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever());
surfLex.noteIntent("shell", { command: "python reconciliation totals rounding check" });
surfLex.retrieve();
const lexical = surfLex.flush();
assert.match(lexical, /policy\/rounding/, "the article the query touches surfaces");
assert.doesNotMatch(lexical, /policy\/timezones/, "one it does not touch stays put");
pass("lexical retrieval surfaces an unaddressed article the intent reaches");

/* Ranked lines never displace an addressed one: the address is certain, the score is a
   guess, so the certainty leads the message. */
const surfRank = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever());
surfRank.collect([join(projDir, "src/feed/sync.ts")]);
surfRank.noteIntent("shell", { command: "reconciliation totals rounding" });
surfRank.retrieve();
const ordered = surfRank.flush();
assert.ok(
  ordered.indexOf("src/feed/sync") < ordered.indexOf("policy/rounding"),
  "the addressed article leads the ranked one",
);
pass("addressed articles precede retrieved ones in a flush");

/* Sharing one token with the query scores above zero, so an unbounded fan-out lets a
   large residue fill a message with guesses. The cap is on transport, not relevance:
   what does not ride this turn is still eligible next turn, and the addressed line is
   never one of the things counted, because the address is a certainty. */
const fanStore = new CanonStore(join(work, "fan", ".canon"));
for (let i = 0; i < 9; i += 1) {
  fanStore.write(`policy/rounding-${i}`, {
    capsule: `Rule ${i}: reconciliation rounding rule number ${i}.`,
    body: `Reconciliation rounding, variant ${i}. ${"detail ".repeat(i + 1)}`,
  });
}
const fanDir = join(work, "fan");
const surfFan = new Surfacer([{ name: "", dir: fanDir, store: fanStore }], new LexicalRetriever());
surfFan.collect([join(fanDir, "src/feed/sync.ts")]);
surfFan.noteIntent("shell", { command: "reconciliation rounding rule" });
surfFan.retrieve();
const fanned = surfFan.flush().split("\n").filter((line) => line.startsWith("policy/"));
assert.equal(fanned.length, 3, `nine matching articles rode one message: ${fanned.length}`);
pass("ranked articles are capped per message; the address spine is not counted against it");

/* Held back, not discarded. The next turn stages the next three, so a large residue is
   delivered over turns rather than dropped or dumped at once. */
surfFan.noteIntent("shell", { command: "reconciliation rounding rule" });
surfFan.retrieve();
const second = surfFan.flush().split("\n").filter((line) => line.startsWith("policy/"));
assert.equal(second.length, 3, "the next turn carries the next three");
assert.ok(
  !second.some((line) => fanned.includes(line)),
  "the second message repeats nothing from the first",
);
pass("what the cap held back is still eligible on the following turn");

/* Intent is this turn's, and it is evidence-free: a tool RESULT never reaches the
   query. pi-fold measured a window carrying 29,244 characters of tool output against
   125 of intent, and every retrieval number it produced was that one defect. */
assert.equal(intentQuery([{ toolName: "read", input: { file_path: "a/b.ts" } }]), "read a/b.ts");
assert.equal(intentQuery([{ role: "user", content: "why is the total off" }]), "why is the total off");
assert.equal(intentQuery([{ role: "toolResult", content: "rounding rounding rounding" }]), "");
assert.equal(
  intentQuery([{ role: "user", content: "first" }, { toolName: "grep", input: { pattern: "second" } }]),
  "grep second\nfirst",
  "newest intent leads the query",
);
pass("the query is intent, never evidence, newest first");

const surfCleared = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever());
surfCleared.noteIntent("shell", { command: "reconciliation totals rounding" });
surfCleared.flush();
surfCleared.retrieve();
assert.equal(surfCleared.flush(), undefined, "last turn's intent does not rank this turn");
pass("intent clears at the flush, so a turn is ranked against itself only");

/* A bring-your-own retriever is a function, so the package never carries a model. */
const byo = {
  name: "byo",
  score: (_query, candidates) => new Map(candidates.map((c) => [c.path, c.path === "policy/timezones" ? 0.9 : 0])),
};
const surfByo = new Surfacer([{ name: "", dir: projDir, store }], buildRetriever(byo));
surfByo.noteIntent("read", { file_path: "anything" });
surfByo.retrieve();
assert.match(surfByo.flush(), /policy\/timezones/);
assert.equal(buildRetriever(undefined).name, "none");
assert.equal(buildRetriever("lexical").name, "lexical");
assert.throws(() => buildRetriever("embeddings"), /retrieval must be/);
assert.throws(() => buildRetriever({ score: () => new Map() }), /needs a name/);
pass("retrieval accepts a built-in name or a caller-supplied scorer, and refuses anything else");

/* A retriever that throws costs the turn its ranking, never the turn. */
const surfThrow = new Surfacer(
  [{ name: "", dir: projDir, store }],
  { name: "angry", score: () => { throw new Error("no model loaded"); } },
);
surfThrow.collect([join(projDir, "src/feed/sync.ts")]);
surfThrow.noteIntent("read", { file_path: "anything" });
surfThrow.retrieve();
assert.match(surfThrow.flush(), /src\/feed\/sync/);
pass("a retriever that throws never breaks the turn");

/* Scores are recorded beside what the line cost, which is what replaced the budget:
   the cutoff is a question for the data, not a constant chosen in advance. */
const rankTraceFile = join(work, "retrieval-trace.jsonl");
process.env.PI_CANON_TRACE = rankTraceFile;
const surfRankTrace = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever());
surfRankTrace.collect([join(projDir, "src/feed/sync.ts")]);
surfRankTrace.noteIntent("shell", { command: "reconciliation totals rounding" });
surfRankTrace.retrieve();
surfRankTrace.flush();
delete process.env.PI_CANON_TRACE;
const surfacedRows = readFileSync(rankTraceFile, "utf8").trim().split("\n").map(JSON.parse)
  .filter((row) => row.kind === "surfaced");
const ranked = surfacedRows.find((row) => row.path === "policy/rounding");
const addressed = surfacedRows.find((row) => row.path === "src/feed/sync");
assert.ok(ranked.score > 0 && ranked.chars > 0 && ranked.via === "lexical");
assert.equal(addressed.score, null, "an addressed article was never ranked and says so");
assert.equal(addressed.via, "address");
pass("every surfaced line records what it cost and how relevant it was thought to be");

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

/* A bad retrieval option is a registration error, not a mid-session surprise. */
const quietPi = { on() {}, registerTool() {}, registerCommand() {} };
assert.throws(() => registerPiCanon(quietPi, { retrieval: "embeddings" }), /retrieval must be/);
registerPiCanon(quietPi, { retrieval: "lexical" });
registerPiCanon(quietPi, { retrieval: { name: "byo", score: () => new Map() } });
pass("retrieval is validated at registration, built-in name or supplied scorer");

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
assert.ok(
  handlers.tool_call && handlers.session_start && handlers.turn_end &&
  handlers.agent_settled && handlers.context,
);
pass("registration wires the tool and the five events");

const notices = [];
const ctx = { cwd: projDir, ui: { notify: (msg, level) => notices.push({ msg, level }) } };
for (const fn of handlers.session_start) fn({ reason: "startup" }, ctx);
assert.equal(sent.length, 1);
assert.match(sent[0].msg.content, /\d+ articles govern this project/);
assert.equal(sent[0].opts.deliverAs, "nextTurn");
pass("a session opens with one orientation line");

for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t1", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t2", input: { path: join(projDir, ".canon/articles/src/wikilinked.md") } }, ctx);
assert.equal(sent.length, 1);
for (const fn of handlers.turn_end) fn({ turnIndex: 0 }, ctx);
assert.equal(sent.length, 2);
assert.match(sent[1].msg.content, /Loads layered config/);
assert.equal(sent[1].opts.deliverAs, "steer");
pass("touches stage silently; the turn flushes one steer message");

for (const fn of handlers.tool_call) fn({ toolName: "read", toolCallId: "t3", input: { path: join(projDir, "src/core/config.ts") } }, ctx);
for (const fn of handlers.tool_call) fn({ toolName: "pi_canon", toolCallId: "t4", input: { action: "read", path: "src/core/config" } }, ctx);
for (const fn of handlers.turn_end) fn({ turnIndex: 1 }, ctx);
assert.equal(sent.length, 2);
pass("repeat touches and pi_canon's own calls stay silent");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 3);
assert.match(sent[2].msg.content, /Touched but not updated/);
assert.equal(sent[2].opts.deliverAs, "nextTurn");
pass("settle delivers the write after reminder for the next turn");

/* A send that throws must not leave the package believing the agent was told. Both
   flush and settle commit their work before handing the message over, because the
   message is built from that work, so a failed send has to put it back. */
const surfUndo = new Surfacer([{ name: "", dir: projDir, store }]);
surfUndo.collect([join(projDir, "src/feed/sync.ts")]);
const firstTry = surfUndo.flush();
assert.match(firstTry, /src\/feed\/sync/);
assert.equal(surfUndo.stats.present, 1);
assert.equal(surfUndo.settleNudge() !== undefined, true);

surfUndo.undoFlush();
assert.equal(surfUndo.stats.present, 0, "nothing counts as seen after a failed send");
assert.equal(surfUndo.stats.surfaced, 0, "and nothing counts as surfaced");
assert.equal(surfUndo.stats.chars, 0, "and it occupies no context");
assert.equal(surfUndo.flush(), firstTry, "the same line is offered again next turn");
assert.match(surfUndo.settleNudge(), /Touched but not updated/, "and the reminder is still owed");
pass("a delivery that throws is undone and offered again, not silently believed");

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

/* And the address it landed at has to survive being handed back. map prints
   src/core/config.test; normalizing that a second time drops .test and reads
   src/core/config, which exists, so the tool returned a DIFFERENT article and said
   nothing (Sol Pro, 2026-08-13). Reading through the tool is the only way to catch
   this: the store never sees the second normalize. */
const roundTrip = await tools[0].execute(
  "id", { action: "read", path: "src/core/config.test" }, undefined, undefined, ctx,
);
assert.match(roundTrip.content[0].text, /Test notes\./, "the dotted address reads its own article");
assert.ok(!roundTrip.content[0].text.includes("Current truth about config loading"),
  "and never silently answers with its parent");
/* The asset path still canonicalises, and a real file wins over a look-alike address. */
const viaAsset = await tools[0].execute(
  "id", { action: "read", path: "src/core/config.ts" }, undefined, undefined, ctx,
);
assert.match(viaAsset.content[0].text, /Current truth about config loading/);
pass("a canonical dotted address round-trips through the tool instead of collapsing to its parent");

await tools[0].execute("id", { action: "write", path: "src/newthing", body: "", capsule: "" }, undefined, undefined, ctx);
assert.equal(store.read("src/newthing").body.trim(), "New.");
pass("an empty-string body or capsule leaves stored content untouched");

store.write("src/capped", { capsule: "Capped.", body: "b" });
for (let n = 1; n <= 5; n += 1) store.journal({ body: `Event ${n}.`, slug: "capped-event", subject: ["src/capped"] });
const capped = await tools[0].execute("id", { action: "read", path: "src/capped" }, undefined, undefined, ctx);
assert.match(capped.content[0].text, /journal: [^\n]+ and 2 earlier$/);
assert.equal(capped.content[0].text.split("journal: ")[1].split(" and ")[0].split(", ").length, 3);
assert.ok(!capped.content[0].text.includes("Event "));
pass("the journal index shows the newest three filenames and no content");

const mapped2 = await tools[0].execute("id", { action: "map", path: "src/core" }, undefined, undefined, ctx);
assert.match(mapped2.content[0].text, /src\/core\/config: Loads layered config/);
const bogus = await tools[0].execute("id", { action: "bogus" }, undefined, undefined, ctx);
assert.match(bogus.content[0].text, /Unknown action "bogus"/);
pass("map answers through the tool and unknown actions name themselves");

for (const fn of handlers.agent_settled) fn(undefined, ctx);
assert.equal(sent.length, 3);
pass("a quiet session stays quiet");

assert.equal(commands.length, 1);
await commands[0].def.handler("", ctx);
assert.equal(notices.length, 1);
assert.match(
  notices[0].msg,
  /articles, \d+ journal entries; \d+ surfaced this session, \d+ still in context taking \d+ chars/,
);
assert.equal(notices[0].level, "info");
assert.equal(sent.length, 3);
pass("the status command notifies the user and tells the model nothing");

const coldDir = join(work, "cold-proj");
mkdirSync(coldDir, { recursive: true });
const coldSent = [];
const coldHandlers = {};
registerPiCanon(
  { on: (n, f) => (coldHandlers[n] ??= []).push(f), registerTool() {}, registerCommand() {}, sendMessage: (msg, opts) => coldSent.push({ msg, opts }) },
  {},
);
for (const fn of coldHandlers.session_start) fn({ reason: "startup" }, { cwd: coldDir });
assert.equal(coldSent.length, 1);
assert.match(coldSent[0].msg.content, /No articles yet in .canon\//);
pass("an empty store opens with the invitation to start it");

assert.ok(advise({ ...back, capsule: "Added inventory pagination and stock aggregation." }, store)
  .some((a) => a.includes("change log")));
assert.ok(!advise(back, store).some((a) => a.includes("change log")));
pass("a changelog-flavored capsule draws a redirect to current truth");

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

/* resurface is the 2.0 mechanism behind one switch, end to end through the harness:
   on, an article whose turn left the window comes back on the next touch; off, the
   context hook is inert and a surfaced article is never surfaced again. */
function driveResurface(resurface) {
  const h = {};
  const out = [];
  registerPiCanon(
    { on: (n, f) => (h[n] ??= []).push(f), registerTool() {}, registerCommand() {}, sendMessage: (m) => out.push(m) },
    { resurface, root: join(work, `resurface-${resurface}`) },
  );
  const canonRoot = new CanonStore(join(work, `resurface-${resurface}`));
  canonRoot.write("src/feed/sync", { capsule: CAPSULE_PRESENT, body: "b" });
  const touch = () => {
    for (const fn of h.tool_call) fn({ toolName: "read", input: { file_path: "src/feed/sync.ts" } }, ctx);
    for (const fn of h.turn_end) fn(undefined, ctx);
  };
  touch();
  const first = out.filter((m) => m.content.includes("src/feed/sync")).length;
  for (const fn of h.context) fn({ messages: [{ role: "user", content: "everything of ours folded away" }] }, ctx);
  touch();
  return { first, after: out.filter((m) => m.content.includes("src/feed/sync")).length };
}
const on = driveResurface(true);
assert.equal(on.first, 1);
assert.equal(on.after, 2, "resurface: true brings a departed article back on the next touch");
const off = driveResurface(false);
assert.equal(off.first, 1);
assert.equal(off.after, 1, "resurface: false is 1.0 behavior: surfaced once, never again");
pass("resurface switches presence-based recall on and off end to end");

const rootTools = [];
registerPiCanon({ on() {}, registerTool: (t) => rootTools.push(t), registerCommand() {} }, { root: "kb" });
await rootTools[0].execute("id", { action: "write", path: "notes/a", body: "A.", capsule: "A." }, undefined, undefined, ctx);
assert.ok(existsSync(join(projDir, "kb/articles/notes/a.md")));
const absRoot = join(work, "abs-canon");
const absTools = [];
registerPiCanon({ on() {}, registerTool: (t) => absTools.push(t), registerCommand() {} }, { root: absRoot });
await absTools[0].execute("id", { action: "write", path: "notes/b", body: "B.", capsule: "B." }, undefined, undefined, ctx);
assert.ok(existsSync(join(absRoot, "articles/notes/b.md")));
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
assert.ok(existsSync(join(lakeDir, ".canon/articles/fundamentals/market_cap.md")));
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

/* --- study-driven guards ---------------------------------------------------------- */

const pasted = store.write("src/pasted", {
  capsule: "Real capsule.",
  body: "---\ncapsule: duplicate line\nupdated: 2026-08-10\n---\n\nThe actual body.",
});
assert.equal(pasted.body, "The actual body.");
assert.equal(pasted.capsule, "Real capsule.");
const ruled = store.write("src/ruled", { body: "---\n\nNot front matter, an hrule.\n\n---\nMore." });
assert.match(ruled.body, /^---/);
pass("a body pasted with its own front matter is stripped; an hrule body is not");

store.write("src/lawful", { capsule: "c", body: "Amounts must remain integer cents in report.txt.\nOther prose." });
const priorLawful = store.read("src/lawful").body;
const laundered = advise(store.write("src/lawful", { body: "Amounts are formatted as dollars now." }), store, priorLawful);
assert.ok(laundered.some((a) => a.includes("dropped constraint language") && a.includes("must remain integer cents")));
const kept = advise(store.write("src/lawful", { body: "Amounts must remain integer cents in report.txt.\nNew prose." }), store, priorLawful);
assert.ok(!kept.some((a) => a.includes("dropped constraint language")));
pass("a write that deletes a must/never line is named; keeping the line stays silent");

const singleDir = join(work, "single");
mkdirSync(join(singleDir, "src"), { recursive: true });
const singleStore = new CanonStore(join(singleDir, ".canon"));
singleStore.write("src/only", { capsule: "one", body: "b" });
const singleSent = [];
const singlePi = {
  on: (name, fn) => (handlers[`single_${name}`] ??= []).push(fn),
  registerTool() {},
  registerCommand() {},
  sendMessage: (msg, opts) => singleSent.push({ msg, opts }),
};
registerPiCanon(singlePi, {});
for (const fn of handlers.single_session_start) fn({ reason: "startup" }, { cwd: singleDir, ui: { notify() {} } });
assert.match(singleSent[0].msg.content, /1 article governs this project/);
pass("the orientation line agrees with a single article");

assert.match(tools[0].description, /shared parent/);
pass("the tool description carries the filing rule");

assert.match(tools[0].description, /names and exact numbers/);
assert.match(tools[0].parameters.properties.body.description, /specifics beat summaries/);
pass("the journal verb teaches source capture and write teaches specifics");

assert.match(sent[0].msg.content, /journal the source/);
assert.match(coldSent[0].msg.content, /journal the source/);
assert.match(coldSent[0].msg.content, /Articles distill; the journal keeps the original/);
pass("both orientation branches carry the journal-the-source doctrine");

const traceFile = join(work, "trace.jsonl");
process.env.PI_CANON_TRACE = traceFile;
const surfTrace = new Surfacer([{ name: "", dir: projDir, store }]);
surfTrace.collect([join(projDir, "src/core/config.ts")]);
surfTrace.flush();
surfTrace.collect([join(projDir, "src/core/other.ts")]);
surfTrace.markSeen("src/core");
delete process.env.PI_CANON_TRACE;
const traceLines = readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
assert.ok(traceLines.some((t) => t.kind === "staged"));
assert.ok(traceLines.some((t) => t.kind === "flushed"));
pass("PI_CANON_TRACE audits the staged and flushed funnel");


/* An article rewritten mid-session reindexes. `updated` has day granularity, so any
   change check built from it would call a same-session rewrite unchanged and serve a
   stale ranking for the rest of the run. The residue is small by construction, so it is
   rebuilt every turn instead. */
const reindexStore = new CanonStore(join(work, "reindex/.canon"));
mkdirSync(join(work, "reindex"), { recursive: true });
reindexStore.write("policy/one", { capsule: "Nothing about vendor pagination here.", body: "b" });
let indexedWith = null;
const watchful = {
  name: "watchful",
  index: (candidates) => (indexedWith = candidates.map((c) => c.capsule).join("|")),
  score: () => new Map(),
};
const surfReindex = new Surfacer([{ name: "", dir: join(work, "reindex"), store: reindexStore }], watchful);
surfReindex.noteIntent("read", { file_path: "x" });
surfReindex.retrieve();
assert.match(indexedWith, /Nothing about vendor pagination/);
reindexStore.write("policy/one", { capsule: "Vendor pagination caps at 1000.", body: "b" });
surfReindex.noteIntent("read", { file_path: "x" });
surfReindex.retrieve();
assert.match(indexedWith, /caps at 1000/, "a same-day rewrite still reindexes");
pass("the retrieval index never goes stale against a same-session rewrite");



/* --- the user's own words --------------------------------------------------------
   The one query source both findings endorse without qualification: exogenous, so the
   circularity objection cannot reach it, and a statement of what is wanted rather than
   evidence of what was found. */

assert.deepEqual(
  userIntent([{ role: "user", content: "why is the ledger total off" }]),
  [{ role: "user", content: "why is the ledger total off" }],
);
assert.deepEqual(
  userIntent([{ role: "user", content: [{ type: "text", text: "typed parts" }, { type: "image" }] }]),
  [{ role: "user", content: "typed parts" }],
);
assert.deepEqual(userIntent([{ role: "assistant", content: "my own reasoning" }]), []);
assert.deepEqual(userIntent([{ role: "toolResult", content: "a dump of file contents" }]), []);
assert.deepEqual(userIntent("not an array"), []);
pass("user speech is read from the projection, typed parts included, and nothing else is");

/* Our own nudges arrive as messages. Ranking articles against the text of previous
   article nudges would score an article highly for having been surfaced already. */
assert.deepEqual(userIntent([{ role: "user", customType: "pi-canon", content: "policy/x: a capsule" }]), []);
assert.deepEqual(userIntent([{ role: "user", content: "[pi-canon] Governing article for what this turn touches." }]), []);
pass("pi-canon's own nudges never feed back into the query");

const many = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `question ${i} `.repeat(20) }));
const bounded = userIntent(many);
assert.ok(bounded.length < many.length, "the whole window is not the query");
assert.ok(bounded.at(-1).content.includes("question 39"), "the newest speech is kept");
assert.ok(!bounded.some((p) => p.content.includes("question 0")), "the oldest is dropped");
pass("user speech is bounded and newest-first, per the position control");

/* And the cut inside one over-long message goes the same way. A pasted spec whose actual
   ask sits at the end used to lose exactly the ask, because the function walked the window
   newest first and then kept the oldest part of the message it landed on. */
const longAsk = "PREAMBLE. ".repeat(400) + "So please fix the reconciliation rounding.";
const tail = userIntent([{ role: "user", content: longAsk }]);
assert.ok(tail[0].content.endsWith("So please fix the reconciliation rounding."), "the ask survives");
assert.ok(!tail[0].content.startsWith("PREAMBLE. PREAMBLE."), "the preamble is what gets dropped");
assert.ok(tail[0].content.length <= 1500, "and it is still bounded");
pass("an over-long message is cut at its head, not its tail");

/* End to end: a question with no tool call at all still retrieves, which is exactly the
   turn an unaddressed article is for. */
const surfSpoken = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever());
surfSpoken.observe([{ role: "user", content: "should reconciliation totals be rounding half up" }]);
surfSpoken.retrieve();
assert.match(surfSpoken.flush(), /policy\/rounding/);
pass("a question with no tool call still ranks the residue");

/* The tool call leads the question in the query, because it is newer. */
const surfBoth = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever());
surfBoth.observe([{ role: "user", content: "check the timezone handling" }]);
surfBoth.noteIntent("read", { file_path: "ledger/rounding_totals.py" });
assert.match(
  intentQuery([{ role: "user", content: "check the timezone handling" }, { toolName: "read", input: { file_path: "a.py" } }]),
  /^read a\.py\ncheck the timezone/,
);
pass("this turn's tool call leads the question that prompted it");

/* resurface governs presence, not observation: with it off the query still sees the
   user, and nothing expires. */
const surfOffObserve = new Surfacer([{ name: "", dir: projDir, store }], new LexicalRetriever(), false);
surfOffObserve.collect([join(projDir, "src/feed/sync.ts")]);
surfOffObserve.flush();
surfOffObserve.observe([{ role: "user", content: "reconciliation totals rounding question" }]);
assert.equal(surfOffObserve.stats.present, 1, "resurface off means nothing expires");
surfOffObserve.retrieve();
assert.match(surfOffObserve.flush(), /policy\/rounding/, "but the query still hears the user");
pass("resurface switches presence only; the projection is still read for the query");



/* --- the filing rule tracks the configuration -------------------------------------
   The last clause costs knowledge in either direction. With no retriever an article
   off the asset path is genuinely unreachable, so inviting one would be advice to lose
   information. With a retriever the advice inverts, because the only parent unrelated
   packages share is the root and a root article surfaces on every touch of anything. */
const filingTools = [];
registerPiCanon({ on() {}, registerTool: (t) => filingTools.push(t), registerCommand() {} }, {});
assert.match(filingTools[0].description, /filed off the asset path never surfaces/);
assert.doesNotMatch(filingTools[0].description, /governs many assets and owns none/);

registerPiCanon(
  { on() {}, registerTool: (t) => filingTools.push(t), registerCommand() {} },
  { retrieval: "lexical" },
);
assert.match(filingTools[1].description, /governs many assets and owns none/);
assert.match(filingTools[1].description, /reached by relevance to the work rather than by address/);
assert.doesNotMatch(filingTools[1].description, /never surfaces/);
pass("the filing rule tells the truth for the retrieval the run is actually using");

/* Building the description must not force the runtime into existence: it is created
   from the session ctx, and answering at registration would pin it to the wrong cwd. */
const cwdTools = [];
const cwdSent = [];
const cwdHandlers = {};
registerPiCanon(
  {
    on: (n, f) => (cwdHandlers[n] ??= []).push(f),
    registerTool: (t) => cwdTools.push(t),
    registerCommand() {},
    sendMessage: (m) => cwdSent.push(m),
  },
  { retrieval: "lexical" },
);
for (const fn of cwdHandlers.tool_call) fn({ toolName: "read", input: { file_path: "src/feed/sync.ts" } }, ctx);
for (const fn of cwdHandlers.turn_end) fn(undefined, ctx);
assert.ok(
  cwdSent.some((m) => m.content.includes("src/feed/sync")),
  "the runtime still resolves against the session cwd, not the process cwd",
);
pass("the tool description never forces the runtime into existence at registration");



/* --- the scope question ----------------------------------------------------------
   Filing a constraint at the asset you happened to be editing is the addressing
   version of the paraphrase failure: the rule survives in full, at an address nothing
   else resolves to. Observed on the first cell of the 06 smoke run, where the plant
   filed a house-wide actor convention at ops/billing. */
const scopeDir = join(work, "scope");
mkdirSync(join(scopeDir, "ops"), { recursive: true });
writeFileSync(join(scopeDir, "ops/billing.py"), "# emitter\n");
const scopeStore = new CanonStore(join(scopeDir, ".canon"));
const RULE_BODY = "Scheduled jobs must write the actor with a system: prefix.";

const asked = advise(
  scopeStore.write("ops/billing", { capsule: "c", body: RULE_BODY }),
  scopeStore, "", { dir: scopeDir, retrieval: "lexical" },
);
assert.ok(asked.some((a) => a.includes("governs an asset") && a.includes("its own address")));
pass("a rule filed at an asset address draws the scope question");

/* Silent with no retriever: an off-path article is unreachable then, so the advice
   would be advice to lose information. */
assert.equal(
  advise(scopeStore.read("ops/billing"), scopeStore, "", { dir: scopeDir, retrieval: "none" })
    .filter((a) => a.includes("its own address")).length,
  0,
);
assert.equal(advise(scopeStore.read("ops/billing"), scopeStore, "").length, 0);
pass("the scope question stays silent when nothing could reach an off-path article");

/* Once, on the write that turns an article into one carrying a rule. A store being
   maintained does not get asked the same question every turn. */
assert.equal(
  advise(scopeStore.read("ops/billing"), scopeStore, RULE_BODY, { dir: scopeDir, retrieval: "lexical" })
    .filter((a) => a.includes("its own address")).length,
  0,
  "a rewrite of an article that already carried a rule stays quiet",
);
/* And never for an article that is already off the asset path: it is where it belongs. */
const offPath = scopeStore.write("policy/audit-actor", { capsule: "c", body: RULE_BODY });
assert.equal(
  advise(offPath, scopeStore, "", { dir: scopeDir, retrieval: "lexical" })
    .filter((a) => a.includes("its own address")).length,
  0,
);
pass("the scope question is asked once, and never of an article already off the asset path");

/* --- the declared scope ----------------------------------------------------------
   The complement. An article off the asset path is where the doctrine wanted it, and
   is also exactly what an article whose asset was deleted under it looks like. The
   residue could not tell those apart while it was defined only by what it is not. */
assert.ok(
  advise(offPath, scopeStore, "", { dir: scopeDir, retrieval: "lexical" })
    .some((a) => a.includes("governs no asset on disk") && a.includes("scope rule")),
);
const declared = scopeStore.write("policy/audit-actor", { body: RULE_BODY, scope: RULE_SCOPE });
assert.equal(declared.scope, RULE_SCOPE);
assert.equal(scopeStore.read("policy/audit-actor").scope, RULE_SCOPE, "and survives a round trip");
assert.equal(
  advise(declared, scopeStore, "", { dir: scopeDir, retrieval: "lexical" })
    .filter((a) => a.includes("governs no asset on disk")).length,
  0,
  "an article that declared itself is not asked again",
);
pass("an off-path rule is asked to declare itself, and stops being asked once it has");

/* A declaration has to be revocable, or the first one is permanent. The tool's enum is
   the model's whole vocabulary, so "asset" exists to mean the default: the address is the
   claim. Exercised through the tool, because that is where the trap was: every value but
   the enum's own falls through to undefined, which means untouched. */
const scopeTools = [];
registerPiCanon({ on() {}, registerTool: (t) => scopeTools.push(t), registerCommand() {} }, { retrieval: "lexical" });
const scopeCtx = { cwd: scopeDir, ui: { notify() {} } };
const write = (params) =>
  scopeTools[0].execute("id", params, undefined, undefined, scopeCtx).then((r) => r.content[0].text);

await write({ action: "write", path: "policy/revocable", scope: "rule", body: RULE_BODY });
assert.equal(scopeStore.read("policy/revocable").scope, RULE_SCOPE);
await write({ action: "write", path: "policy/revocable", scope: "asset" });
assert.equal(scopeStore.read("policy/revocable").scope, "", "scope asset takes the declaration back");
assert.equal(scopeStore.read("policy/revocable").body.trim(), RULE_BODY, "and leaves the body alone");
assert.deepEqual(
  scopeTools[0].parameters.properties.scope.enum, ["rule", "asset"],
  "and the model has the vocabulary to say it",
);
pass("a declared rule can stop being one");

/* The scope question fires on the write that TURNS an article into one carrying a rule.
   A capsule-only write turns nothing: the body is untouched and has carried the same rule
   all along. It re-fired because the prior body was only read when a body was supplied, so
   the trigger tested itself against the empty string every time. */
const firstAsk = await write({ action: "write", path: "policy/quiet", body: RULE_BODY, capsule: "c" });
assert.match(firstAsk, /governs no asset on disk/, "the write that brings the rule is asked");
const capsuleOnly = await write({ action: "write", path: "policy/quiet", capsule: "a tighter line" });
assert.doesNotMatch(capsuleOnly, /governs no asset on disk/, "a capsule-only write is not asked again");
assert.equal(scopeStore.read("policy/quiet").body.trim(), RULE_BODY, "and the body survives it");
assert.equal(scopeStore.read("policy/quiet").capsule, "a tighter line", "which is the point of the write");
pass("a capsule-only write does not re-ask a question the body already answered");

/* Membership is unchanged: a declaration the agent forgot must never cost it the one
   mechanism that can reach it. The flag reports, it does not filter. */
scopeStore.write("policy/timezones", { capsule: "c", body: "Timestamps are UTC." });
const scoped = residue(scopeStore, scopeDir);
assert.deepEqual(
  scoped.filter((c) => c.declared).map((c) => c.path), ["policy/audit-actor"],
);
assert.ok(
  scoped.some((c) => c.path === "policy/timezones" && !c.declared),
  "an undeclared off-path article is still ranked, just not counted as deliberate",
);
pass("the residue reports which of its articles are rules on purpose");

/* And a declaration has to survive the filesystem. Membership used to be decided by
   governsAnAsset alone, so the moment anything appeared at a declared rule's address
   the rule dropped out of the only mechanism that can reach it, silently. */
writeFileSync(join(scopeDir, "policy"), "not a directory, just a name collision\n");
const collided = residue(scopeStore, scopeDir);
assert.ok(collided.some((c) => c.path === "policy/audit-actor" && c.declared),
  "a declared rule stays retrievable when something collides with its address");
pass("a declared rule survives an asset appearing at its address");

/* --- values must survive distillation --------------------------------------------
   capbase, 8 plant sessions: the journal held every declared value 48/48 and the
   article kept 13/48, and what survived was exactly the value about the article's own
   asset. cap1 then measured what that costs: an article stating a rule's shape without
   its values scores 0/4, the same as no article at all. The journal is the provenance,
   so the check is a literal diff and needs no model. */
const valDir = join(work, "values");
mkdirSync(join(valDir, "ops"), { recursive: true });
writeFileSync(join(valDir, "ops/billing.py"), "# emitter\n");
const valStore = new CanonStore(join(valDir, ".canon"));
const SOURCE =
  "Compliance said registered ids are scheduler-owned: billing-close, " +
  "inventory-reconcile and nightly-dispatch. The nightly close ran as ops-bot for " +
  "eleven weeks and 40,000 actions landed on that person.";

const thin = valStore.write("ops/billing", {
  capsule: "close_period uses system:billing-close.",
  body: "close_period emits period.close with actor system:billing-close.",
});
const missing = unretained(SOURCE, thin);
assert.ok(missing.includes("nightly-dispatch"), "the other registered ids are the loss");
assert.ok(missing.includes("inventory-reconcile"));
assert.ok(missing.includes("ops-bot"));
assert.ok(missing.some((v) => v.includes("40,000")), "counts are values too");
assert.ok(missing.some((v) => /eleven weeks/i.test(v)), "durations are values too");
assert.ok(!missing.includes("billing-close"), "what the article kept is not reported");
pass("a journal entry names the values its article dropped");

const fat = valStore.write("ops/billing", {
  capsule: "Registered jobs: billing-close, inventory-reconcile, nightly-dispatch.",
  body: SOURCE,
});
assert.deepEqual(unretained(SOURCE, fat), [], "an article carrying the values draws nothing");
pass("an article that kept its values is not nagged");

/* Bare substring containment would call 42 retained because the article says 142,
   which is the one mistake a guard about exact values cannot make. A value sitting at
   a symbol boundary inside a larger identifier is still retained. */
const numeric = store.write("src/numeric", {
  capsule: "Limits.",
  body: "The cap is 142 and the actor is system:billing-close.",
});
assert.deepEqual(unretained("Raised it to 42 today.", numeric), ["42"],
  "42 is not retained by an article that only says 142");
assert.deepEqual(unretained("The job is billing-close.", numeric), [],
  "billing-close is retained inside system:billing-close");

assert.deepEqual(unretained(SOURCE, undefined), [], "no article is not a retention failure");
assert.deepEqual(unretained("Renamed the helper and tidied imports.", thin), [],
  "prose with no values in it reports nothing");
pass("the value check stays silent with no article and with no values");


console.log(`\nall ${gates} gates green`);
