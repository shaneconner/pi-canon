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
import { Surfacer } from "../core/surfacing.ts";
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
  return { version: 1, seen: [], pending: [] };
}

function readState(file) {
  try {
    const state = JSON.parse(readFileSync(file, "utf8"));
    if (state?.version === 1 && Array.isArray(state.seen) && Array.isArray(state.pending)) return state;
  } catch {
    /* A missing or partial state file starts clean. */
  }
  return emptyState();
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

function postToolUse(input, cwd, file) {
  const store = new CanonStore(join(cwd, ".canon"));
  const toolName = input.tool_name;
  const toolInput = input.tool_input ?? {};
  return mutateState(file, (state) => {
    const seen = new Set(state.seen);
    const pending = new Set(state.pending);

    if (ownTool(toolName)) {
      const article = articleFor(store, cwd, toolInput.path);
      if (article && (toolInput.action === "read" || toolInput.action === "write")) seen.add(article.path);
      if (article && toolInput.action === "write") pending.delete(article.path);
      state.seen = [...seen];
      state.pending = [...pending];
      return undefined;
    }

    const surfacer = new Surfacer([{ name: "", dir: cwd, store }]);
    const staged = [];
    for (const asset of surfacer.pathsIn(toolInput)) {
      const article = store.resolve(asset, cwd);
      if (!article) continue;
      pending.add(article.path);
      if (seen.has(article.path)) continue;
      seen.add(article.path);
      const stamp = article.updated ? ` (updated ${article.updated})` : "";
      staged.push(article.capsule
        ? `${article.path}${stamp}: ${article.capsule}`
        : `${article.path}${stamp}: article exists. Read it before relying on ${asset}.`);
    }
    state.seen = [...seen];
    state.pending = [...pending];
    if (!staged.length) return undefined;
    const plural = staged.length > 1 ? "s" : "";
    return (
      `[pi-canon] Governing article${plural} for what this tool touched. Read the full article with `
      + `pi_canon before depending on details; update it after real changes.\n${staged.join("\n")}`
    );
  });
}

function sessionStart(input, file) {
  const source = String(input.source ?? "startup");
  mutateState(file, (state) => {
    /* A thread may compact more than once. Each compact begins a new visibility cycle,
       so the next touch may surface an article again; resume stays in the same cycle. */
    if (source === "compact") {
      state.seen = [];
    } else if (source !== "resume") {
      state.seen = [];
      state.pending = [];
    }
  });
}

function stop(file) {
  return mutateState(file, (state) => {
    const pending = [...new Set(state.pending)];
    state.pending = [];
    if (!pending.length) return undefined;
    return (
      `[pi-canon] Touched but not updated: ${pending.join(", ")}. If this work changed what is true, `
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
    } else if (event === "PostToolUse") {
      const context = postToolUse(input, cwd, file);
      process.stdout.write(`${JSON.stringify(context ? {
        hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
      } : {})}\n`);
    } else if (event === "Stop" && !input.stop_hook_active) {
      const reason = existsSync(file) ? stop(file) : undefined;
      process.stdout.write(`${JSON.stringify(reason ? { decision: "block", reason } : {})}\n`);
    } else {
      process.stdout.write("{}\n");
    }
  }
} catch (error) {
  process.stderr.write(`[pi-canon hook] ${String(error)}\n`);
  process.stdout.write("{}\n");
}
