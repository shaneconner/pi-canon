/* pi-canon: canonical project memory for Pi. Wiring only; mechanics live in lib/. */

import { appendFileSync } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { buildRetriever, type RetrievalOption } from "./lib/retrieval.ts";
import { CanonStore } from "./lib/store.ts";
import { Surfacer, type Mount } from "./lib/surfacing.ts";
import { buildCanonTool, type CanonRuntime } from "./lib/tool.ts";

export interface CanonOptions {
  /* Where the project store lives. Default: <project>/.canon */
  root?: string;
  /* Surface governing articles as tool calls touch assets. Default: true. */
  surface?: boolean;
  /* Treat an article as seen only while it is still in the live context window, so one
     folded or compacted away surfaces again the next time its asset is touched.
     Default: true. Set false for 1.0 behavior, where a surfaced article is never
     surfaced again however long ago it left the window. */
  resurface?: boolean;
  /* Directories outside the project that carry their own .canon beside their
     assets, addressed by basename: mounts: ["/data/lake"] serves lake:prices.
     Workspaces that mount the same directory share its knowledge. */
  mounts?: string[];
  /* How articles that govern no asset are ranked against what the agent is doing, the
     one category the address spine can never reach. "none" is the default and is the
     1.0 behavior exactly: nothing is ranked and nothing unaddressed ever surfaces.
     "lexical" is BM25 over the standard library. Anything needing a model is supplied
     here as { name, score, index? }, so this package never depends on one. */
  retrieval?: RetrievalOption;
  /* How far the best-ranked article must stand out from the rest of what this same
     query touched before it may ride a message. A multiple, not a score: 2 means the
     best must score twice the best article that will not ride, the one just past the
     per-turn cap. Default 1.4, the operating point a 120-cell study priced: it kept
     every fact the uncut channel delivered at a ninth of the suggestion volume. 1 is
     no cutoff and is the 1.0 behavior exactly.

     Relative rather than absolute because an absolute cutoff is not the same quantity
     twice. A lexical score is a fraction of the query's whole idf mass, so it falls as
     the agent says more, and the same article, equally relevant, scored 0.68 against a
     short question and 0.16 with a hundred words of tool output around it. Across
     corpora it is worse than unstable, it inverts: the cutoff that silenced one study's
     residue was six times the one that would have cut the other study's answers.
     Dividing by another score from the same query cancels both, which is why this ports
     and a number never did.

     Raising it trades recall for precision, and precision is the side that matters: an
     unsolicited line that is usually noise teaches the agent to skip the next one, and
     that costs more than the tokens do. Ignored when retrieval is "none". */
  standout?: number;
}

