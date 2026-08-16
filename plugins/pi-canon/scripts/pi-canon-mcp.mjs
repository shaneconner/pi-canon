#!/usr/bin/env node

/* Dependency-free stdio MCP adapter over the exact core Pi uses. */

import {
  CANON_TOOL_PARAMETERS,
  canonToolDescription,
  runCanon,
} from "../core/tool.ts";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { callerFromEnv, createRuntime, sessionFromEnv } from "./runtime.mjs";

const SUPPORTED_PROTOCOLS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const SANDBOX_STATE_META = "codex/sandbox-state-meta";
const runtimes = new Map();

function cwdFromCall(params) {
  const value = params?._meta?.[SANDBOX_STATE_META]?.sandboxCwd;
  if (typeof value !== "string") return process.cwd();
  try {
    const cwd = value.startsWith("file:") ? fileURLToPath(value) : value;
    return isAbsolute(cwd) ? cwd : process.cwd();
  } catch {
    return process.cwd();
  }
}

function runtimeFromCall(params) {
  const cwd = cwdFromCall(params);
  const caller = callerFromEnv();
  const sessionId = params?._meta?.threadId
    || params?._meta?.sessionId
    || sessionFromEnv();
  const key = `${cwd}\0${caller}\0${sessionId ?? ""}`;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createRuntime(cwd, { harness: caller, sessionId });
    runtimes.set(key, runtime);
  }
  return runtime;
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (message?.id !== undefined) failure(message.id, -32600, "Invalid Request");
    return;
  }

  const id = message.id;
  if (message.method.startsWith("notifications/")) return;

  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : "2025-11-25";
      result(id, {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          experimental: { [SANDBOX_STATE_META]: {} },
        },
        serverInfo: { name: `pi-canon-${callerFromEnv()}`, version: "0.2.4" },
        instructions: canonToolDescription("none"),
      });
      return;
    }
    case "ping":
      result(id, {});
      return;
    case "tools/list":
      result(id, {
        tools: [{
          name: "pi_canon",
          title: "pi-canon",
          description: canonToolDescription("none"),
          inputSchema: CANON_TOOL_PARAMETERS,
        }],
      });
      return;
    case "tools/call": {
      if (message.params?.name !== "pi_canon") {
        failure(id, -32602, `Unknown tool ${JSON.stringify(message.params?.name)}.`);
        return;
      }
      try {
        const runtime = runtimeFromCall(message.params);
        const text = runCanon(runtime, message.params?.arguments ?? {});
        result(id, { content: [{ type: "text", text }], isError: false });
      } catch (error) {
        result(id, {
          content: [{ type: "text", text: `pi-canon failed: ${String(error)}` }],
          isError: true,
        });
      }
      return;
    }
    default:
      failure(id, -32601, `Method not found: ${message.method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of messages) void handle(message);
    } catch (error) {
      failure(null, -32700, `Parse error: ${String(error)}`);
    }
  }
});
