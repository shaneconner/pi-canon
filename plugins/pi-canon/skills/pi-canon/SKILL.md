---
name: pi-canon
description: Use canonical project memory when a project has a .canon store, or when the user asks to read, write, map, search, or journal durable project knowledge.
---

# pi-canon

Use the `pi_canon` tool as the project's durable memory surface.

- Before relying on an existing asset, read the article at its path. Resolution will walk to the nearest governing ancestor.
- After a real change to what is true, update the governing article. Prefer refining an existing article over creating another.
- Journal events and source history with exact names, identifiers, counts, limits, and durations intact. Articles hold current truth; journal entries preserve what happened.
- Use `map` to orient and `search` only when the address is not known.
- Do not write merely because a file was touched. If nothing durable changed, leave the article alone.
- Keep `.canon` with the project so Codex, Claude Code, Pi, people, and git all see the same memory.
