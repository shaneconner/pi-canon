/* The pi_canon tool: one tool, four verbs. Read and update over create; the journal
   for events; map to orient. */

import { basename } from "node:path";
import { advise } from "./lint.ts";
import { normalize, type CanonStore } from "./store.ts";
import type { Mount, Surfacer } from "./surfacing.ts";

export interface CanonRuntime {
  store: CanonStore;
  surfacer: Surfacer;
  cwd: string;
  mounts: Mount[];
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
  const { surfacer, cwd } = runtime;
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
      surfacer.markSeen(qualify(article.path));
      const title = article.path === path ? qualify(article.path) : `${qualify(article.path)} governs ${qualify(path)}`;
      const head = [
        article.capsule ? `capsule: ${article.capsule}` : "",
        article.updated ? `updated: ${article.updated}` : "",
      ].filter(Boolean).join("\n");
      return `${title}\n${head}\n\n${article.body}`.trim();
    }
    case "write": {
      if (!path) return "write needs a path.";
      /* Blank means untouched: models fill declared string fields with "" routinely,
         and a "" here would silently erase stored content. */
      const article = store.write(path, {
        capsule: params.capsule ? String(params.capsule) : undefined,
        body: params.body ? String(params.body) : undefined,
      });
      surfacer.markUpdated(qualify(article.path));
      return [`Wrote ${qualify(article.path)}.`, ...advise(article, store)].join("\n");
    }
    case "journal": {
      const body = typeof params.body === "string" ? params.body.trim() : "";
      if (!body) return "journal needs a body: what happened, densely.";
      /* Events are project history; the journal always lives in the project store. */
      const subject = Array.isArray(params.subject) ? params.subject.map((s) => normalize(String(s), cwd)) : undefined;
      const file = runtime.mounts[0].store.journal({
        body,
        subject,
        slug: typeof params.slug === "string" ? params.slug : undefined,
      });
      return `Logged ${basename(file)}.`;
    }
    case "map":
      return store.map(path);
    default:
      return `Unknown action "${action}". Actions: read, write, journal, map.`;
  }
}
