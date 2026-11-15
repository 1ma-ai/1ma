import { existsSync, readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { Fleet, STUB_MODEL, STUB_PROVIDER, requireEnv, waitFor } from "../lib/servers.mjs";

export const BOTS = "1ma-bots";
export const SIDEBAR = "1ma-sidebar";
const scratch = requireEnv("E2E_ROOT");
const root = path.join(scratch, "bots");
export const screenshotDir = path.join(root, "screenshots");
export const stubLog = path.join(root, "stub.log");
export const pluginDirs = {
  bots: path.resolve(import.meta.dirname, "../../plugins/1ma-bots"),
  sidebar: path.resolve(import.meta.dirname, "../../plugins/1ma-sidebar"),
};

export const fleet = new Fleet({ root, packageDir: path.join(scratch, "server-package") });
export const server = fleet.add("bots");
export const projects = {};

export function stubRecords() {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

export const rpc = (method, input) => server.rpc(BOTS, method, input);

export async function setUp() {
  await fleet.startAll();
  server.installPlugin(pluginDirs.bots);
  server.installPlugin(pluginDirs.sidebar);
  server.registerStubAgent(stubLog);
  projects.alpha = await server.createProject("Alpha", path.join(root, "repos/alpha"));
  projects.beta = await server.createProject("Beta", path.join(root, "repos/beta"));
}

export async function createBot(name, fields = {}) {
  const { revision: _revision, ...bot } = await rpc("bots.v1.create", { name, ...fields });
  return bot;
}

export async function startConversation(bot, text, projectId = projects.alpha, more = {}) {
  const { threadId } = await rpc("bots.v1.startThread", {
    botId: bot.id,
    request: {
      projectId,
      providerId: STUB_PROVIDER,
      model: STUB_MODEL,
      environment: { type: "project-default" },
      ...more,
      input: [{ type: "text", text, mentions: [] }],
    },
  });
  return threadId;
}

export function regularThread(projectId, title, prompt = "[stub:reply plain]") {
  return server.bbJson([
    "thread",
    "spawn",
    "--project",
    projectId,
    "--provider",
    STUB_PROVIDER,
    "--model",
    STUB_MODEL,
    "--prompt",
    prompt,
    "--title",
    title,
  ]).id;
}

export const rename = (threadId, title) => server.api("PATCH", `/threads/${threadId}`, { title });
export const thread = (threadId) => server.api("GET", `/threads/${threadId}`);

export async function turnsDone(threadId) {
  const events = await server.api(
    "GET",
    `/threads/${threadId}/events?types=turn/completed&limit=100`,
  );
  return events.length;
}

export const waitTurns = (threadId, count, timeoutMs = 120_000) =>
  waitFor(
    `${count} finished turn(s) in ${threadId}`,
    timeoutMs,
    async () => (await turnsDone(threadId)) >= count,
  );

export const waitStatus = (threadId, status, timeoutMs = 60_000) =>
  waitFor(
    `thread ${threadId} to be ${status}`,
    timeoutMs,
    async () => (await thread(threadId)).status === status,
  );

export function say(threadId, text) {
  return server.api("POST", `/threads/${threadId}/send`, {
    mode: "auto",
    input: [{ type: "text", text, mentions: [] }],
  });
}

export async function completedOf(botId, threadId) {
  const { bots } = await rpc("bots.v1.list", {});
  const row = bots.find((bot) => bot.id === botId)?.threads.find((t) => t.threadId === threadId);
  if (row === undefined) throw new Error(`${threadId} is not listed under bot ${botId}`);
  return row.completed;
}

export function stubCall(tool, args) {
  return `[stub:call ${tool} ${JSON.stringify(args)}]`;
}

// What a failed wait needs to be read from the log alone.
export function diagnose(extra = {}) {
  return JSON.stringify(
    {
      ...extra,
      stub: stubRecords()
        .slice(-12)
        .map((entry) => ({ ...entry, text: entry.text?.slice(-400) })),
    },
    null,
    1,
  );
}

function pluginDatabase() {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return /\.(db|sqlite3?)$/.test(entry.name) ? [full] : [];
    });
  for (const file of walk(server.dataDir)) {
    const db = new DatabaseSync(file, { readOnly: true });
    const found = db.prepare("SELECT name FROM sqlite_master WHERE name = 'thread_chains'").get();
    if (found !== undefined) return db;
    db.close();
  }
  throw new Error(`no 1ma-bots database under ${server.dataDir}`);
}

// The exchange a conversation belongs to and the letters waiting for it, read
// from the plugin's own tables: the contract does not expose them.
export function exchangeOf(threadId) {
  const db = pluginDatabase();
  try {
    const chain = db
      .prepare(
        `SELECT chains.id AS id, chains.letters AS letters FROM thread_chains
         JOIN chains ON chains.id = thread_chains.chain_id WHERE thread_chains.thread_id = ?`,
      )
      .get(threadId);
    const waiting = db
      .prepare("SELECT COUNT(*) AS n FROM pending_letters WHERE to_thread = ?")
      .get(threadId);
    return { chain: chain ?? null, waiting: waiting.n };
  } finally {
    db.close();
  }
}
