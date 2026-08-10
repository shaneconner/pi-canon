/* pi-canon: canonical project memory for Pi. Wiring only; mechanics live in lib/. */

import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { CanonStore } from "./lib/store.ts";
import { Surfacer } from "./lib/surfacing.ts";
import { buildCanonTool, type CanonRuntime } from "./lib/tool.ts";

export interface CanonOptions {
  /* Where the store lives. Default: <project>/.canon */
  root?: string;
  /* Surface governing articles as tool calls touch assets. Default: true. */
  surface?: boolean;
}

const OPTION_NAMES = new Set(["root", "surface"]);

export function registerPiCanon(pi: any, options: CanonOptions = {}): void {
  for (const key of Object.keys(options)) {
    if (!OPTION_NAMES.has(key)) {
      throw new Error(
        `pi-canon: unknown option "${key}". The surface is root and surface; everything else is a constant on purpose.`,
      );
    }
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
      runtime = { store, surfacer: new Surfacer(store, cwd) };
    }
    return runtime;
  };

  pi.registerTool(buildCanonTool(ready));

  pi.on("session_start", (_event: unknown, ctx: any) => {
    runtime = undefined;
    ready(ctx);
  });

  pi.on("tool_call", (event: any, ctx: any) => {
    if (!surface || event?.toolName === "pi_canon") return;
    const { surfacer } = ready(ctx);
    const text = surfacer.nudge(surfacer.pathsIn(event?.input));
    if (text) deliver(pi, text, "steer");
  });

  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    if (!surface) return;
    const text = ready(ctx).surfacer.settleNudge();
    if (text) deliver(pi, text, "nextTurn");
  });

  pi.registerCommand("pi-canon", {
    description: "pi-canon status: articles, journal entries, surfacing this session",
    handler: async (_args: string, ctx: any) => {
      const { store } = ready(ctx);
      const journalCount = countJournal(store);
      const status = `pi-canon at ${store.root}: ${store.list().length} articles, ${journalCount} journal entries.`;
      deliver(pi, status, "nextTurn");
    },
  });
}

function countJournal(store: CanonStore): number {
  try {
    return readdirSync(store.journalDir).filter((name) => name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function deliver(pi: any, content: string, deliverAs: "steer" | "nextTurn"): void {
  if (typeof pi.sendMessage !== "function") return;
  try {
    pi.sendMessage({ customType: "pi-canon", content, display: false }, { deliverAs });
  } catch {
    /* a lost nudge must never break the turn */
  }
}
