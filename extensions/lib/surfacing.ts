/* Surfacing: tool calls stage the articles governing what they touch; the staged
   lines flush as ONE message per turn, once per article per session, under a hard
   budget. Capsules first; when the budget is spent, pointers only. One message per
   turn matters: pi's steering queue drains one message per provider round trip, so
   a message per tool call would buy each nudge its own extra LLM call. */

import { appendFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { CanonStore } from "./store.ts";

export const SESSION_BUDGET_CHARS = 4000;
const MESSAGE_CHARS = 2000;

/* Observability, env-gated and inert otherwise: PI_CANON_TRACE=<file> appends one
   JSON line per surfacing decision, so a harness can audit the staged -> flushed ->
   seen funnel instead of guessing at it. */
function trace(kind: string, data: Record<string, unknown>): void {
  const file = process.env.PI_CANON_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + "\n");
  } catch {
    /* tracing must never break surfacing */
  }
}

const PATHLIKE = /(?:^|[\s"'`=:,([{])(\/?[\w.@-]+(?:\/[\w.@-]+)+)/g;

/* A store and the directory whose assets it governs. The project is the first,
   unnamed mount; named mounts are outside directories (a data lake, a shared
   corpus) whose articles address as name:path. */
export interface Mount {
  name: string;
  dir: string;
  store: CanonStore;
}

export class Surfacer {
  private mounts: Mount[];
  private seen = new Set<string>();
  private pendingUpdates = new Set<string>();
  private staged = new Map<string, { capsule: string; stamp: string; asset: string }>();
  private spent = 0;

  constructor(mounts: Mount[]) {
    this.mounts = mounts;
  }

  private get project(): Mount {
    return this.mounts[0];
  }

  private mountFor(asset: string): Mount {
    const path = asset.replace(/\\/g, "/");
    const absolute = isAbsolute(path) ? path : join(this.project.dir, path);
    for (const mount of this.mounts.slice(1)) {
      if (absolute === mount.dir || absolute.startsWith(`${mount.dir}/`)) return mount;
    }
    return this.project;
  }

  markSeen(path: string): void {
    if (this.staged.has(path)) trace("withdrawn", { path });
    this.seen.add(path);
    this.staged.delete(path);
  }

  markUpdated(path: string): void {
    this.markSeen(path);
    this.pendingUpdates.delete(path);
  }

  get stats(): { surfaced: number; spent: number } {
    return { surfaced: this.seen.size, spent: this.spent };
  }

  /* Candidate asset paths in a tool call: string values that are paths, and path
     shaped tokens inside them. A candidate needs to exist, or to have an existing
     parent, so a file about to be created still surfaces its governing article. */
  pathsIn(input: unknown): string[] {
    const found = new Set<string>();
    const consider = (candidate: string) => {
      const path = candidate.replace(/\\/g, "/");
      const absolute = isAbsolute(path) ? path : join(this.project.dir, path);
      if (existsSync(absolute) || (path.includes("/") && existsSync(dirname(absolute)))) found.add(path);
    };
    const walk = (value: unknown): void => {
      if (typeof value === "string") {
        const whole = value.trim();
        if (whole && whole.length < 512 && !whole.includes("\n")) consider(whole);
        for (const match of value.matchAll(PATHLIKE)) consider(match[1]);
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        Object.values(value).forEach(walk);
      }
    };
    walk(input);
    return [...found];
  }

  /* Stage each newly touched governing article. Nothing is sent or spent here. */
  collect(assets: string[]): void {
    for (const asset of assets) {
      const mount = this.mountFor(asset);
      const article = mount.store.resolve(asset, mount.dir);
      if (!article) continue;
      const key = mount.name ? `${mount.name}:${article.path}` : article.path;
      this.pendingUpdates.add(key);
      if (this.seen.has(key) || this.staged.has(key)) continue;
      const stamp = article.updated ? ` (updated ${article.updated})` : "";
      this.staged.set(key, { capsule: article.capsule, stamp, asset });
      trace("staged", { path: key, asset });
    }
  }

  /* Everything staged since the last flush, as one bounded message. The budget is
     charged here, not at staging, so a nudge withdrawn by markSeen costs nothing;
     articles count as seen only once their line is part of a flushed message.
     Overflow stays staged for the next turn. */
  flush(): string | undefined {
    if (!this.staged.size) return undefined;
    const lines: string[] = [];
    let size = 0;
    for (const [path, entry] of this.staged) {
      const useCapsule = entry.capsule && this.spent + entry.capsule.length <= SESSION_BUDGET_CHARS;
      const line = useCapsule
        ? `${path}${entry.stamp}: ${entry.capsule}`
        : `${path}${entry.stamp}: article exists. Read it before relying on ${entry.asset}.`;
      if (lines.length && size + line.length > MESSAGE_CHARS) {
        lines.push(`${this.staged.size} more staged; they surface next turn.`);
        break;
      }
      if (useCapsule) this.spent += entry.capsule.length;
      size += line.length;
      lines.push(line);
      this.seen.add(path);
      this.staged.delete(path);
    }
    const plural = lines.length > 1 ? "s" : "";
    trace("flushed", { lines: lines.length, spent: this.spent });
    return (
      `[pi-canon] Governing article${plural} for what this turn touches. Read the full article with ` +
      `pi_canon before depending on details; update it after real changes.\n${lines.join("\n")}`
    );
  }

  /* The write-after half of the doctrine: every governing article touched since its
     last update draws one reminder, then the slate clears for the next batch. */
  settleNudge(): string | undefined {
    const stale = [...this.pendingUpdates];
    this.pendingUpdates.clear();
    if (!stale.length) return undefined;
    trace("settle-nudge", { paths: stale });
    return (
      `[pi-canon] Touched but not updated: ${stale.join(", ")}. If this work changed what is true, ` +
      `update the article with pi_canon; if nothing durable changed, leave it.`
    );
  }
}