export function registerPiCanon(pi: any, options: CanonOptions = {}): void {
  const known = new Set(["root", "surface", "mounts", "resurface", "retrieval", "standout"]);
  const unknown = Object.keys(options).find((key) => !known.has(key));
  if (unknown) {
    throw new Error(
      `pi-canon: unknown option "${unknown}". The options are root, surface, mounts, resurface, retrieval, and standout; everything else is a constant on purpose.`,
    );
  }
  const surface = options.surface !== false;
  const resurface = options.resurface !== false;
  /* Built here rather than at first use, so a bad retrieval option throws at
     registration beside the unknown-option check instead of mid-session. */
  const retriever = buildRetriever(options.retrieval);
  /* Validated here for the same reason, and strictly: a cutoff silently coerced from a
     string or waved through as NaN would compare false against every score and turn
     retrieval off without saying so, which is the one failure a tuning knob must not
     have. Below 1 is refused rather than clamped, because it asks for the best article
     to be WORSE than the crowd before it may ride, which nobody means. A caller who
     wrote 0.4 was thinking of a score and wants to be told, not handed silence. Omitted
     entirely, the Surfacer's own default applies, so the shipped value lives in exactly
     one place. */
  const standout = options.standout;
  if (standout !== undefined
    && (typeof standout !== "number" || !Number.isFinite(standout) || standout < 1)) {
    throw new Error(
      `pi-canon: standout must be a number of at least 1, a multiple of what the rest of the query scored rather than a score; got ${
        typeof standout === "number" ? standout : typeof standout
      }.`,
    );
  }

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
      runtime = {
        store,
        surfacer: new Surfacer(mounts, retriever, resurface, standout),
        cwd,
        mounts,
        retrieval: retriever.name,
      };
    }
    return runtime;
  };

  pi.registerTool(buildCanonTool(ready, retriever.name));

  /* session_start only resets per-session state. Through 0.2.0 it also delivered an
     orientation line; a 2x2 with an inert implementation priced that line at more
     first-pass correctness than the whole tool schema, and the study that removed it
     found nothing the benefit side could see. The doctrine rides the tool
     description, which every session carries anyway. */
  pi.on("session_start", (_event: unknown, ctx: any) => {
    runtime = undefined;
    ready(ctx);
  });

  /* The window the provider is about to receive, which is the only definition of what
     the agent can see: folded and compacted material is already gone from it, so
     nothing here has to know how it left or who took it. Read only; pi-canon never
     modifies the projection. */
  pi.on("context", (event: any, ctx: any) => {
    if (!surface) return;
    ready(ctx).surfacer.observe(event?.messages);
  });

  /* Touches stage; turns flush. One steered message per turn rides the provider
     round trip that was happening anyway. */
  pi.on("tool_call", (event: any, ctx: any) => {
    if (!surface || event?.toolName === "pi_canon") return;
    const { surfacer } = ready(ctx);
    surfacer.collect(surfacer.pathsIn(event?.input));
    surfacer.noteIntent(event?.toolName, event?.input);
  });

  pi.on("turn_end", (_event: unknown, ctx: any) => {
    if (!surface) return;
    const { surfacer } = ready(ctx);
    surfacer.retrieve();
    const text = surfacer.flush();
    if (text && !deliver(pi, text, "steer")) surfacer.undoFlush();
  });

  pi.on("agent_settled", (_event: unknown, ctx: any) => {
    if (!surface) return;
    const { surfacer } = ready(ctx);
    const text = [surfacer.flush(), surfacer.settleNudge()].filter(Boolean).join("\n");
    if (text && !deliver(pi, text, "nextTurn")) surfacer.undoFlush();
  });

  pi.registerCommand("pi-canon", {
    description: "pi-canon status: articles, journal entries, surfacing this session",
    handler: async (_args: string, ctx: any) => {
      const { store, surfacer, mounts } = ready(ctx);
      const { surfaced, present, chars } = surfacer.stats;
      const mounted = mounts.length > 1 ? `, ${mounts.length - 1} mounted` : "";
      ctx.ui.notify(
        `pi-canon at ${store.root}${mounted}: ${store.list().length} articles, ${store.journalCount()} journal ` +
          `entries; ${surfaced} surfaced this session, ${present} still in context taking ${chars} chars.`,
        "info",
      );
    },
  });
}

/* Same env-gated sink as surfacing.ts; inert without PI_CANON_TRACE. */
function trace(kind: string, data: Record<string, unknown>): void {
  const file = process.env.PI_CANON_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n");
  } catch {
    /* tracing must never break a turn */
  }
}

/* Reports whether the message actually went, so a caller can decide whether to keep the
   state that assumed it did. A lost nudge must never break the turn, but swallowing the
   failure silently made a delivery fault indistinguishable from an agent that read the
   nudge and ignored it (Codex, 2026-08-13), which is the difference between a bug and a
   behaviour. */
function deliver(pi: any, content: string, deliverAs: "steer" | "nextTurn"): boolean {
  try {
    pi.sendMessage({ customType: "pi-canon", content, display: false }, { deliverAs });
    return true;
  } catch (error) {
    trace("delivery-failed", { deliverAs, error: String(error) });
    return false;
  }
}
