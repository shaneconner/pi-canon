/* Surfacing: tool calls stage the articles governing what they touch; the staged
   lines flush as ONE message per turn, once per article per session, under a hard
   budget. Capsules first; when the budget is spent, pointers only. One message per
   turn matters: pi's steering queue drains one message per provider round trip, so
   a message per tool call would buy each nudge its own extra LLM call. */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CanonStore } from "./store.ts";

export const SESSION_BUDGET_CHARS = 4000;

const PATHLIKE = /(?:^|\\[nrt]|[\s"'`=:,([{])(\/?[\w.@-]+(?:\/[\w.@-]+)+)/g;

export class Surfacer {
  private store: CanonStore;
  private cwd: string;
  private seen = new Set<string>();
  private updatedPaths = new Set<string>();
  private touched = new Set<string>();
  private staged = new Map<string, { capsule: string; stamp: string; asset: string }>();
  private spent = 0;

  constructor(store: CanonStore, cwd: string) {
    this.store = store;
    this.cwd = cwd;
  }

  markSeen(path: string): void {
    this.seen.add(path);
    this.staged.delete(path);
  }

  markUpdated(path: string): void {
    this.markSeen(path);
    this.updatedPaths.add(path);
  }

  get stats(): { surfaced: number; spent: number } {
    return { surfaced: this.seen.size, spent: this.spent };
  }

  /* Candidate asset paths in a tool call: path shaped tokens that exist on disk.
     The boundary class includes JSON escapes, so a path opening a line inside a
     serialized multi-line command still matches. */
  pathsIn(input: unknown): string[] {
    const text = JSON.stringify(input) ?? "";
    const found = new Set<string>();
    for (const match of text.matchAll(PATHLIKE)) {
      const candidate = match[1];
      const absolute = isAbsolute(candidate) ? candidate : join(this.cwd, candidate);
      if (existsSync(absolute)) found.add(candidate);
    }
    return [...found];
  }

  /* Stage each newly touched governing article. Nothing is sent or spent here. */
  collect(assets: string[]): void {
    for (const asset of assets) {
      const article = this.store.resolve(asset, this.cwd);
      if (!article) continue;
      this.touched.add(article.path);
      if (this.seen.has(article.path) || this.staged.has(article.path)) continue;
      const stamp = article.updated ? ` (updated ${article.updated})` : "";
      this.staged.set(article.path, { capsule: article.capsule, stamp, asset });
    }
  }

  /* Everything staged since the last flush, as one message. The budget is charged
     here, not at staging, so a nudge withdrawn by markSeen costs nothing; articles
     count as seen only once their line is actually part of a flushed message. */
  flush(): string | undefined {
    if (!this.staged.size) return undefined;
    const lines: string[] = [];
    for (const [path, { capsule, stamp, asset }] of this.staged) {
      if (capsule && this.spent + capsule.length <= SESSION_BUDGET_CHARS) {
        this.spent += capsule.length;
        lines.push(`${path}${stamp}: ${capsule}`);
      } else {
        lines.push(`${path}${stamp}: article exists. Read it before relying on ${asset}.`);
      }
      this.seen.add(path);
    }
    this.staged.clear();
    const plural = lines.length > 1 ? "s" : "";
    return (
      `[pi-canon] Governing article${plural} for what this turn touches. Read the full article with ` +
      `pi_canon before depending on details; update it after real changes.\n${lines.join("\n")}`
    );
  }

  /* The write-after half of the doctrine: one reminder per batch of touches. */
  settleNudge(): string | undefined {
    const stale = [...this.touched].filter((path) => !this.updatedPaths.has(path));
    this.touched.clear();
    if (!stale.length) return undefined;
    return (
      `[pi-canon] Touched but not updated: ${stale.join(", ")}. If this work changed what is true, ` +
      `update the article with pi_canon; if nothing durable changed, leave it.`
    );
  }
}
