# Design

Decisions and the reasons they beat their alternatives. Written 2026-08-10, at v0.1.

## Shape

Three-tier memory: short term is the context window, episodic is pi-fold, long term is pi-canon. One package ships the store (articles and journal), the surfacing layer, and the tool with its advisory lint. They stay together because the rare parts (asset addressing, read-before / write-after, capsule injection) ARE the surfacing mechanism; a knowledge store without its enforcement mechanism rots the way unread convention files rot. The spine is not a component: it is the addressing convention itself, and it holds because nothing has to opt into it.

## Addressing

The wiki address is the asset path with its file extension dropped. Identity mapping needs zero configuration and makes the spine a convention instead of a mode: an article that matches no asset is simply free knowledge, and no flag distinguishes it. Resolution walks up to the nearest existing ancestor, so the rule is at most one canonical home, not one article per file. Renames are a file move: the article travels with its asset, and lint names any wikilink that goes dead. An aliases layer was built and then deleted; a moved file plus a named dead link beats maintaining a parallel address book.

Assets outside the project mount by directory: each mount carries its own `.canon` beside the assets it governs, addressed by basename (`lake:prices`). Sharing needs no protocol; two workspaces that mount the same directory read and write the same store, and git on that directory is the sync.

## Storage

Plain markdown under `.canon/`, committed with the repo. Git supplies history, merge, blame, and time travel; pi-canon runs no git itself and holds no database. Front matter is a strict YAML subset (single line values, inline arrays) parsed in forty lines instead of a dependency; keys written by other tools, such as Obsidian properties, are carried through writes untouched. Journal entries are one file each, created with the `wx` flag: append-only through the tool, since pi-canon can never overwrite an entry, and EEXIST is the retry signal, so concurrent writers each land on their own file. Entries carrying `subject` addresses double as an index: read lists their filenames beneath the article, history on offer but never loaded by default.

## Surfacing

A single orientation line opens every session: benchmark runs showed that a fresh or headless session otherwise never hears the doctrine, because the settle reminder rides the next turn and a one-shot session does not have one. Tool call inputs are scanned for path-shaped strings that exist on disk or are about to (an existing parent is enough); each resolves to its governing article and stages its capsule. Touch discovery is best effort by nature; what it feeds is deterministic resolution, and the two claims stay separate on purpose. Each turn flushes the staged lines as ONE steered message: pi's steering queue drains one message per provider round trip, so a message per tool call would buy every nudge its own extra LLM call. Once per article per session, under a hard budget, pointers after; an article counts as seen, and its capsule charged against the budget, only when its line is part of a flushed message, so a nudge withdrawn by an actual read costs nothing. The write-after half is one reminder at agent settle naming touched but not updated articles. No embeddings in v1: deterministic resolution beats similarity for asset-scoped knowledge, and the nudge discipline (once, bounded, silenceable) is pi-fold's proven pattern.

## Lint

Advisory strings returned from write, never a refusal: a blocked write teaches an agent to stop writing. Warn past 8000 chars, large past 20000, a fold-up hint under 400 when a parent exists. Split at asset boundaries first; past large, the article goes hierarchical, staying as summary and router while detail moves to children at chunks worth loading separately. Journalish addresses draw a redirect to the journal. Dead wikilinks are named.

## Constants over options

The public surface is two options: `root` and `surface`. Budget, size bands, and the capsule cap are constants; a constant that needs changing becomes a new default, not a knob. Unknown options throw by name.

## Deferred, each behind a demonstrated need

Durable suppression ledger; embedding recall; staleness derived from source dependency changes; a generated self-contained HTML viewer; a shared surfacing budget protocol with pi-fold.
