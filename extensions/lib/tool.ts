/* The pi_canon tool: one tool, four verbs. Read and update over create; the journal
   for events; map to orient. */

import { advise } from "./lint.ts";
import { normalize, type CanonStore } from "./store.ts";
import type { Surfacer } from "./surfacing.ts";

export interface CanonRuntime {
  store: CanonStore;
  surfacer: Surfacer;
  cwd: string;
}

export function buildCanonTool(ready: (ctx: unknown) => CanonRuntime) {
  return {
    name: "pi_canon",
    label: "pi-canon",
    description:
      "Canonical project memory. Every asset has at most one governing article at its own address " +
      "(src/core/config, lake/prices). read the governing article before working on an asset; " +
      "write it after real changes. journal appends an immutable event entry; map lists articles " +
      "with their capsules. Creation is rare: prefer updating the article that already governs.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "write", "journal", "map"] },
        path: {
          type: "string",
          description: "Article address, e.g. src/core/config. Required for read and write; optional filter for map.",
        },
        body: { type: "string", description: "write: the full article body. journal: the event text." },
        capsule: { type: "string", description: "write: one dense line injected when the asset is touched." },
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

function run(runtime: CanonRuntime, params: Record<string, unknown>): string {
  const { store, surfacer, cwd } = runtime;
  const action = String(params.action ?? "");
  const path = typeof params.path === "string" ? normalize(params.path, cwd) : "";

  switch (action) {
    case "read": {
      if (!path) return "read needs a path.";
      const article = store.lookup(path);
      if (!article) {
        const ancestor = store.resolve(path);
        const where = ancestor
          ? `Nearest governing article: ${ancestor.path}.`
          : "No ancestor article exists either.";
        return `No article at ${path}. ${where} If you are working on this asset, create its article with write after the task.`;
      }
      surfacer.markSeen(article.path);
      const head = [
        article.capsule ? `capsule: ${article.capsule}` : "",
        article.updated ? `updated: ${article.updated}` : "",
      ].filter(Boolean).join("\n");
      return `${article.path}\n${head}\n\n${article.body}`.trim();
    }
    case "write": {
      if (!path) return "write needs a path.";
      const article = store.write(path, {
        capsule: typeof params.capsule === "string" ? params.capsule : undefined,
        body: typeof params.body === "string" ? params.body : undefined,
      });
      surfacer.markUpdated(article.path);
      return [`Wrote ${article.path}.`, ...advise(article, store)].join("\n");
    }
    case "journal": {
      const body = typeof params.body === "string" ? params.body.trim() : "";
      if (!body) return "journal needs a body: what happened, densely.";
      const subject = Array.isArray(params.subject) ? params.subject.map((s) => normalize(String(s), cwd)) : undefined;
      const file = store.journal({
        body,
        subject,
        slug: typeof params.slug === "string" ? params.slug : undefined,
      });
      return `Logged ${file.split("/").at(-1)}.`;
    }
    case "map":
      return store.map(path);
    default:
      return `Unknown action "${action}". Actions: read, write, journal, map.`;
  }
}
