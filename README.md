# pi-canon

Canonical project memory for the [Pi coding agent](https://pi.dev). Every asset has at most one governing article, at an address computed from the asset's own path: `src/core/config.ts` is governed by `articles/src/core/config.md`. Beneath the articles sits an append-only journal, one file per event. When a tool call touches a governed asset, that article's one dense line arrives in the session unasked, so the agent does not have to know there was something to look up. Detecting the path in a tool call is best effort; resolving it to an article is not.

![The store drawn as a graph, articles tethered to the assets they govern](https://raw.githubusercontent.com/shaneconner/pi-canon/main/docs/assets/pi-canon-constellation.gif)

*An illustrative store: 33 articles, 20 journal entries, 40 files. Discs are articles, rings are journal entries hanging under the article each was distilled into, and a square tethered beneath a disc is the asset that article was named for. Six of the articles match no asset and hang untethered, because free knowledge is not a special case here. Selecting a node opens what it holds, what it points at, and what points at it.*

## Install

```
pi install npm:pi-canon
```

Or clone this repo into `~/.pi/agent/extensions/`. Node 22.18 or later, Pi 0.83 or later on the 0.x line. Nothing to configure: the store is created on first write at `<project>/.canon`. The package imports `node:fs` and `node:path` and nothing else, makes no network calls, runs no git, and loads under plain node with no build step.

## The first article

Every session opens with one orientation line saying how many articles govern the project, or inviting the first one when the store is empty. From there it takes one tool call:

```json
{ "action": "write",
  "path": "src/core/config",
  "capsule": "Loads layered config; env beats file; secrets never land here.",
  "body": "Resolution order is defaults, then config.toml, then environment. ..." }
```

```
Wrote src/core/config.
```

The store, after that write and a little later work:

```
.canon/
  articles/
    src/core/config.md        governs the src/core/config address
    lake/prices.md            articles are not limited to code
  journal/
    2026-08-11-vendor-cap.md  one file per entry, never rewritten by the tool
```

The article itself:

```markdown
---
capsule: Loads layered config; env beats file; secrets never land here.
updated: 2026-08-11
---
Resolution order is defaults, then config.toml, then environment. ...
```

That is the whole storage format. `capsule` is the one dense line surfacing sends, collapsed to a single line on write whatever the agent sent. `updated` is the date of the last write, which is not the date the content last changed, and nothing compares it against the asset. Those two keys are the only ones pi-canon owns. Every other key in the block, Obsidian properties included, is carried through writes verbatim, and owned values are quoted only where plain YAML would misread them, so the tree stays editable by hand.

The result is plain Markdown and a valid Obsidian vault. Commit it with your repo: git is the history, diff, blame, and time machine, and pi-canon never runs git itself. Journal entries are ordinary files too. The tool only appends them; read them with normal file tools.

## The failure this is shaped for

An agent formats a column of raw integer cents for a human reader, `2,255.65` where the file carried `225565`. The tests pass. In another repository, one nobody opened during that session, a finance parser reads that file and treats any line with a comma in it as corrupt, so it drops the line and reads on. No exception, no failing build, and a number missing from a downstream total until someone reconciles by hand.

Retrieval cannot prevent this, because a search only runs when something thinks to run it. Formatting a number for readability is not a moment that raises a question. There was nothing to suspect, so there was nothing to search for.

> The expensive failures in project work are not the ones where an agent looked something up and got a bad answer. They are the ones where nobody knew there was a question to ask.

That scenario is not a war story. It is one of the five chains in the benchmark below, written because it is the shape of failure this package exists to prevent. No arm of that benchmark is search-driven, so this is the motivation for the design rather than a measured comparison against retrieval.

## Where this comes from

The shape underneath pi-canon is the LLM wiki: a folder of Markdown articles an agent writes and rewrites, linked to each other, with no schema declared in advance. Andrej Karpathy introduced and popularized the pattern in [llm-wiki.md](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), positioned against re-retrieving raw chunks at query time. Most of what it gets right is kept here unchanged. Plain files, so anything can read them and a person can fix one in an editor. No database and no index to rebuild. Committed with the repository, so git supplies history, diff, and blame. And no schema up front, so knowledge takes the shape the project actually has.

That freedom is also where these stores fail, in two specific directions rather than vaguely.

**Scatter.** Nothing marks any article as the article about a topic, so an agent that cannot find the existing one writes another. Now there is a note on the vendor feed, a second on feed pagination, and a third on the sync job, all describing the same constraint from three angles, none of them wrong. Retrieval finds all three, the agent reads whichever ranks highest, and when they disagree nothing decides between them.

**Log drift.** A store an agent writes to during work fills with events, because work is made of events: what was tried, what failed, what got fixed. Current truth ends up under a running log of how it came to be true, and the page that should say what the rule is says what happened on the fourteenth instead.

Neither is a storage failure. In both, the knowledge is present, written down, sitting right there in the folder. Scatter is an addressing failure: precedence is undefined across copies because nothing names one of them canonical. Log drift is a mutability failure: event history and current reference knowledge share one page, and a later rewrite can edit either one out from under the other.

pi-canon is an increment on the pattern rather than a replacement for it, and it adds three things.

**A journal**, append-only, one file per event. Agents log whether you want them to or not, and that impulse has to land somewhere that is not the reference page. The instruction on the way in is to record the source as it arrived, names and exact numbers included, because articles distill and only the journal keeps the original.

**A spine**, the addressing convention. An article's address is computed from the asset instead of searched for, and nothing has to be configured for that mapping to hold, which makes the spine a convention rather than a mode. It is also why no part of the package searches: there is nothing to find when the path already decided the address.

**Surfacing**, push rather than pull. When a tool call is detected touching a governed asset, that article's capsule is staged for the session, at most once per article and under a session allowance, so nobody has to think to ask. Detection of a path inside a tool call is best effort. Resolution, once a path is in hand, is not.

The evaluation below does not test that lineage argument: no evaluated arm is a search-driven LLM wiki, so nothing here shows pi-canon beats a disciplined one.

## Addressing

The address is the asset path with its file extension dropped, and the drop happens once, at the boundary. A name has to precede the dot, so `.env` stays `.env`. Only a dot after the last slash counts, so `docs/v1.2/notes.md` normalizes to `docs/v1.2/notes`. And `src/core/config.test.ts` lands at `src/core/config.test`, beside `config` rather than on top of it. Dot segments clamp at the root, and containment is checked a second time inside write, so no address escapes `articles/`.

Resolution tries the exact address, then walks up one path segment at a time to the nearest existing article, and returns nothing if it reaches the top without a hit. There is no ranking, no scoring, and no similarity: given a path, the governing article is a function of what exists in the tree. So not every file needs an article: one article at `src/feed` answers for everything beneath it that has no closer article. Creating an article is the uncommon act; the common one is updating the article that already governs.

A rename is a file move you make yourself. pi-canon does not watch the filesystem and has no rename action. Move the article to the address the new path derives. Lint checks the wikilinks inside whatever article is written next, so a link left pointing at the old address is named the next time that article is written, not at the moment of the move.

An article matching no asset is ordinary free knowledge, and no flag distinguishes it. The spine guarantees an address for the assets a project already has; it does not confine the store to them. The tradeoff is worth stating in the same breath: surfacing is asset-scoped, so an off-spine article is reached by a link or an explicit read rather than pushed on a touch.

## The tool

One tool, `pi_canon`, four actions.

| action | parameters | does |
|---|---|---|
| `read` | `path` | Returns the governing article: title, `capsule`, `updated`, body, and a one-line journal index. A miss returns a sentence naming the address and inviting a write after the task. When an ancestor answers, the title reads `<ancestor> governs <address>`, so the altitude is visible. |
| `write` | `path`, `capsule`, `body` | Creates or updates the article, then returns `Wrote <address>.` and any advisory lint. Never refuses. An empty string means untouched, not erase. |
| `journal` | `body`, `subject`, `slug` | Appends a dated entry as its own file, `<date>-<slug>[-n].md`. pi_canon can never rewrite one. An empty body gets a sentence back asking what happened. |
| `map` | `path` (optional prefix) | One line per article as `address: capsule`, or a sentence when the store or the filter is empty. Output is unbounded. |

`subject` is an array of addresses. A subject passed as a bare string is ignored and the entry lands with none at all.

Entries logged with `subject` addresses come back as a one-line index of filenames, newest three, when those articles are read: history on offer, never loaded by default. The index carries filenames only and never entry content, and matching is exact, so an entry filed at `src/core/config` does not appear when `src/core` is read. The journal always lives in the project store.

Lint on a write is advisory strings appended to the response, never a refusal, because a blocked write teaches an agent to stop writing while a warning teaches it what to do next. It warns past 8,000 characters of body and suggests going hierarchical past 20,000. It names a missing capsule, one over 1,000 characters, or one written as a change log. An address carrying a `log`, `journal`, `session`, `standup` or `meeting` segment, or an ISO date, draws a redirect to the journal. Dead wikilinks are named one line each.

One lint line is different in kind. When a write supplies a body and an article was already there, the new body is compared against the prior one, and a line that carried constraint language and disappeared is quoted back at the write that removed it. The vocabulary is fixed: `must`, `never`, `always`, `require` in its `requires` and `required` forms, `do not`, and `don't`. At most two lines are named per write, each cut to its first 160 characters, with the note that if the constraint still holds it should stay, and if it genuinely changed, the change belongs in the journal. The quote is a prefix rather than a summary. It is an advisory: the write already landed, and nothing can make an agent put the line back.

## Surfacing

A tool call stages the governing article for whatever it touched and sends nothing. Each turn end flushes everything staged as a single message, because pi's steering queue drains one message per provider round trip and a message per tool call would buy every nudge its own model call. An article surfaces at most once per session, and nothing about that persists: a new session re-surfaces everything.

Three numbers, all constants in the code. A capsule is written to fit 1,000 characters, a flushed message aims at 2,000, and capsule text has a 4,000 character session allowance. The message target is not a cap, because the first line always goes out whole, and anything that does not fit stays staged, so the message ends with a count of what is still waiting and those lines go out on a later turn. Only the session allowance is a refusal, and it is tested per capsule against what is left, so a short capsule can still land after a longer one was turned away. Past the allowance an article does not disappear: it surfaces as a pointer naming the address and telling the agent to read it. Pointers, message headers, and reminders sit outside the counter.

Reading an article through `pi_canon` withdraws the line staged for it before the message goes out, so pull preempts push. Reading the asset file itself does not, because reading a file is not reading what is known about it, and the capsule may hold exactly the constraint the file does not contain. After the agent settles, articles touched but not updated draw one reminder naming them, once per batch, re-armed by the next touch.

Finding a path in a tool call is best effort. Only the input of a tool call is scanned. Results are never scanned, and neither is the model's prose. Inputs are scanned for whole short strings and path-shaped tokens that exist on disk or whose parent directory does, so a file about to be created still surfaces its governing ancestor, and a path with a space inside a longer string is missed. What that feeds, resolution from a path to a governing article, is deterministic. The two claims stay separate on purpose.

`/pi-canon` prints one status line: store root, the mount count when there is one, article count, journal entries, articles seen this session, and capsule characters spent against 4,000. It goes to the UI and sends the model nothing, so asking costs no context. `PI_CANON_TRACE=<file>` appends one JSON line per surfacing decision, and is inert when the variable is unset.

## Options

Installed as a package, pi loads the default export and takes the defaults. To pass options, write your own extension file and let it call the named export:

```js
// ~/.pi/agent/extensions/my-canon.js
import { registerPiCanon } from "pi-canon"

export default function (pi) {
  registerPiCanon(pi, { mounts: ["/data/lake"] })
}
```

Three keys, and any other throws at registration by name, because everything else is a constant on purpose.

- **`root`** places the store. Absolute is used as given, relative joins the project cwd. Default `<project>/.canon`.
- **`surface: false`** silences the orientation line, the per-turn flush, and the settle reminder. The `pi_canon` tool and `/pi-canon` stay registered and working.
- **`mounts`** lists directories outside the project that carry their own `.canon` beside their assets. `mounts: ["/data/lake"]` serves articles as `lake:prices`, addressable by that name or by any absolute path inside the mount. Two workspaces that mount the same directory read and write the same store, because the store lives with the assets it governs and sharing needs no protocol. A mount has no journal of its own: events are project history and every entry lands in the project store.

## What the code holds, and what it asks for

An immutable journal, an addressing spine, and recall that arrives unasked could sound like a design that removed its dependency on model behavior. It did not. It moved that dependency to one side of a line and constrained the other side, and the line is short enough to state in full.

Held by the runtime:

- A journal entry is created with the exclusive-create flag, so pi_canon never rewrites or deletes one, and a name collision increments a suffix rather than losing an entry. The files stay ordinary Markdown, so any other tool can still rewrite or delete one: append-only is a property of the tool, not of the filesystem.
- Once a path is in hand it resolves to exactly one article, walking to the nearest ancestor that has one, or to nothing at all.
- An article surfaces at most once per session, with capsule text bounded at 4,000 characters for the session.
- Reading an article through the tool withdraws its staged capsule before the message goes out.

Asked of the agent, and checked by nothing:

- Read the governing article before working on an asset, and update it after real changes. No write is gated on a prior read, and the settle reminder is a message rather than a gate.
- Record the source as it arrived, names and exact numbers included, because articles distill and only the journal keeps the original.
- File the entry under the right subject, and file a constraint at the asset it governs rather than the asset you happened to edit. Knowledge filed off the asset path never surfaces.
- Open the article when a capsule or a pointer says there is one. A line in the context is not a read.
- Decide whether a dropped constraint still holds. Then follow the rule, against a live prompt asking for something else.

Nothing in the package can compel an agent to keep a line it has decided to cut.

What the package does not do, stated so nothing above reads as more than it is:

- No search. There is no query action, no index, and no grep. `map` is the only listing, and retrieval is by exact address or by the ancestor walk.
- No embeddings, no similarity, no ranking.
- No filesystem watching, and no staleness detection: `updated` is the date of the last write and is never compared against the asset.
- No delete and no rename. Removing or moving an article is a file operation you perform.
- Articles are last write wins, with no lock, no merge, and no warning that someone else changed the file. Only journal entries get the collision retry.
- No duplicate detection. One canonical address per asset is structural, not checked.
- Nothing writes, summarizes, or compacts on its own, and nothing filters what goes in: no secrets scanning and no redaction. Every line pi-canon wrote came from an explicit tool call.
- Nothing about surfacing persists between sessions. A new session re-surfaces everything and gets a fresh allowance.

## Evidence

The population comes before the numbers: five author-built chains, development-exposed and reused by the confirmatory run, four eligible trap designs, each repeated five times, one worker model, under a protocol frozen with a hash manifest before that run.

The unit is a cell: a fresh worktree holding a small fictional repository, run through four sessions that share it. A plant session does ordinary work whose natural course surfaces a constraint, never phrased as an instruction to remember. A distractor session comes in between. A probe session then gets a task whose obvious solution violates that constraint in a way that compiles, runs, and fails a grader the agent never sees. A recall session answers an auditor afterwards, one judge call per fact.

Four arms run every cell. `canon` is stock Pi plus this package at 0.1.0, the build the study measured. `canondoc` is canon plus a static doctrine file beside it. `agents.md` is a self-maintained convention file preloaded with 99 lines of mature-project noise. `bare` loads no memory extension, and it is a stronger floor than the name suggests: prior-session transcripts land in its worktree before the recall session and its agent is on record reading them, so it is a no-extension floor at probe time and a transcript baseline at recall.

| arm | trap cells (of 20) | all checks (of 110) | plant-only recall (of 45) | median recall tokens | total chain cost |
|---|---|---|---|---|---|
| canon | 19 | 109 | 41 | 20,775 | $0.5454 |
| agents.md | 18 | 107 | 42 | 64,568 | $0.6227 |
| canondoc | 16 | 105 | 40 | 13,991 | $0.4639 |
| bare | 8 | 85 | 40 | 61,006 | $0.5345 |

![Every eligible probe cell as a square, four trap designs by five repetitions, per arm](https://raw.githubusercontent.com/shaneconner/pi-canon/main/docs/assets/fig-trap.png)

*One square per eligible probe cell: four trap designs across, five repetitions within each, one row per arm. Every consumer-contract cell is a loss for bare. canon loses one cell in the whole grid, chain 04 repetition 1, which is the design that costs every arm at least one.*

Read the unconditioned column beside the headline one. The trap metric is conditioned on the floor arm's cold failures, which is the strongest objection to it, so the unconditioned count scores all 110 intended checks whether or not a cold worker had already failed them, and the ordering survives. That count is check-level rather than an unconditioned version of the cell metric, and it was computed after the run rather than frozen with the protocol. Read the 18 before the 8: a self-maintained convention file, deliberately burdened with 99 lines of noise, finished one repeated cell behind the package, and quoting the gap against the floor without that number would be managing the reader rather than informing them.

Recall is a wash and has to be reported as one. Plant-only recall, 45 judged facts per arm: agents.md 42, canon 41, canondoc 40, bare 40. One fact flagged as paraphrase-sensitive before the freeze carries 9 of the 17 misses across arms, and striking it leaves canon level with bare. An ordering that moves when one judged item is removed is not an ordering.

Where the arms separate is the price of the answer. Median recall session tokens ran canondoc 13,991, canon 20,775, bare 61,006, agents.md 64,568, so canon answers at 0.34x bare's median. That does not make it the cheapest arm end to end. Total chain cost ran canondoc $0.4639, bare $0.5345, canon $0.5454, agents.md $0.6227, so canon is not the cheapest arm overall, and canondoc is lowest on both metered measures while passing three fewer trap cells. Every dollar figure is metered worker-session cost at that day's rates; the judge calls sit outside all of them, in equal number per arm. A package-level study offers no account of why.

The result that changed the roadmap is not in that run at all. A forensic pass over a development run classified 14 recall misses by where each first went wrong.

![Fourteen misses classified by first failure point, thirteen of them at the write desk](https://raw.githubusercontent.com/shaneconner/pi-canon/main/docs/assets/fig-writedesk.png)

*The 14 recall misses from a development run, each placed at the point it first went wrong: 8 never captured into any tier, 5 captured and then overwritten by a later rewrite, 1 judge error, and 0 lost at retrieval or surfacing.*

That is development evidence over two arms of one run and it carries no confirmatory weight, but 13 of 14 is not a close call and it points somewhere specific. None of the misses was a fact sitting in the store that recall failed to reach, which is the failure a retrieval-shaped design would predict. A store that surfaces perfectly cannot surface what was never written down, so on this evidence the open problem is write-side fidelity rather than recall coverage: the hard moment is when an agent has just learned something, is mid-task, and has a live prompt in front of it asking for something else. The constraint guard is a first answer to the rewrite half of that, and an incomplete one.

### What the run does not establish

- The five chains are development-exposed. The product changed in response to failures on these same chains, and the confirmatory run reuses them, so the freeze confirms disciplined execution rather than generalization to unseen tasks.
- The result is package-level. It attributes nothing to the journal, the spine, or surfacing separately.
- No evaluated arm is a search-driven LLM wiki, so nothing here is a comparison against one.
- The `agents.md` arm is one construct, a self-maintained file under author-designed preload noise, with no clean-file or human-maintained counterpart run beside it.
- Eligibility is model-relative. A check counts as a trap only where a cold run of the worker failed it, so every number built on it moves when the worker does.
- One author wrote the package, the chains, the traps, and the graders.
- Five repetitions of one trap design are five looks at one design, so no uncertainty interval is attached to any pooled count.

## More

- The paper, with the per-cell artifact trail: [doi:10.5281/zenodo.21890647](https://doi.org/10.5281/zenodo.21890647).
- The benchmark, drivers, frozen protocol, and the verifier that recomputes the paper's quantitative claims from the artifacts: [canon-bench](https://github.com/shaneconner/canon-bench).
- Interactive versions of every figure and the full measurement story: [shaneconner.com/projects/pi-canon](https://shaneconner.com/projects/pi-canon/).
- The narrative version: [My agents' wiki was written faster than it was read](https://medium.com/@shane.conner/my-agents-wiki-was-written-faster-than-it-was-read-and-what-was-read-sold-me-back-debt-i-had-a8085319c68b).
- [pi-fold](https://github.com/shaneconner/pi-fold), a separate optional package serving the working tier. pi-canon ships the two persistent tiers of the same four-tier stack: the journal is the episodic tier, the canon the semantic tier. The two compose, neither requires the other, and neither knows what the other has spent.

MIT. In a clone of this repo, `node tests/verify.mjs` runs the gate suite: it prints 67 named invariants and ends with `all 67 gates green`.
