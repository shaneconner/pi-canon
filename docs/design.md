# Design

Decisions and the reasons they beat their alternatives. Written 2026-08-10, at v0.1.

## Shape

Three-tier memory: short term is the context window, episodic is pi-fold, long term is pi-canon. Four parts ship in one package: wiki, journal, spine, surfacing. They stay together because the rare parts (asset addressing, read-before / write-after, capsule injection) ARE the surfacing mechanism; a knowledge store without its enforcement mechanism rots the way unread convention files rot.

## Addressing

The wiki address is the asset path with its file extension dropped. Identity mapping needs zero configuration and makes the spine a convention instead of a mode: an article that matches no asset is simply free knowledge, and no flag distinguishes it. Resolution walks up to the nearest existing ancestor, so the rule is at most one canonical home, not one article per file. Renames are one line of `aliases` front matter; addresses are locators, and the alias keeps every old reference resolving.

## Storage

Plain markdown under `.canon/`, committed with the repo. Git supplies history, merge, blame, and time travel; pi-canon runs no git itself and holds no database. Front matter is a strict YAML subset (single line values, inline arrays) parsed in forty lines instead of a dependency; keys written by other tools, such as Obsidian properties, are carried through writes untouched. Journal entries are one file each, created with the `wx` flag: append-only by construction, and EEXIST is the retry signal, so concurrent writers each land on their own file.

## Surfacing

Tool call inputs are scanned for path-shaped tokens that exist on disk; each resolves to its governing article and stages its capsule. Each turn flushes the staged lines as ONE steered message: pi's steering queue drains one message per provider round trip, so a message per tool call would buy every nudge its own extra LLM call. Once per article per session, under a hard budget, pointers after; an article counts as seen only when its line is part of a flushed message. The write-after half is one reminder at agent settle naming touched but not updated articles. No embeddings in v1: deterministic resolution beats similarity for asset-scoped knowledge, and the nudge discipline (once, bounded, silenceable) is pi-fold's proven pattern.

## Lint

Advisory strings returned from write, never a refusal: a blocked write teaches an agent to stop writing. Warn past 8000 chars, large past 20000, a fold-up hint under 400 when a parent exists. Journalish addresses draw a redirect to the journal. Dead wikilinks are named; alias links are not false positives.

## Constants over options

The public surface is two options: `root` and `surface`. Budget, size bands, and the capsule cap are constants; a constant that needs changing becomes a new default, not a knob. Unknown options throw by name.

## Deferred, each behind a demonstrated need

Durable suppression ledger; embedding recall; staleness derived from source dependency changes; a generated self-contained HTML viewer; a shared surfacing budget protocol with pi-fold.
