/* pi-canon: canonical project memory for Pi. Wiring only; mechanics live in lib/. */

import { basename, isAbsolute, join } from "node:path";
import { CanonStore } from "./lib/store.ts";
import { SESSION_BUDGET_CHARS, Surfacer, type Mount } from "./lib/surfacing.ts";
import { buildCanonTool, type CanonRuntime } from "./lib/tool.ts";

export interface CanonOptions {
  /* Where the project store lives. Default: <project>/.canon */
  root?: string;
  /* Surface governing articles as tool calls touch assets. Default: true. */
  surface?: boolean;
  /* Directories outside the project that carry their own .canon beside their
     assets, addressed by basename: mounts: ["/data/lake"] serves lake:prices.
     Workspaces that mount the same directory share its knowledge. */
  mounts?: string[];
}

export function registerPiCanon(pi: any, options: CanonOptions = {}): void {
  const unknown = Object.keys(options).find((key) => key !== "root" && key !== "surface" && key !== "mounts");
  if (unknown) {
    throw new Error(
      `pi-canon: unknown option "${unknown}". The options are root, surface, and mounts; everything else is a constant on purpose.`,
    );
  }
  const surface = options.surface !== false;

  let runtime: CanonRuntime | undefined;

  const ready = (ctx: any): CanonRuntime => {
    if (!runtime) {
      const cwd: string = ctx?.cwd ?? process.cwd();
      const root = options.root
        ? isAbsolute(options.root)
          ? options.root
          : join(cwd, options.root)
        : join(cwd, ".canon");
      const store = new CanonStore(root);
      const mounts: Mount[] = [
        { name: "", dir: cwd, store },
        ...(options.mounts ?? []).map((dir) => {
          const abs = isAbsolute(dir) ? dir : join(cwd, dir);
          return { name: basename(abs), dir: abs, store: new CanonStore(join(abs, ".canon")) };
        }),
      ];
      runtime = { store, surfacer: new Surfacer(mounts), cwd, mounts };
    }
    return runtime;
  };

  pi.registerTool(buildCanonTool(ready));

  /* One orientation line per session, riding the first turn: without it a fresh
     or headless session never hears the doctrine, and the write-after reminder
     (nextTurn at settle) cannot reach a session that ends when the agent does. */
  pi.on("session_start", (_event: unknown, ctx: any) => {
    runtime = undefined;
    const { store } = ready(ctx);
    if (!surface) return;
    const count = store.list().length;
    const text = count
      ? `[pi-canon] ${count} ${count === 1 ? "article governs" : "articles govern"} this project. Read the governing ` +
        "article before working on an asset; after real changes update it and journal the " +
        "source: names, exact numbers, who said what. Articles distill; the journal keeps the original."
      : "[pi-canon] No articles yet in .canon/. When work teaches you something durable about an " +
        "asset, write its article with pi_canon and journal the source as it happened: names, " +
        "exact numbers, who said what. Articles distill; the journal keeps the original.";
    deliver(pi, text, "nextTurn");
  });

  /* Touches stage; turns flush. One steered message per turn rides the provider
     round trip that was happening anyway. */
  pi.on("tool_call", (event: any, ctx: any) => {
    if (!surface || event?.toolName === "pi_canon") return;
    const { surfacer } = ready(ctx);
    surfacer.collect(surfacer.pathsIn(event?.input));
  });

  pi.on("turn_end", (_event: unknown, ctx: any) => {
    if (!surface) return;
    const text = ready(ctx).surfacer.flush();
    if (text) deliver(pi, text, "steer");
  });

  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    if (!surface) return;
    const { surfacer } = ready(ctx);
    const text = [surfacer.flush(), surfacer.settleNudge()].filter(Boolean).join("\n");
    if (text) deliver(pi, text, "nextTurn");
  });

  pi.registerCommand("pi-canon", {
    description: "pi-canon status: articles, journal entries, surfacing this session",
    handler: async (_args: string, ctx: any) => {
      const { store, surfacer, mounts } = ready(ctx);
      const { surfaced, spent } = surfacer.stats;
      const mounted = mounts.length > 1 ? `, ${mounts.length - 1} mounted` : "";
      ctx.ui.notify(
        `pi-canon at ${store.root}${mounted}: ${store.list().length} articles, ${store.journalCount()} journal ` +
          `entries; ${surfaced} seen this session (${spent} of ${SESSION_BUDGET_CHARS} capsule chars).`,
        "info",
      );
    },
  });
}

function deliver(pi: any, content: string, deliverAs: "steer" | "nextTurn"): void {
  try {
    pi.sendMessage({ customType: "pi-canon", content, display: false }, { deliverAs });
  } catch {
    /* a lost nudge must never break the turn */
  }
}
