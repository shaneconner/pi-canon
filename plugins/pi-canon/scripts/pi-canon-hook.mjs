#!/usr/bin/env node

/* Shared Codex and Claude Code hook. It is inert until a project has .canon/articles. */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CanonStore } from "../core/store.ts";
import { changesAssets, Surfacer } from "../core/surfacing.ts";
import { articleFor, callerFromEnv, hasCanon } from "./runtime.mjs";

const pause = new Int32Array(new SharedArrayBuffer(4));

async function inputJson() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.trim() ? JSON.parse(text) : {};
}

function sessionId(input) {
  return String(
    input.session_id
    || process.env.PI_CANON_SESSION_ID
    || process.env.CODEX_THREAD_ID
    || process.env.CLAUDE_CODE_SESSION_ID
    || "ambient",
  );
}

function statePath(input, cwd) {
  const base = process.env.PLUGIN_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || join(homedir(), ".cache", "pi-canon");
  const key = createHash("sha256")
    .update(`${callerFromEnv()}\0${sessionId(input)}\0${cwd}`)
    .digest("hex");
  return join(base, "sessions", `${key}.json`);
}

function emptyState() {
  return { version: 2, seen: [], pending: [] };
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state?.version === 2 && Array.isArray(state.seen) && Array.isArray(state.pending)
      && state.pending.every((entry) => entry && typeof entry.path === "string"
        && (entry.fingerprint === null || typeof entry.fingerprint === "string"))) {
      return state;
    }
    /* Version 1 carried only paths. Preserve a pending obligation conservatively when an
       already-open session first reaches the new hook; no baseline exists to prove that a
       hidden write satisfied it. */
    if (state?.version === 1 && Array.isArray(state.seen) && Array.isArray(state.pending)
      && state.pending.every((path) => typeof path === "string")) {
      return {
        version: 2,
        seen: state.seen,
        pending: state.pending.map((path) => ({ path, fingerprint: null })),
      };
    }
  } catch {
    /* A missing or partial state file starts clean. */
  }
  return emptyState();
}

function articleFingerprint(article) {
  return createHash("sha256").update(JSON.stringify({
    path: article.path,
    capsule: article.capsule,
    updated: article.updated,
    scope: article.scope,
    extra: article.extra,
    body: article.body,
  })).digest("hex");
}

function lock(file) {
  const lockDir = `${file}.lock`;
  mkdirSync(join(file, ".."), { recursive: true });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lockDir);
      return () => {
        try { rmdirSync(lockDir); } catch { /* another cleanup already won */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 10_000) rmdirSync(lockDir);
      } catch {
        /* The owner may have released it between stat and cleanup. */
      }
      Atomics.wait(pause, 0, 0, 20);
    }
  }
  throw new Error("pi-canon hook state stayed locked for two seconds");
}

