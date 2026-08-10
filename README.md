# pi-canon

Canonical project memory for the [Pi coding agent](https://pi.dev). One article per asset at a knowable address, an append-only journal beneath it: pi-canon surfaces the governing article's capsule as the agent touches an asset, and reminds it to update the article after real changes.

## Why

Agent knowledge bases rot in two ways. Agents cannot tell which article is THE article for a topic, so they scatter near duplicates and cite stale ones. And they treat the knowledge base as a diary, so ground truth drowns in event logs.

pi-canon answers both structurally:

- The wiki address IS the asset path. `src/core/config.ts` is governed by `wiki/src/core/config.md`; a data lake path like `lake/fundamentals/market_cap` works the same way. One place to look, nothing to search.
- The journal is a separate, immutable tier. Events go there; articles hold only the current best understanding.

## The store

    .canon/
      wiki/
        src/core/config.md        article governing src/core/config.*
        lake/prices.md            articles are not limited to code
      journal/
        2026-08-10-inception.md   immutable, one file per entry

Articles are markdown with a few owned lines of front matter, each with a job:

    ---
    capsule: Loads layered config; env beats file; secrets never land here.
    aliases: [src/config]
    updated: 2026-08-10
    ---
    The body: dense current understanding of this asset.

`capsule` is the one dense line surfacing injects. `aliases` keep old addresses resolving after a rename. `updated` is the staleness stamp readers can discount by.

The tree is plain markdown and a valid Obsidian vault. Commit it with your repo: git is the history, diff, blame, and time machine. pi-canon never runs git itself. Journal entries are ordinary files too: pi_canon only appends them; read them with normal file tools.

## Surfacing

When a tool call touches an asset whose governing article has not been seen this session, pi-canon stages the capsule; each turn delivers everything staged as one bounded message, once per article per session, under a hard budget (pointers only once it is spent). Resolution walks up: the nearest existing ancestor article governs, so not every file needs an article. After the agent settles, touched but not updated articles draw a single reminder. `/pi-canon` prints a status line: articles, journal entries, and what surfacing has spent this session.

## Tool

One tool, `pi_canon`, four actions:

| action | does |
|---|---|
| `read` | the article at an address; a miss points to the nearest governing ancestor |
| `write` | create or update an article; returns advisory lint, never refuses |
| `journal` | append an event entry; pi_canon never rewrites one |
| `map` | list articles with their capsules |

## Options

    import piCanon, { registerPiCanon } from "pi-canon"

    piCanon(pi)                                      defaults
    registerPiCanon(pi, { root, surface, mounts })   the whole surface

Installed as a package, pi loads the default export with defaults; the named export is for an extension file of your own when you want options. `root` is where the project store lives (default `<project>/.canon`). `surface: false` disables nudging. `mounts` lists directories outside the project that carry their own `.canon` beside their assets: `mounts: ["/data/lake"]` serves articles as `lake:prices`, and two workspaces that mount the same directory share its knowledge, because the store lives with the assets it governs. Everything else is a constant on purpose.

## Install

    pi install npm:pi-canon    (not yet published)

Or clone this repo into `~/.pi/agent/extensions/`. Node 22 or later, Pi 0.83 or later.

MIT. pi-canon is the long-term tier of a three-tier memory architecture; [pi-fold](https://github.com/shaneconner/pi-fold) is the episodic tier.
