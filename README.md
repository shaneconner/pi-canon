# pi-canon

Canonical project memory for the [Pi coding agent](https://pi.dev). One article per asset at a knowable address, an append-only journal beneath it: pi-canon surfaces the governing article's capsule as the agent touches an asset, and reminds it to update the article after real changes.

## Why

Agent knowledge bases rot in two ways. Agents cannot tell which article is THE article for a topic, so they scatter near duplicates and cite stale ones. And they treat the knowledge base as a diary, so ground truth drowns in event logs.

pi-canon answers both structurally:

- The article address IS the asset path. `src/core/config.ts` is governed by `articles/src/core/config.md`; a data lake path like `lake/fundamentals/market_cap` works the same way. One place to look, nothing to search.
- The journal is a separate append-only tier. `pi_canon journal` creates a new entry and never rewrites an existing one, so an article that compresses or drifts does not take the entry underneath it with it. Two things are asked of the agent rather than enforced: recording the source as it arrived, names and exact numbers included, and filing the entry under the right subject, which is what puts it one hop from the article a later session reaches it from. The entries stay ordinary Markdown and any file tool can still edit them.

## The store

    .canon/
      articles/
        src/core/config.md        article governing src/core/config.*
        lake/prices.md            articles are not limited to code
      journal/
        2026-08-10-inception.md   one file per entry, never rewritten by the tool

Articles are markdown with a few owned lines of front matter, each with a job:

    ---
    capsule: Loads layered config; env beats file; secrets never land here.
    updated: 2026-08-10
    ---
    The body: dense current understanding of this asset.

`capsule` is the one dense line surfacing injects. `updated` is the date of the last write. Rename an asset by moving its article with it; lint names any wikilinks that go dead. Foreign front matter keys, such as Obsidian properties, ride through writes untouched.

The tree is plain markdown and a valid Obsidian vault; if you think of it as a project wiki, that is the right instinct, with one rule added: every article has exactly one canonical address. Commit it with your repo: git is the history, diff, blame, and time machine. pi-canon never runs git itself. Journal entries are ordinary files too: pi_canon only appends them; read them with normal file tools.

## Surfacing

Each session opens with one orientation line: how many articles govern the project, or an invitation to write the first one. When a tool call touches an asset whose governing article has not been seen this session, pi-canon stages the capsule; the tool call itself sends nothing. Each turn delivers everything staged as one message, once per article per session, because the steering queue drains one message per provider round trip and a message per tool call would buy every nudge its own model call. Reading an article through `pi_canon` withdraws the line staged for it before that message goes out, so pull preempts push; reading the asset itself does not, since reading a file is not reading what is known about it. Capsule bodies share a 4,000 character session allowance, tested per capsule against what is left: a capsule that does not fit is replaced by a pointer saying the article exists and should be read, so a shorter capsule can still land after a longer one was refused. The message header, those pointers, and the settle reminder are outside that counter. Finding a path in a tool call is best effort; resolution, once a path is in hand, is not. It walks up to the nearest existing ancestor article, so not every file needs an article, and it can walk to the top and find nothing. After the agent settles, touched but not updated articles draw a single reminder. `/pi-canon` prints a status line: articles, journal entries, and what surfacing has spent this session.

## Tool

One tool, `pi_canon`, four actions:

| action | does |
|---|---|
| `read` | the article at an address; a miss points to the nearest governing ancestor |
| `write` | create or update an article; returns advisory lint, never refuses |
| `journal` | append an event entry, source details intact; pi_canon never rewrites one |
| `map` | list articles with their capsules |

Entries logged with `subject` addresses reappear as a one-line journal index when those articles are read, so event history is there to dig into without ever loading by default.

## Options

    import piCanon, { registerPiCanon } from "pi-canon"

    piCanon(pi)                                      defaults
    registerPiCanon(pi, { root, surface, mounts })   the whole surface

Installed as a package, pi loads the default export with defaults; the named export is for an extension file of your own when you want options. `root` is where the project store lives (default `<project>/.canon`). `surface: false` disables nudging. `mounts` lists directories outside the project that carry their own `.canon` beside their assets: `mounts: ["/data/lake"]` serves articles as `lake:prices`, and two workspaces that mount the same directory share its knowledge, because the store lives with the assets it governs. Everything else is a constant on purpose.

## Install

    pi install npm:pi-canon

Or clone this repo into `~/.pi/agent/extensions/`. Node 22 or later, Pi 0.83 or later.

MIT. pi-canon is the long-term half of a four-tier memory stack: the journal is the episodic tier, the canon the semantic tier. [pi-fold](https://github.com/shaneconner/pi-fold) is a separate, optional package serving the working tier; the two compose but neither requires the other.

The design and a four-arm multi-session evaluation are written up in *pi-canon: Mutable Canonical Memory over an Immutable Journal, with Recall by Surfacing*, [doi:10.5281/zenodo.21890647](https://doi.org/10.5281/zenodo.21890647). The benchmark is [canon-bench](https://github.com/shaneconner/canon-bench).
