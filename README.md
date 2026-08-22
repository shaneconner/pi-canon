# pi-canon

Canonical project memory for the [Pi coding agent](https://pi.dev). Every asset has at most one governing article, at an address computed from the asset's own path: `src/core/config.ts` is governed by `articles/src/core/config.md`. Beneath the articles sits an append-only journal, one file per event. When a tool call touches a governed asset, that article's one dense line arrives in the session unasked, so the agent does not have to know there was something to look up. Detecting the path in a tool call is best effort; resolving it to an article is not.

**One setup measured, others welcome.** pi-canon was developed and tested under one configuration: Codex, with GPT 5.6 as the worker model, on an OpenAI subscription. Every number in this README was measured there. Other models, other providers, and API-metered access are untested. If you run it under a different setup, feedback is welcome and so are pull requests.

![The store drawn as a graph, articles tethered to the assets they govern](https://raw.githubusercontent.com/shaneconner/pi-canon/main/docs/assets/pi-canon-constellation.gif)

*An illustrative store: 33 articles, 20 journal entries, 40 files. Discs are articles, rings are journal entries hanging under the article each was distilled into, and a square tethered beneath a disc is the asset that article was named for. Six of the articles match no asset and hang untethered, because free knowledge is not a special case here. Selecting a node opens what it holds, what it points at, and what points at it.*

## Install

### Pi

```
pi install npm:pi-canon
```

Or clone this repo into `~/.pi/agent/extensions/`. Node 22.18 or later, Pi 0.83 or later on the 0.x line. Nothing to configure: the store is created on first write at `<project>/.canon`. The package imports `node:fs` and `node:path` and nothing else, makes no network calls, runs no git, and loads under plain node with no build step.

### Codex

The repository is a Codex marketplace. Add it once, then install the plugin at user scope:

```sh
codex plugin marketplace add shaneconner/pi-canon
codex plugin add pi-canon@pi-canon
```

For a local checkout under development, replace `shaneconner/pi-canon` with its absolute path. Start a new Codex thread after installing or updating it.

### Claude Code

The same repository is also a Claude Code marketplace:

```sh
claude plugin marketplace add shaneconner/pi-canon --scope user
claude plugin install pi-canon@pi-canon --scope user
```

Again, an absolute checkout path works for local development. Start a new Claude Code session after installing or updating it.

Both plugins launch the same dependency-free MCP server and expose the same `pi_canon` actions as Pi. Codex surfaces after each tool result. Claude Code deduplicates one capsule packet across each parallel tool batch, immediately before the next model request, which avoids repeated message framing without delaying the agent's next decision. Both give one write-after reminder before the agent stops. An article surfaces at most once per compaction cycle: a compact starts a new cycle, while resuming the same uncompacted session does not. One session may contain several compaction cycles. Compaction discards prior touch state and replays nothing. After it, only a fresh tool-input path can surface that asset's exact or nearest-ancestor article; children and unrelated articles do not ride along. The hooks are inert in projects without `.canon/articles`, and they never create a store merely because a session opened. Review and approve the plugin hooks when the client asks. Journal entries written through the MCP server carry explicit `harness` provenance and a session identifier when the client exposes one.

## Defaults

What you have after installing, with nothing configured:

- **Addressing and surfacing on touch are on.** Touch a governed asset with a tool call and its article's capsule arrives unasked. This is the pairing the measurements kept: addressing is what survives store growth, and surfacing is what makes addressing discoverable. In the sizing study, every session that asked for the decisive address scored and 0 of 30 that did not ask scored, so recall that waits to be asked stops working exactly when the store outgrows what a session already knows.
- **The journal is append-only and quiet.** It is never read whole and never surfaced unsolicited; search is the only channel that reaches it. Treating history as memory was priced at a median 340,119 tokens per session against 21,309 for a distilled document, for no more correctness.
- **Recommendation is off.** `retrieval: "none"` is the default because the channel pays only where the store holds knowledge the address spine cannot reach, declared rules governing no asset, and the package cannot know which kind of store it faces. It also needs a retriever this package deliberately does not choose for you. Turn it on with `retrieval: "lexical"`, and the standout gate arrives at its measured default of 1.4 with the drained-store guard.
- **Nothing greets the session.** The orientation line and the session-end check-back were removed by their own measurements: presenting the memory surface alone, with nothing behind it, took first-pass correctness from 25 of 32 to 8 of 32, and the check-back's reminder was delivered and never acted on.

The whole option surface is six keys: `root`, `surface`, `resurface`, `retrieval`, `standout`, `mounts`. Each is documented under [Options](#options) with the measurement that set its default. Everything else is a constant on purpose.

## The first article

A session is not greeted: through 0.2.0 every session opened with an orientation line. A 2x2 experiment with an inert implementation found significant negative main effects for both that line and the tool schema, but their 19/32 versus 21/32 comparison did not resolve which component cost more. Study 3 detected no benefit loss when the line was removed, so 0.2.1 deleted it. The tool description carries the doctrine instead. The first article takes one tool call:

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

That is the whole storage format. `capsule` is the one dense line surfacing sends, collapsed to a single line on write whatever the agent sent. `updated` is the date of the last write that changed something: a write identical to the stored article is a no-op that touches nothing, so the stamp is not refreshed by restatements, and nothing compares it against the asset. Those two keys are the only ones pi-canon owns. Every other key in the block, Obsidian properties included, is carried through writes verbatim, and owned values are quoted only where plain YAML would misread them, so the tree stays editable by hand.

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

**A spine**, the addressing convention. An article's address is computed from the asset instead of searched for, and nothing has to be configured for that mapping to hold, which makes the spine a convention rather than a mode. It is also why nothing in the RECALL path searches: when a touch already decided the address, there is nothing to find. The `search` action exists for the opposite direction, the agent that wants to ask, and it never runs unasked.

**Surfacing**, push rather than pull. When a tool call is detected touching a governed asset, that article's capsule is staged for the session, at most once per article while it stays in context (see Surfacing), so nobody has to think to ask. Detection of a path inside a tool call is best effort. Resolution, once a path is in hand, is not.

The evaluation below does not test that lineage argument: no evaluated arm is a search-driven LLM wiki, so nothing here shows pi-canon beats a disciplined one.

## Addressing

The address is the asset path with its file extension dropped, and the drop happens once, at the boundary. A name has to precede the dot, so `.env` stays `.env`. Only a dot after the last slash counts, so `docs/v1.2/notes.md` normalizes to `docs/v1.2/notes`. And `src/core/config.test.ts` lands at `src/core/config.test`, beside `config` rather than on top of it. Dot segments clamp at the root, and containment is checked a second time inside write, so no address escapes `articles/`.

Resolution tries the exact address, then walks up one path segment at a time to the nearest existing article, and returns nothing if it reaches the top without a hit. There is no ranking, no scoring, and no similarity: given a path, the governing article is a function of what exists in the tree. So not every file needs an article: one article at `src/feed` answers for everything beneath it that has no closer article. Creating an article is the uncommon act; the common one is updating the article that already governs.

A rename is a file move you make yourself. pi-canon does not watch the filesystem and has no rename action. Move the article to the address the new path derives. Lint checks the wikilinks inside whatever article is written next, so a link left pointing at the old address is named the next time that article is written, not at the moment of the move.

An article matching no asset is ordinary free knowledge. The spine guarantees an address for the assets a project already has; it does not confine the store to them. The tradeoff is worth stating in the same breath: surfacing is asset-scoped, so an off-spine article is reached by a link or an explicit read rather than pushed on a touch, or by relevance when a retriever is configured.

Such an article may say so, with `scope: rule` on the write. Forgetting the declaration never excludes an off-spine article from retrieval. Declaring it separates a rule filed on purpose from an article whose asset disappeared, and keeps that rule in the retrieval corpus if an asset later appears at the same address. `scope: asset` takes the declaration back.

## The tool

One tool, `pi_canon`, five actions: `read`, `write`, `journal`, `map`, and `search`.

| action | parameters | does |
|---|---|---|
| `read` | `path` | Returns the governing article: title, `capsule`, `updated`, body, and a one-line journal index. A miss returns a sentence naming the address and inviting a write after the task. When an ancestor answers, the title reads `<ancestor> governs <address>`, so the altitude is visible. |
| `write` | `path`, `capsule`, `body`, `scope` | Creates or updates the article, then returns `Wrote <address>.` and any advisory lint. Never refuses. An empty string means untouched, not erase. A write identical to the stored article is reported as already current and touches nothing, so `updated` keeps meaning the date the content last changed. |
| `journal` | `body`, `subject`, `slug` | Appends a dated entry as its own file, `<date>-<slug>[-n].md`. pi_canon can never rewrite one. An empty body gets a sentence back asking what happened. |
| `map` | `path` (optional prefix) | One line per article as `address: capsule`, or a sentence when the store or the filter is empty. Output is unbounded. |
| `search` | `query`, `journal` | Ranks articles against the words, ten results, each carrying what scopes it: an article its address and capsule. The journal is opt-in via `journal: true`, because events are history rather than current truth, and measured on real stores journal entries about an event crowd out the article carrying it; a default search never reads an entry body and says the journal exists. Opted in, journal entries are first class results scoped by instant and subjects, articles keep half the window, and a short side cedes its slots. Says how many matches the cap dropped. The one action that reaches the journal's content. |

`subject` is an array of addresses. A subject passed as a bare string is ignored and the entry lands with none at all.

Entries logged with `subject` addresses come back as a one-line index of filenames, newest three, when those articles are read: history on offer, never loaded by default. The index carries filenames only and never entry content, and matching is exact, so an entry filed at `src/core/config` does not appear when `src/core` is read. The journal always lives in the project store.

Lint on a write is advisory strings appended to the response, never a refusal, because a blocked write teaches an agent to stop writing while a warning teaches it what to do next. The one exception is a rule the store itself declared `required` in its schema, documented in [The article schema](#the-article-schema) below. It warns past 8,000 characters of body and suggests going hierarchical past 20,000. It names a missing capsule, one over 1,000 characters, or one written as a change log. An address carrying a `log`, `journal`, `session`, `standup` or `meeting` segment, or an ISO date, draws a redirect to the journal. Dead wikilinks are named one line each. An article whose asset went missing is named on read and on write: a nested address whose parent directory exists on disk while nothing matches the asset draws the orphan question, with the ways out spelled (move the article, fold it into the parent, or declare `scope: rule`). Root-level addresses, declared rules, and stores whose addresses never mapped to files stay silent.

A rewrite that grows the body says so in its own result: `Body grew 812 -> 1304 bytes.`, followed by the reminder that an article carries current state and narrated history (old values, transitions) belongs in the journal. Any growth fires; creation is not growth, and a capsule-only write never grows the stored body. This line is measured, and the measurement is a direction rather than a size. Across three two-arm captures over byte-identical eight-session lineages, the arm whose tool spoke it ended with fewer superseded values standing every time: 51 against 88 of 96 on one model, 45 against 87 on a second, and 71 against 85 when the first model was run again with the arm order reversed in half the lineages. Take the direction and not the magnitude. That third capture kept the direction and lost most of the gap, and re-running a matched untreated cell two days later moved its median store 39 percent, so the instrument does not measure its own magnitudes reliably. Store size never carried either: it fell a fifth, then barely moved, then fell two fifths, and across the paired lineages the direction of that change is not distinguishable from chance in the first two captures. Two readers out of 96 were harmed by a stale value, one from each arm, so the line is not known to protect readers. The same doctrine in a system prompt cleared one superseded value in thirty-two, though that arm ran in a separate one-session study and the two were never placed side by side.

One lint line is different in kind. When a write supplies a body and an article was already there, the new body is compared against the prior one, and a line that carried constraint language and disappeared is quoted back at the write that removed it. The vocabulary is fixed: `must`, `never`, `always`, `require` in its `requires` and `required` forms, `do not`, and `don't`. At most two lines are named per write, each cut to its first 160 characters, with the note that if the constraint still holds it should stay, and if it genuinely changed, the change belongs in the journal. The quote is a prefix rather than a summary. It is an advisory: the write already landed, and nothing can make an agent put the line back.

## The article schema

Every store carries its contract as a file: `schema.json` at the store root, written with the shipped defaults made explicit the first time the store persists anything. It is data rather than configuration, so it travels with the store, differs per project, and any other tool reading the store can enforce the same contract from the same file. The shipped defaults require nothing and mirror the advisory caps, so an untouched file changes no behavior; it only makes the contract visible and editable.

Three fields can carry rules: `capsule` (the front matter line surfacing injects), `title` (the body's leading `#` heading; there is deliberately no separate title input, so the rule checks the one place a title can live), and `body`. Four rule keys: `required`, `min_chars`, `max_chars`, `hint`.

Enforcement is asymmetric on purpose, and the asymmetry is measured: across five write-quality model captures in this project's lab, rules held at the tool boundary erred at zero while rules left to model judgment erred at about one percent. So the class of miss that matters is enforced rather than advised:

- A rule marked `required` rejects the write that violates it, hint included, and nothing touches disk. A write is judged on what it changes, plus everything when the article is first created, so a capsule-only update is never held hostage to a legacy body.
- Every other violation warns: the write lands and the message names what to fix.
- A read never rejects, but it reports standing issues, because the agent holding a noncompliant article is the one positioned to heal it.
- A malformed `schema.json` fails open and loud: rules stop being enforced and every write says so, because a contract the owner believes is enforced while a typo disabled it is the worst state.
- A bound the schema declares owns its message: the built-in advisory line for the same aspect stays quiet instead of saying it twice.

A store that requires every article to open with a heading:

```json
{
  "schema_version": 1,
  "article": {
    "capsule": { "required": true, "max_chars": 1000, "hint": "One dense line of current truth." },
    "title": { "required": true, "hint": "Start the body with a # heading naming the asset." }
  }
}
```

Delete a rule to drop it; delete the file to disable schema checks entirely. An edited file is never overwritten.

Relations rules live in the same file under `relations`, because the reference graph is part of the contract too; each tool enforces the rules it can see, so one file governs every tool that reads the store. This package sees an article's own citations at the write boundary and enforces `refs`: `required` rejects a write whose body cites nothing, judged like the field rules (the write that changed the reference set, or a creation), and `min_count` warns under a floor, with code-fenced examples and case-folded duplicates never counted. The two graph-wide rules parse here and are enforced by graph-reading tools such as [canon-atlas](https://github.com/shaneconner/canon-atlas): `orphan.warn` warns when no other article references this one, and `children.listed` warns when an article does not reference each direct child under its address.

```json
{
  "schema_version": 1,
  "relations": {
    "refs": { "required": true, "hint": "Name what this concerns." },
    "orphan": { "warn": true },
    "children": { "listed": true }
  }
}
```

## Surfacing

A tool call stages the governing article for whatever it touched and sends nothing. Each turn end flushes everything staged as a single message, because pi's steering queue drains one message per provider round trip and a message per tool call would buy every nudge its own model call. An article with a presence mark surfaces at most once while that mark remains in the context the provider receives; one folded or compacted away returns to surfacing and rides again on its asset's next touch (the `resurface` option below). Delivered text shorter than 24 normalized characters cannot be tested safely and conservatively stays seen for the session. Nothing persists across sessions: a new session re-surfaces everything.

No character count decides any of this. A capsule is written to fit 1,000 characters, and that is a target handed to the agent at write time, not a gate at read time: an article whose governing asset a turn touched surfaces whole or does not surface. Earlier versions charged capsule text against a session allowance and degraded the overflow to bare pointers. That allowance was removed in 2.0. It was a constant guessing at a policy nobody had measured, and what it decided was how much an agent got to see. What stands in its place is measurement: every surfaced line records what it cost the window, so context taken can be read against relevance afterwards instead of a constant ruling on it in advance. The one remaining reason a line is not capsule text is an article that has no capsule, which surfaces as a pointer naming the address and telling the agent to read it.

Reading an article through `pi_canon` withdraws the line staged for it before the message goes out, so pull preempts push. Reading the asset file itself does not, because reading a file is not reading what is known about it, and the capsule may hold exactly the constraint the file does not contain. A read-only session exits quietly. After a successful write, edit, patch, or recognized mutating shell call names a governed asset, settling draws one reminder for its article if the article was not updated, once per batch and re-armed by the next modifying call. Unknown tools still surface knowledge when they name a path, but do not invent an update obligation without positive mutation evidence.

Finding a path in a tool call is best effort. Only the input of a tool call is scanned. Results are never scanned, and neither is the model's prose. Inputs are scanned for whole short strings and path-shaped tokens that exist on disk or whose parent directory does, so a file about to be created still surfaces its governing ancestor, and a path with a space inside a longer string is missed. What that feeds, resolution from a path to a governing article, is deterministic. The two claims stay separate on purpose.

`/pi-canon` prints one status line: store root, the mount count when there is one, article count, journal entries, articles surfaced this session, and how many of those are still in context and what they occupy. It goes to the UI and sends the model nothing, so asking costs no context. `PI_CANON_TRACE=<file>` appends one JSON line per surfacing decision, and is inert when the variable is unset.

## Options

Installed as a package, pi loads the default export and takes the defaults. To pass options, write your own extension file and let it call the named export:

```js
// ~/.pi/agent/extensions/my-canon.js
import { registerPiCanon } from "pi-canon"

export default function (pi) {
  registerPiCanon(pi, { mounts: ["/data/lake"] })
}
```

Six keys, and any other throws at registration by name, because everything else is a constant on purpose.

The four behavior keys (`surface`, `resurface`, `retrieval`, `standout`) can also come from `~/.config/pi-canon/settings.json`, which the `/canon-settings` command edits from inside the TUI: booleans and retrieval cycle, the standout cutoff steps along its lattice with left/right and takes an exact value on Enter, and every applied change saves immediately through the same validation registration uses. Explicit options win over the file. `root` and `mounts` are per-project topology and stay code-only; they have no row in the editor and no place in the file.

- **`root`** places the store. Absolute is used as given, relative joins the project cwd. Default `<project>/.canon`.
- **`surface: false`** silences the per-turn flush and the settle reminder. The `pi_canon` tool and `/pi-canon` stay registered and working.
- **`resurface: false`** returns an article to surfacing at most once per session however long ago it left the window. The default is `true`: an article with a presence mark counts as seen only while that mark remains in the context the provider receives, so one folded or compacted away surfaces again the next time its asset is touched. Text shorter than 24 normalized characters has no safe mark and conservatively retains the once-per-session behavior. A fresh touch is what brings a marked article back, so nothing re-surfaces on its own.
- **`retrieval`** ranks the retrieval corpus against what the agent is doing: every off-spine article, plus any article declared `scope: rule` so a rule stays reachable if an asset later appears at its address. Ordinary asset-scoped articles stay out because the address spine already reaches them. The default is `"none"`, which ranks and surfaces nothing by relevance: the spine alone, exactly as 1.0. `"lexical"` is BM25 over the standard library, no dependency and no model. Anything that needs a model is supplied here as `{ name, score, index? }`, so this package never carries one and never decides which you run. With a retriever configured the tool's filing rule changes with it, because the advice costs knowledge in either direction. On the default it says knowledge filed off the asset path never surfaces, which is true and is why you should not file it there. With a retriever it says the opposite: a constraint governing many assets and owning none belongs at its own address naming the rule, because the only parent unrelated packages share is the root and a root article surfaces on every touch of anything.

- **`standout`** is how far the best-ranked article must beat the best one that will not ride anyway, meaning the fourth, the one the three-per-message cap was already going to leave behind. A multiple, not a score: `standout: 1.5` asks for the best to score half again what the first held-back rival scored. Default `1.4`, an operating point priced by a 120-cell benchmark rather than picked: its n=15 comparison with the uncut channel differed by -0.07 rule facts at p=1.0 while cutting suggestions from 26 a session to 3, raised the rate at which the agent acted on one from 0.17 to 0.82, and never fired at all on a store with nothing relevant to say, 0 rankings of 139. That small observed contrast is not a general detection bound. Precision is the side to protect, though the measured argument is tokens rather than attention: a companion 124-cell study found good suggestions opened at similar rates buried among twenty-seven as one of four, so what the cutoff saves is the context it declines to spend on lines that were never going to be read. The other side has a price too, and the same benchmark paid it: a cutoff set past what a decisive ranking reaches silences the channel, and at 2.0 it delivered nothing and gave back everything the channel had won. `standout: 1` is no cutoff, the measurement setting for reading your own store's trace. Below `1` throws at registration, because it asks for the best article to be worse than its rival and is what a caller writes who is still thinking in scores.

  **It is a ratio because a score is not the same quantity twice.** `lexical` normalizes against a saturation ceiling computed from the query, so a score is a fraction of the best match POSSIBLE for that query rather than of the best match available in your store, and it falls as the agent says more. On a 380-article store the same article at the same relevance scored 0.68 against a short question and 0.16 with a hundred words of tool output around it. Across two benchmark runs it was worse than unstable, it inverted: keeping the answers on one corpus needed a cutoff below 0.11, and silencing the other needed one above 0.73. Dividing by another score from the same query cancels both.

  **The comparison is against the top of the ranking, not a quantile of it**, because an agent's turn is long and touches nearly everything: 377 of 378 articles in a benchmark session, so a tenth of the way down the list is deep in the mass that shares one common word, and the ratio to it describes your corpus rather than this query. Measured there, ordinary queries reached 2.64 to 3.28 and the query that actually had something to find reached 3.10, inside that range rather than above it. In the first few ranks the same sessions separated cleanly: every ranking carrying a decisive article beat its first held-back rival by 1.68 to 1.81, and every ranking that did not stayed between 1.00 and 1.28. Still measure on your own store: set `PI_CANON_TRACE` and read the `ranked` lines, which record what each query reached and whether it passed.

  **A drained store does not turn the ratio into a free pass.** Late in a long session, once most of what a small store had to say has been delivered, the still-eligible articles are a tail of near-zero scores, and a ratio over leftovers alone would ride junk on tiny numbers. So while the cutoff is active, the rival the best must beat is floored at the strongest already-delivered article this same query raised: what is left has to beat what the query would have re-raised if it could. A genuinely new topic clears that floor because the delivered articles score weakly on its query; leftovers do not. Replayed over a real 33-article store that the unfloored ratio had emptied entirely into the window, 33 articles down to a minimum ride score of 0.002, the floor cut the session to 15 rides with a floor of 0.075, and the strongest ride improved, because the store had not been spent on junk before the query that deserved it arrived.

The query is intent and never evidence: the user's own words out of the live context, newest first and bounded, keeping both ends of a message too long to carry whole because neither end is reliably the ask, plus this turn's tool calls by name and first argument. Tool results never reach it, and neither does the model's prose, and pi-canon's own nudges are excluded so an article cannot score highly for having been surfaced already. Relevance and transport are bounded separately: `standout` rules on whether the query gets an answer at all, and on top of it at most three ranked articles ride one message, best score first, with articles reached by address never counted against that, because an address is a certainty and a score is a guess. A ranked article is paid for by new intent rather than by another turn passing, so an unchanged question does not keep releasing three more until the residue runs out. The trace records the best score held back against the worst one sent. A retriever that throws costs the turn its ranking and nothing else.
- **`mounts`** lists directories outside the project that carry their own `.canon` beside their assets. `mounts: ["/data/lake"]` serves articles as `lake:prices`, addressable by that name or by any absolute path inside the mount. Two workspaces that mount the same directory read and write the same store, because the store lives with the assets it governs and sharing needs no protocol. A mount has no journal of its own: events are project history and every entry lands in the project store.

## What the code holds, and what it asks for

An immutable journal, an addressing spine, and recall that arrives unasked could sound like a design that removed its dependency on model behavior. It did not. It moved that dependency to one side of a line and constrained the other side, and the line is short enough to state in full.

Held by the runtime:

- A journal entry is created with the exclusive-create flag, so pi_canon never rewrites or deletes one, and a name collision increments a suffix rather than losing an entry. The files stay ordinary Markdown, so any other tool can still rewrite or delete one: append-only is a property of the tool, not of the filesystem.
- Once a path is in hand it resolves to exactly one article, walking to the nearest ancestor that has one, or to nothing at all.
- An article surfaces whole, with no character count able to truncate it or hold it back.
- An article with a presence mark surfaces at most once while that mark remains in the context the provider receives. Presence is read from that projection rather than remembered, so folding or compaction returns a marked article to surfacing; an untestably short delivery or a harness that reports no projection degrades to at most once per session.
- The Codex and Claude Code hooks cannot inspect that projection. They use an explicit compaction cycle instead: session start, context clear, and compaction discard prior touch state; resume does not. None of those events surfaces an article. A later asset touch does. Codex delivers after each tool result; Claude Code combines the current parallel batch into one packet before the next model request.
- Reading an article through the tool withdraws its staged capsule before the message goes out.
- Read-only tools can surface an article but never arm its write-after reminder. A successful modifying tool can.

Asked of the agent, and checked by nothing:

- Read the governing article before working on an asset, and update it after real changes. No write is gated on a prior read, and the settle reminder is a message rather than a gate.
- Record the source as it arrived, names and exact numbers included, because articles distill and only the journal keeps the original.
- File the entry under the right subject, and file a constraint at the asset it governs rather than the asset you happened to edit. On the default `retrieval: "none"`, knowledge filed off the asset path never surfaces; with a retriever configured, a cross-cutting rule can instead live at its own declared address and surface by relevance.
- Open the article when a capsule or a pointer says there is one. A line in the context is not a read.
- Decide whether a dropped constraint still holds. Then follow the rule, against a live prompt asking for something else.

Nothing in the package can compel an agent to keep a line it has decided to cut.

What the package does not do, stated so nothing above reads as more than it is:

- No search that runs unasked. `search` is an action the agent calls; touches resolve to articles by exact address or the ancestor walk, never by ranking, and no query ever fires on the agent's behalf.
- No embeddings and no model. `retrieval: "lexical"` builds a BM25 index over off-spine articles plus declared rules, and ordinary asset-scoped articles are never ranked; any other ranker is a function the caller supplies.
- No filesystem watching, and no staleness detection: `updated` is the date of the last write and is never compared against the asset.
- No delete and no rename. Removing or moving an article is a file operation you perform.
- Articles are last write wins, with no lock, no merge, and no warning that someone else changed the file. Only journal entries get the collision retry.
- No duplicate detection. One canonical address per asset is structural, not checked.
- Nothing writes, summarizes, or compacts on its own, and nothing filters what goes in: no secrets scanning and no redaction. Every line pi-canon wrote came from an explicit tool call.
- Nothing about surfacing persists between sessions. A new session re-surfaces everything.
- Presence is tested against both the article address and the tail of what it actually placed in the provider projection. Any delivery shorter than 24 normalized characters has no safe mark and is conservatively kept present; that can be a tiny read, write, or exceptionally short surfaced line. For marked deliveries, a digest without the delivered tail counts as absent.

## Evidence

This package is measured rather than asserted, and the measurements live in
their own repository: [canon-bench](https://github.com/shaneconner/canon-bench),
the benchmark and evidence repo for this line of work.

The headline study runs five multi-session chains in a shared worktree, each
planting a constraint in one session and probing it in a later one, and scores
whether the agent still honors it. Against a no-extension floor that gets the
prior transcripts and is on record reading them, this package avoided 19 of 20
trap cells to the floor's 8, and answered recall audits at about a third of the
floor's median token cost. Recall accuracy itself was a wash across arms, and a
static doctrine file was cheaper on both metered measures while passing three
fewer trap cells. Full tables, the arms, and the limitations are in
[RESULTS.md](https://github.com/shaneconner/canon-bench/blob/main/RESULTS.md).

That study's forensic pass is what set the current research direction: of
fourteen recall misses, thirteen first went wrong at the write desk (never
captured, or captured and later overwritten) and none at retrieval. The
write-side programme that followed is in
[write-desk/](https://github.com/shaneconner/canon-bench/tree/main/write-desk),
and it is where the growth line documented above comes from: two arms over
byte-identical eight-session histories, where the arm whose tool names article
growth ended with fewer superseded values standing in all three captures. The
third of those is counterbalanced and is the one to read first, because it kept
the direction and took most of the magnitude back.

## Papers

Each carries its per-cell artifact trail on Zenodo. Every DOI below is a concept
DOI, so it resolves to the newest version of that paper rather than to one frozen
deposit.

- **Mutable Canonical Memory over an Immutable Journal, with Recall by Surfacing**, [doi:10.5281/zenodo.21890647](https://doi.org/10.5281/zenodo.21890647). The first campaign, and the one that asks whether the design holds up at all: one governing article per asset, an append-only journal beneath it, and recall that arrives on a touch, measured against a no-extension floor that received the prior transcripts and is on record reading them.
- **Pricing Recall in Long-Term Memory for AI Agents**, [doi:10.5281/zenodo.21960350](https://doi.org/10.5281/zenodo.21960350). Six studies on what recall costs and which parts of it earn their keep. It priced the orientation line and the tool schema (both negative, both deleted), set the `standout` cutoff at a measured operating point, and found the store size past which recall that waits to be asked stops working.
- **The Write Desk**, [doi:10.5281/zenodo.22057257](https://doi.org/10.5281/zenodo.22057257). The first two papers measured recall and took for granted that what the store holds is true. This one tests that and finds it does not hold: writers repeatedly left superseded values in records whose contract is to state what is true now. A condition where the tool speaks at the write boundary ended lower on that endpoint in 20 of 24 capture-lineage comparisons, tied in 2 and higher in 2, but the size did not survive a counterbalanced repeat and is withdrawn rather than qualified. It also freezes the retrieval benchmark that had been reading its corpus live, and reports the cost of two defects found in that freezing by review.

## More

- The benchmark, drivers, frozen protocol, and the verifier that recomputes each paper's quantitative claims from the artifacts: [canon-bench](https://github.com/shaneconner/canon-bench).
- [canon-atlas](https://github.com/shaneconner/canon-atlas), a viewer for a store like this one: the article graph, what each node points at, and what points back. It was built with pi-canon in mind and kept package-agnostic, so it reads any directory of structured Markdown serving as memory. It also enforces the two graph-wide `relations` rules this package parses but cannot see on its own, `orphan.warn` and `children.listed`.
- Interactive versions of the figures and the full measurement story, Part 1 and Part 2: [shaneconner.com/projects/pi-canon](https://shaneconner.com/projects/pi-canon/).
- The first campaign's narrative version: [My agents' wiki was written faster than it was read](https://medium.com/@shane.conner/my-agents-wiki-was-written-faster-than-it-was-read-and-what-was-read-sold-me-back-debt-i-had-a8085319c68b).
- The second campaign's, on pricing recall: [Pricing recall in long-term memory for AI agents](https://medium.com/@shane.conner/pricing-recall-in-long-term-memory-for-ai-agents-7d73f6418c17).
- [pi-fold](https://github.com/shaneconner/pi-fold), a separate optional package serving the working tier. pi-canon ships the two persistent tiers of the same four-tier stack: the journal is the episodic tier, the canon the semantic tier. The two compose, neither requires the other, and neither knows what the other has spent.

MIT. In a clone of this repo, `node tests/verify.mjs` runs the gate suite: every invariant prints by name and the run must end `all N gates green`, 174 of them at this release.
