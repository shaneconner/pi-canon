/* Surfacing: the moment a tool call touches an asset, the governing article speaks,
   once per article per session, under a hard budget. Capsules first; when the budget
   is spent, pointers only. */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { CanonStore } from "./store.ts";

export const SESSION_BUDGET_CHARS = 4000;

const PATHLIKE = /(?:^|[\s"'`=:,([{])(\/?(?:\.{1,2}\/)?[\w.@-]+(?:\/[\w.@-]+)+)/g;

export class Surfacer {
  private seen = new Set<string>();
  private updatedPaths = new Set<string>();
  private touched = new Set<string>();
  private spent = 0;

  constructor(
    private store: CanonStore,
    private cwd: string,
  ) {}

  markSeen(path: string): void {
    this.seen.add(path);
  }

  markUpdated(path: string): void {
    this.seen.add(path);
    this.updatedPaths.add(path);
  }

  /* Candidate asset paths in a tool call: path shaped tokens that exist on disk. */
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

  /* One line per newly touched governing article; undefined when there is nothing new. */
  nudge(assets: string[]): string | undefined {
    const lines: string[] = [];
    for (const asset of assets) {
      const article = this.store.resolve(asset, this.cwd);
      if (!article) continue;
      this.touched.add(article.path);
      if (this.seen.has(article.path)) continue;
      this.seen.add(article.path);
      const stamp = article.updated ? ` (updated ${article.updated})` : "";
      if (article.capsule && this.spent + article.capsule.length <= SESSION_BUDGET_CHARS) {
        this.spent += article.capsule.length;
        lines.push(`${article.path}${stamp}: ${article.capsule}`);
      } else {
        lines.push(`${article.path}${stamp}: article exists. Read it before relying on ${asset}.`);
      }
    }
    if (!lines.length) return undefined;
    const plural = lines.length > 1 ? "s" : "";
    return (
      `[pi-canon] Governing article${plural} for what this call touches. Read the full article with ` +
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
