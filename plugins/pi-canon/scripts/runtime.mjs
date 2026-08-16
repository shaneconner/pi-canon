import { existsSync } from "node:fs";
import { join } from "node:path";
import { CanonStore, contained } from "../core/store.ts";
import { Surfacer } from "../core/surfacing.ts";

export function callerFromEnv() {
  return process.env.PI_CANON_CALLER
    || (process.env.CODEX_THREAD_ID ? "codex" : "")
    || (process.env.CLAUDE_CODE_SESSION_ID ? "claude-code" : "")
    || "mcp";
}

export function sessionFromEnv() {
  return process.env.PI_CANON_SESSION_ID
    || process.env.CODEX_THREAD_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || undefined;
}

export function createRuntime(cwd = process.cwd(), provenance) {
  const store = new CanonStore(join(cwd, ".canon"));
  const mounts = [{ name: "", dir: cwd, store }];
  return {
    cwd,
    store,
    mounts,
    surfacer: new Surfacer(mounts),
    retrieval: "none",
    provenance: provenance ?? { harness: callerFromEnv(), sessionId: sessionFromEnv() },
  };
}

export function hasCanon(cwd) {
  return existsSync(join(cwd, ".canon", "articles"));
}

/* An explicit article address wins unless an asset with that spelling exists. */
export function articleFor(store, cwd, raw) {
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const exact = contained(raw, cwd);
  if (exact && !existsSync(join(cwd, exact))) {
    const article = store.read(exact);
    if (article) return article;
  }
  return store.resolve(raw, cwd);
}
