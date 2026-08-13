/* The pi_canon tool: one tool, four verbs. Read and update over create; the journal
   for events; map to orient. */

import { basename } from "node:path";
import { advise, unapplied, unretained } from "./lint.ts";
import { normalize, type CanonStore } from "./store.ts";
import type { Mount, Surfacer } from "./surfacing.ts";

export interface CanonRuntime {
  store: CanonStore;
  surfacer: Surfacer;
  cwd: string;
  mounts: Mount[];
  retrieval: string;
}

/* A path routes to the mount it names (lake:prices), the mount whose directory
   contains it, or the project. */
function route(runtime: CanonRuntime, raw: string): { mount: Mount; path: string } {
  const qualified = /^([\w.-]+):(.*)$/.exec(raw);
  if (qualified) {
    const mount = runtime.mounts.find((m) => m.name === qualified[1]);
    if (mount) return { mount, path: normalize(qualified[2], mount.dir) };
  }
  const slashed = raw.replace(/\\/g, "/");
  for (const mount of runtime.mounts) {
    if (mount.name && (slashed === mount.dir || slashed.startsWith(`${mount.dir}/`))) {
      return { mount, path: normalize(slashed, mount.dir) };
    }
  }
  return { mount: runtime.mounts[0], path: normalize(raw, runtime.cwd) };
}

