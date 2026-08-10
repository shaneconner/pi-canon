/* pi-canon: canonical project memory for Pi. Wiring only; mechanics live in lib/. */

import { isAbsolute, join } from "node:path";
import { CanonStore } from "./lib/store.ts";
import { SESSION_BUDGET_CHARS, Surfacer } from "./lib/surfacing.ts";
import { buildCanonTool, type CanonRuntime } from "./lib/tool.ts";

export interface CanonOptions {
  /* Where the store lives. Default: <project>/.canon */
  root?: string;
  /* Surface governing articles as tool calls touch assets. Default: true. */
  surface?: boolean;
}

export function registerPiCanon(pi: any, options: CanonOptions = {}): void {
  const unknown = Object.keys(options).find((key) => key !== "root" && key !== "surface");
  if (unknown) {
    throw new Error(
      `pi-canon: unknown option "${unknown}". The options are root and surface; everything else is a constant on purpose.`,
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
      runtime = { store, surfacer: new Surfacer(store, cwd), cwd };
    }
    return runtime;
  };

  pi.registerTool(buildCanonTool(ready));

  pi.on("session_start", (_event: unknown, ctx: any) => {
    runtime = undefined;
    ready(ctx);
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
      const { store, surfacer } = ready(ctx);
      const { surfaced, spent } = surfacer.stats;
      ctx.ui.notify(
        `pi-canon at ${store.root}: ${store.list().length} articles, ${store.journalCount()} journal ` +
          `entries; ${surfaced} surfaced this session (${spent} of ${SESSION_BUDGET_CHARS} capsule chars).`,
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