function mutateState(file, mutate) {
  const release = lock(file);
  try {
    const state = readState(file);
    const output = mutate(state);
    const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(state)}\n`);
    renameSync(temp, file);
    return output;
  } finally {
    release();
  }
}

function ownTool(name) {
  const value = String(name ?? "");
  return value === "pi_canon" || (value.includes("pi-canon") && value.endsWith("pi_canon"));
}

function toolCalls(input, event) {
  if (event === "PostToolBatch") {
    return Array.isArray(input.tool_calls) ? input.tool_calls : [];
  }
  return [{ tool_name: input.tool_name, tool_input: input.tool_input }];
}

function afterTools(input, event, cwd, file) {
  const store = new CanonStore(join(cwd, ".canon"));
  const calls = toolCalls(input, event);
  return mutateState(file, (state) => {
    const seen = new Set(state.seen);
    const pending = new Map(state.pending.map((entry) => [entry.path, entry.fingerprint]));
    const surfacer = new Surfacer([{ name: "", dir: cwd, store }]);
    const staged = [];

    /* A full article read anywhere in a parallel batch makes its capsule redundant.
       Process pi_canon calls first, then collect the assets touched by every other call. */
    for (const call of calls.filter((candidate) => ownTool(candidate?.tool_name))) {
      const toolInput = call?.tool_input ?? {};
      const article = articleFor(store, cwd, toolInput.path);
      if (article && (toolInput.action === "read" || toolInput.action === "write")) seen.add(article.path);
      if (article && toolInput.action === "write") pending.delete(article.path);
    }

    for (const call of calls.filter((candidate) => !ownTool(candidate?.tool_name))) {
      const changed = changesAssets(call?.tool_name, call?.tool_input);
      for (const asset of surfacer.pathsIn(call?.tool_input ?? {})) {
        const article = store.resolve(asset, cwd);
        if (!article) continue;
        /* Always take the article's current fingerprint for a new modifying call. If an
           unobservable nested pi_canon write satisfied an earlier obligation, a later edit
           must start a new obligation from the updated article rather than inheriting the
           old baseline. */
        if (changed) pending.set(article.path, articleFingerprint(article));
        if (seen.has(article.path)) continue;
        seen.add(article.path);
        const stamp = article.updated ? ` (updated ${article.updated})` : "";
        staged.push(article.capsule
          ? `${article.path}${stamp}: ${article.capsule}`
          : `${article.path}${stamp}: article exists. Read it before relying on ${asset}.`);
      }
    }
    state.seen = [...seen];
    state.pending = [...pending].map(([path, fingerprint]) => ({ path, fingerprint }));
    if (!staged.length) return undefined;
    const plural = staged.length > 1 ? "s" : "";
    const source = event === "PostToolBatch" ? "this tool batch" : "this tool";
    return (
      `[pi-canon] Governing article${plural} for what ${source} touched. Read the full article with `
      + `pi_canon before depending on details; update it after real changes.\n${staged.join("\n")}`
    );
  });
}

function sessionStart(input, file) {
  const source = String(input.source ?? "startup");
  mutateState(file, (state) => {
    /* A thread may compact more than once. Each compact begins a new visibility cycle:
       prior touches have no effect, while resume stays in the same cycle. */
    if (source === "compact") {
      state.seen = [];
      state.pending = [];
    } else if (source !== "resume") {
      state.seen = [];
      state.pending = [];
    }
  });
}

function stop(file, cwd) {
  const store = new CanonStore(join(cwd, ".canon"));
  return mutateState(file, (state) => {
    const pending = new Map(state.pending.map((entry) => [entry.path, entry.fingerprint]));
    state.pending = [];
    const stale = [...pending].flatMap(([path, fingerprint]) => {
      const article = store.read(path);
      return fingerprint !== null && article
        && articleFingerprint(article) !== fingerprint ? [] : [path];
    });
    if (!stale.length) return undefined;
    return (
      `[pi-canon] Touched but not updated: ${stale.join(", ")}. If this work changed what is true, `
      + "update the article with pi_canon; if nothing durable changed, leave it."
    );
  });
}

try {
  const input = await inputJson();
  const event = String(input.hook_event_name ?? "");
  const cwd = String(input.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd());
  if (!hasCanon(cwd)) {
    process.stdout.write("{}\n");
  } else {
    const file = statePath(input, cwd);
    if (event === "SessionStart") {
      sessionStart(input, file);
      process.stdout.write("{}\n");
    } else if (event === "PostToolUse" || event === "PostToolBatch") {
      const context = afterTools(input, event, cwd, file);
      process.stdout.write(`${JSON.stringify(context ? {
        hookSpecificOutput: { hookEventName: event, additionalContext: context },
      } : {})}\n`);
    } else if (event === "Stop" && !input.stop_hook_active) {
      const reason = existsSync(file) ? stop(file, cwd) : undefined;
      process.stdout.write(`${JSON.stringify(reason ? { decision: "block", reason } : {})}\n`);
    } else {
      process.stdout.write("{}\n");
    }
  }
} catch (error) {
  process.stderr.write(`[pi-canon hook] ${String(error)}\n`);
  process.stdout.write("{}\n");
}