export function buildCanonTool(ready: (ctx: unknown) => CanonRuntime, retrieval = "none") {
  return {
    name: "pi_canon",
    label: "pi-canon",
    description:
      "Canonical project memory. Every asset has at most one governing article at its own address " +
      "(src/core/config, lake/prices). read the governing article before working on an asset; " +
      "write it after real changes. journal appends an immutable event entry: record the source " +
      "as it happened, names and exact numbers included, because articles distill and only the " +
      "journal keeps the original, so distil the prose but carry exact values through verbatim: " +
      "ids, keys, names, counts, limits and durations, every member of a named set and not " +
      "just the one you are working on. A rule without its values is worth nothing to the " +
      "session that needs it. map lists articles with their capsules. " +
      "Creation is rare: prefer updating the article that already governs. " +
      "File a constraint at the asset it governs, or the shared parent when it spans assets, not " +
      "the asset you happened to edit. " + filingTail(retrieval),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "journal", "map"] },
        path: {
          type: "string",
          description: "Article address, e.g. src/core/config. Required for read and write; optional filter for map.",
        },
        body: {
          type: "string",
          description:
            "write: the full article body; specifics beat summaries (who consumes what, exact " +
            "limits, what breaks). journal: the event text, source details intact.",
        },
        capsule: { type: "string", description: "write: one dense line injected when the asset is touched." },
        scope: {
          type: "string",
          enum: ["rule"],
          description:
            "write: set to 'rule' when this article names a cross-cutting rule instead of " +
            "governing an asset, so it is a rule on purpose rather than an article whose asset went missing.",
        },
        subject: {
          type: "array",
          items: { type: "string" },
          description: "journal: article addresses this event concerns.",
        },
        slug: { type: "string", description: "journal: short name for the entry file." },
      },
      required: ["action"],
    },
    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: unknown,
      _onUpdate: unknown,
      ctx: unknown,
    ) {
      const text = run(ready(ctx), params);
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

/* The last clause of the filing rule is configuration dependent, and getting it wrong
   in either direction costs knowledge. With no retriever an article at an address that
   governs no asset is genuinely unreachable, so the doctrine must not invite one: the
   only honest instruction is to keep everything on the asset path. With a retriever
   that same article is reachable by relevance, and the instruction inverts, because the
   alternative is filing a constraint that spans unrelated packages at their only shared
   parent, which is the root, and a root article surfaces on every touch of anything.

   Taken from the caller, which built the retriever, rather than read back off the
   runtime: the runtime is created from the session's ctx, and forcing it into existence
   at registration to answer this would pin it to the wrong working directory. */
function filingTail(retrieval: string): string {
  if (retrieval === "none") {
    return "Knowledge filed off the asset path never surfaces.";
  }
  return (
    "A constraint that governs many assets and owns none belongs at its own address, one " +
    "naming the rule rather than any asset, because the only parent unrelated packages share " +
    "is the root and a root article surfaces on every touch of anything. Those articles are " +
    "reached by relevance to the work rather than by address, so give them a capsule that " +
    "reads like the situation it governs, and write them with scope rule so a rule on purpose " +
    "is not mistaken for an article whose asset went missing."
  );
}

function run(runtime: CanonRuntime, params: Record<string, unknown>): string {
  const { surfacer } = runtime;
  const action = String(params.action ?? "");
  const { mount, path } = typeof params.path === "string" ? route(runtime, params.path) : { mount: runtime.mounts[0], path: "" };
  const store = mount.store;
  const qualify = (p: string) => (mount.name ? `${mount.name}:${p}` : p);

  switch (action) {
    case "read": {
      if (!path) return "read needs a path.";
      const article = store.resolve(path);
      if (!article) {
        return `No article governs ${path}. If you are working on this asset, create its article with write after the task.`;
      }
      /* Everything this result is about to put in the window, so presence is tested
         against the body it delivered rather than the capsule it happens to share with
         a one-line surfaced nudge. An article whose body folds away is not present. */
      surfacer.markSeen(qualify(article.path), `${article.capsule}\n${article.body}`);
      const title = article.path === path ? qualify(article.path) : `${qualify(article.path)} governs ${qualify(path)}`;
      const head = [
        article.capsule ? `capsule: ${article.capsule}` : "",
        article.updated ? `updated: ${article.updated}` : "",
      ].filter(Boolean).join("\n");
      /* Filenames only, newest three: the index invites digging, it never pays for it. */
      const mentions = runtime.mounts[0].store.journalMentions(qualify(article.path));
      const recent = mentions.slice(-3).reverse();
      const earlier = mentions.length - recent.length;
      const index = recent.length
        ? `\n\njournal: ${recent.join(", ")}${earlier ? ` and ${earlier} earlier` : ""}`
        : "";
      return `${title}\n${head}\n\n${article.body}`.trim() + index;
    }
    case "write": {
      if (!path) return "write needs a path.";
      /* Blank means untouched: models fill declared string fields with "" routinely,
         and a "" here would silently erase stored content. */
      const priorBody = params.body ? store.read(path)?.body : undefined;
      const article = store.write(path, {
        capsule: params.capsule ? String(params.capsule) : undefined,
        body: params.body ? String(params.body) : undefined,
        scope: params.scope ? String(params.scope) : undefined,
      });
      surfacer.markUpdated(qualify(article.path));
      return [
        `Wrote ${qualify(article.path)}.`,
        ...advise(article, store, priorBody, { dir: mount.dir, retrieval: runtime.retrieval }),
      ].join("\n");
    }
    case "journal": {
      const body = typeof params.body === "string" ? params.body.trim() : "";
      if (!body) return "journal needs a body: what happened, densely.";
      /* Events are project history; the journal always lives in the project store,
         with subjects qualified so mounted articles index them too. */
      const subject = Array.isArray(params.subject)
        ? params.subject.map((s) => {
            const routed = route(runtime, String(s));
            return routed.mount.name ? `${routed.mount.name}:${routed.path}` : routed.path;
          })
        : undefined;
      const file = runtime.mounts[0].store.journal({
        body,
        subject,
        slug: typeof params.slug === "string" ? params.slug : undefined,
      });
      /* The article was written before this entry (agents write then journal), so this
         is the first moment both exist. Report what the source kept and the article did
         not: capbase measured the journal holding every value and the article keeping a
         quarter of them, and cap1 measured an article without its values scoring exactly
         what no article scores. */
      const missed: string[] = [];
      const govern: string[] = [];
      for (const address of subject ?? []) {
        const routed = route(runtime, address);
        const governing = routed.mount.store.read(routed.path);
        for (const value of unretained(body, governing)) {
          missed.push(`${routed.path} is missing ${value}`);
        }
        if (unapplied(governing, routed.mount.dir)) govern.push(routed.path);
      }
      return [
        `Logged ${basename(file)}.`,
        ...(missed.length
          ? [
              `This entry records values its article does not carry: ${missed.slice(0, 6).join("; ")}. ` +
                "The article is what surfaces on a touch; the journal is not. If those values " +
                "matter beyond this event, put them in the article verbatim.",
            ]
          : []),
        ...(govern.length
          ? [
              `${govern.slice(0, 3).join(", ")} now states a rule. Re-read what it governs and ` +
                "confirm the code does what the article says: recording a rule and applying it " +
                "are separate acts, and this is the moment the rule is in hand.",
            ]
          : []),
      ].join("\n");
    }
    case "map":
      return store.map(path);
    default:
      return `Unknown action "${action}". Actions: read, write, journal, map.`;
  }
}
