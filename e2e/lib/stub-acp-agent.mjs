#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.E2E_STUB_LOG;
const record = (entry) => {
  if (log !== undefined)
    appendFileSync(log, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
};

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const sessions = new Map();
const asked = new Map();
let nextAsk = 1;

// An approval card on the thread, the way a real agent asks before a command:
// the turn stays open until the owner decides.
function askPermission(sessionId, title) {
  const id = `stub-ask-${nextAsk++}`;
  const answer = new Promise((resolve) => asked.set(id, resolve));
  send({
    id,
    method: "session/request_permission",
    params: {
      sessionId,
      toolCall: {
        toolCallId: `stub-call-${id}`,
        title,
        kind: "execute",
        status: "pending",
        rawInput: { command: title },
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    },
  });
  return answer;
}
let nextSession = 1;

function startMcp(server) {
  const env = { ...process.env };
  for (const entry of server.env ?? []) env[entry.name] = entry.value;
  const child = spawn(server.command, server.args ?? [], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  });
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  const ready = request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "e2e-stub", version: "1" },
  }).then(() =>
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
    ),
  );
  return {
    async call(name, args) {
      await ready;
      return request("tools/call", { name, arguments: args });
    },
    async list() {
      await ready;
      return request("tools/list", {});
    },
    close: () => child.kill(),
  };
}

function say(sessionId, text) {
  send({
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function handlePrompt(message) {
  const { sessionId, prompt } = message.params;
  const text = (prompt ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  record({ kind: "prompt", sessionId, text });
  const session = sessions.get(sessionId);
  const call = /\[stub:call (\S+) (\{.*\})\]/s.exec(text);
  const reply = /\[stub:reply ([^\]]*)\]/s.exec(text);
  const wait = /\[stub:wait (\d+)\]/.exec(text);
  const fail = /\[stub:fail ([^\]]*)\]/.exec(text);
  const ask = /\[stub:ask ([^\]]*)\]/.exec(text);
  if (wait !== null) await sleep(Number(wait[1]) * 1000);
  if (fail !== null) {
    send({ id: message.id, error: { code: -32603, message: fail[1] } });
    return;
  }
  if (ask !== null) {
    const outcome = await askPermission(sessionId, ask[1]);
    record({ kind: "asked", title: ask[1], outcome });
    say(sessionId, `asked ${ask[1]}: ${outcome?.outcome ?? "none"}`);
  } else if (call !== null) {
    if (session?.mcp === undefined) {
      say(sessionId, "no tools");
    } else {
      try {
        const result = await session.mcp.call(call[1], JSON.parse(call[2]));
        const output = (result?.content ?? []).map((part) => part.text ?? "").join("\n");
        record({ kind: "tool", name: call[1], isError: result?.isError === true, output });
        say(sessionId, `tool ${call[1]}: ${output}`);
      } catch (error) {
        record({ kind: "tool", name: call[1], error: error.message });
        say(sessionId, `tool ${call[1]} failed: ${error.message}`);
      }
    }
  } else {
    say(sessionId, reply !== null ? reply[1] : "ok");
  }
  send({ id: message.id, result: { stopReason: "end_turn" } });
}

async function handle(message) {
  switch (message.method) {
    case "initialize":
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: false, promptCapabilities: { image: false } },
        },
      });
      return;
    case "session/new": {
      const sessionId = `stub-session-${process.pid}-${nextSession++}`;
      const servers = message.params?.mcpServers ?? [];
      const mcp = servers.length > 0 ? startMcp(servers[0]) : undefined;
      sessions.set(sessionId, { mcp });
      record({ kind: "session", sessionId, mcpServers: servers.map((server) => server.name) });
      if (mcp !== undefined) {
        mcp.list().then(
          (result) =>
            record({
              kind: "tools",
              sessionId,
              tools: (result?.tools ?? []).map((tool) => tool.name),
            }),
          (error) => record({ kind: "tools", sessionId, error: error.message }),
        );
      }
      send({ id: message.id, result: { sessionId } });
      return;
    }
    case "session/prompt":
      await handlePrompt(message);
      return;
    case "session/set_model":
    case "session/set_mode":
    case "session/set_config_option":
      send({ id: message.id, result: {} });
      return;
    case "session/cancel":
      return;
    default:
      if (message.id !== undefined)
        send({
          id: message.id,
          error: { code: -32601, message: `Unknown method ${message.method}` },
        });
  }
}

createInterface({ input: process.stdin, terminal: false }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === undefined) {
    asked.get(message.id)?.(message.result?.outcome);
    asked.delete(message.id);
    return;
  }
  void handle(message);
});
process.stdin.on("close", () => {
  for (const session of sessions.values()) session.mcp?.close();
  process.exit(0);
});
