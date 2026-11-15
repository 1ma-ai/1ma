import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { FaultProxy } from "./proxy.mjs";
import { Server, requireEnv, waitFor } from "./servers.mjs";

const root = path.join(requireEnv("E2E_ROOT"), "bot");
const pluginDir = path.resolve(import.meta.dirname, "../../plugins/1ma-superagent");
const packageDir = path.join(requireEnv("E2E_ROOT"), "server-package");
const stubPath = path.resolve(import.meta.dirname, "stub-acp-agent.mjs");
const fakeGhDir = path.resolve(import.meta.dirname, "fake-gh");
const stubLog = path.join(root, "stub.log");
const ghFixtures = path.join(root, "github.json");
const PLUGIN = "1ma-superagent";
const PROVIDER = "acp-stub";
const MODEL = "acp-default";
const PASS = 200_000;

const control = new Server({
  name: "bot-control",
  port: 39886,
  daemonPort: 39896,
  root,
  packageDir,
  env: {
    PATH: `${fakeGhDir}${path.delimiter}${process.env.PATH ?? ""}`,
    E2E_GH_FIXTURES: ghFixtures,
  },
});
const executor = new Server({
  name: "bot-executor",
  port: 39887,
  daemonPort: 39897,
  root,
  packageDir,
});
const proxy = new FaultProxy(executor.url);

const ids = {};

function stubRecords() {
  if (!existsSync(stubLog)) return [];
  return readFileSync(stubLog, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

async function spawnChat(server, projectId, title, prompt, { pending = false } = {}) {
  const args = [
    "thread",
    "spawn",
    "--project",
    projectId,
    "--provider",
    PROVIDER,
    "--model",
    MODEL,
    "--prompt",
    prompt,
    "--title",
    title,
  ];
  if (pending) args.push("--send-at", "7d");
  return server.bbJson(args).id;
}

async function turnsDone(server, threadId) {
  const events = await server.api(
    "GET",
    `/threads/${threadId}/events?types=turn/completed&limit=100`,
  );
  return events.length;
}

async function sayToBot(text) {
  const turnsBefore = await turnsDone(control, ids.bot);
  await control.api("POST", `/threads/${ids.bot}/send`, {
    mode: "auto",
    input: [{ type: "text", text }],
  });
  await waitFor(
    "bot turn finished",
    120_000,
    async () => (await turnsDone(control, ids.bot)) > turnsBefore,
  );
}

function startCall(prompt, title) {
  return `[stub:call sa_start_chat ${JSON.stringify({
    server: "linux",
    projectId: ids.executorProject,
    providerId: PROVIDER,
    model: MODEL,
    prompt,
    title,
  })}]`;
}

async function pendingCards() {
  const list = await control.api("GET", `/threads/${ids.bot}/interactions`);
  return list.filter((card) => card.status === "pending" && card.origin?.pluginId === PLUGIN);
}

async function respond(card, optionId) {
  return control.api("POST", `/threads/${ids.bot}/interactions/${card.id}/respond`, {
    value: { token: card.payload.data.token, optionId },
  });
}

async function waitCard(label, match, timeout = PASS) {
  return waitFor(label, timeout, async () => {
    const [card] = await pendingCards();
    if (card === undefined) return null;
    if (match(card.payload.data)) return card;
    const options = card.payload.data.options;
    if (options.length === 1 && options[0].id === "ok") await respond(card, "ok");
    return null;
  });
}

async function clearCards() {
  const clear = async (round) => {
    if (round >= 10) return;
    const [card] = await pendingCards();
    if (card === undefined) return;
    const ids = card.payload.data.options.map((option) => option.id);
    const choice = ["no", "ok", "wait"].find((id) => ids.includes(id));
    if (choice === undefined) return;
    await respond(card, choice).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await clear(round + 1);
  };
  await clear(0);
}

async function spawnedOnExecutor() {
  const threads = await executor.api(
    "GET",
    `/threads?originPluginId=${PLUGIN}&includeHidden=true&limit=200`,
  );
  if (threads.length === 0) return [];
  const { threads: rows } = await executor.api("POST", "/threads/plugin-metadata", {
    pluginId: PLUGIN,
    threadIds: threads.map((thread) => thread.id),
  });
  return rows.map((row) => ({ threadId: row.threadId, label: row.metadata.spawn }));
}

async function action(actionId) {
  const { actions } = await control.rpc(PLUGIN, "work.v1.actions", {});
  return actions.find((candidate) => candidate.id === actionId);
}

async function newestAction(knownIds) {
  return waitFor("a new action", 60_000, async () => {
    const { actions } = await control.rpc(PLUGIN, "work.v1.actions", {});
    return actions.find((candidate) => !knownIds.has(candidate.id));
  });
}

async function knownActions() {
  const { actions } = await control.rpc(PLUGIN, "work.v1.actions", {});
  return new Set(actions.map((candidate) => candidate.id));
}

async function proposeAndConfirm(prompt, title, optionId = "start") {
  const known = await knownActions();
  await sayToBot(startCall(prompt, title));
  const created = await newestAction(known);
  const card = await waitCard(
    "start card",
    (data) => data.title === "Запустить чат на linux?" && data.quote === prompt,
  );
  await respond(card, optionId);
  return created.id;
}

describe("1ma-superagent bot actions with a model turn", () => {
  before(async () => {
    mkdirSync(root, { recursive: true });
    writeFileSync(ghFixtures, JSON.stringify({}));
    control.start();
    executor.start();
    await Promise.all([control.waitReady(), executor.waitReady()]);
    await proxy.listen(0);
    const agents = JSON.stringify([
      {
        id: "stub",
        displayName: "Stub",
        command: process.execPath,
        args: [stubPath],
        env: { E2E_STUB_LOG: stubLog },
      },
    ]);
    for (const server of [control, executor]) {
      server.bb(["plugin", "install", pluginDir, "--yes"]);
      server.bb(["plugin", "config", "provider-acp", "set", "customAgents", agents]);
    }
    control.bb(["plugin", "config", PLUGIN, "set", "role", "control"]);
    control.bb(["plugin", "config", PLUGIN, "set", "linuxServerUrl", proxy.url]);
    const home = await control.createProject("bot-home", path.join(root, "repos/bot-home"));
    ids.executorProject = await executor.createProject(
      "exec-app",
      path.join(root, "repos/exec-app"),
    );
    ids.bot = await spawnChat(control, home, "Main bot", "[stub:reply hello]", {
      pending: true,
    });
    control.bb(["plugin", "config", PLUGIN, "set", "mainBotThreadId", ids.bot]);
    const [queued] = await control.api("GET", `/threads/${ids.bot}/queued-messages`);
    await control.api("PATCH", `/threads/${ids.bot}/queued-messages/${queued.id}`, {
      expectedUpdatedAt: queued.updatedAt,
      sendAt: null,
    });
    await waitFor("bot's first turn", 120_000, async () => (await turnsDone(control, ids.bot)) > 0);
  });

  after(async () => {
    const lines = [];
    for (const server of [control, executor]) {
      for (const args of [
        ["plugin", "logs", PLUGIN],
        ["plugin", "list"],
      ]) {
        try {
          lines.push(`== ${server.name}: bb ${args.join(" ")}`, server.bb(args));
        } catch (error) {
          lines.push(`== ${server.name}: bb ${args.join(" ")} failed: ${error.message}`);
        }
      }
    }
    try {
      const list = await control.rpc(PLUGIN, "work.v1.list", {});
      lines.push("== work.v1.list servers", JSON.stringify(list.servers, null, 1));
    } catch (error) {
      lines.push(`== work.v1.list failed: ${error.message}`);
    }
    for (const method of ["work.v1.actions", "work.v1.waiting"]) {
      try {
        lines.push(
          `== ${method}`,
          JSON.stringify(
            await control.rpc(PLUGIN, method, method === "work.v1.waiting" ? null : {}),
            null,
            1,
          ),
        );
      } catch (error) {
        lines.push(`== ${method} failed: ${error.message}`);
      }
    }
    writeFileSync(path.join(root, "diagnostics.log"), lines.join("\n"));
    await Promise.all([control.stop(), executor.stop()]);
    await proxy.close();
  });

  it("starts exactly one chat after the owner says Start, and none on Cancel", async () => {
    const tools = stubRecords().filter((entry) => entry.kind === "tools");
    assert.ok(
      tools.some((entry) => entry.tools?.includes("sa_start_chat")),
      "the bot's session lists sa_start_chat",
    );
    const known = await knownActions();
    await sayToBot(
      startCall("[stub:reply создай чат на linux и вызови sa_start_chat]", "first task"),
    );
    const proposal = await newestAction(known);
    assert.equal(proposal.state, "proposed");
    const toolResult = stubRecords()
      .filter((entry) => entry.kind === "tool")
      .at(-1);
    assert.match(
      toolResult?.output ?? "",
      /^Proposed as act_/,
      "the bot gets the tool's own answer in the same turn",
    );
    const card = await waitCard("start card", (data) => data.title === "Запустить чат на linux?");
    await new Promise((resolve) => setTimeout(resolve, 70_000));
    assert.deepEqual(await spawnedOnExecutor(), [], "no chat before the owner answers");
    await respond(card, "start");
    const bound = await waitFor("action bound", PASS, async () => {
      const current = await action(proposal.id);
      return current?.state === "bound" ? current : null;
    });
    ids.firstTask = bound.threadId;
    assert.deepEqual(
      (await spawnedOnExecutor()).map((row) => row.threadId),
      [bound.threadId],
    );
    const declined = await proposeAndConfirm("[stub:reply never]", "declined task", "no");
    await new Promise((resolve) => setTimeout(resolve, 70_000));
    assert.equal((await action(declined))?.state, "canceled");
    assert.equal((await spawnedOnExecutor()).length, 1);
  });

  it("shows the executor's result once as a card, starts no bot turn and acts on nothing in it", async () => {
    const turnsBefore = await turnsDone(control, ids.bot);
    const actionsBefore = await knownActions();
    const card = await waitCard(
      "result card",
      (data) => data.title === `Задача готова: linux:${ids.firstTask}`,
    );
    assert.match(card.payload.data.quote, /создай чат/);
    await respond(card, "ok");
    await new Promise((resolve) => setTimeout(resolve, 70_000));
    assert.equal(
      (await pendingCards()).filter((pending) =>
        pending.payload.data.title.startsWith("Задача готова"),
      ).length,
      0,
    );
    assert.equal(await turnsDone(control, ids.bot), turnsBefore, "the bot's model did not run");
    assert.deepEqual(await knownActions(), actionsBefore, "no new action from the executor's text");
  });

  it("finds a chat whose creation answer was lost and creates no second one", async () => {
    await clearCards();
    proxy.setMode({ kind: "drop-response", once: true });
    const actionId = await proposeAndConfirm("[stub:reply lost answer task]", "lost answer");
    const bound = await waitFor("lost-answer action bound", PASS, async () => {
      const current = await action(actionId);
      return current?.state === "bound" ? current : null;
    });
    const matching = (await spawnedOnExecutor()).filter((row) => row.label?.actionId === actionId);
    assert.deepEqual(
      matching.map((row) => row.threadId),
      [bound.threadId],
    );
  });

  it("does not retry a request that is applied after the first empty read, and binds it later", async () => {
    await clearCards();
    proxy.setMode({ kind: "forward-later", once: true, delayMs: 75_000 });
    const actionId = await proposeAndConfirm("[stub:reply late task]", "late task");
    await waitFor("unknown", PASS, async () => (await action(actionId))?.state === "unknown");
    assert.equal(
      (await spawnedOnExecutor()).filter((row) => row.label?.actionId === actionId).length,
      0,
    );
    const bound = await waitFor("late action bound", PASS, async () => {
      const current = await action(actionId);
      return current?.state === "bound" ? current : null;
    });
    const matching = (await spawnedOnExecutor()).filter((row) => row.label?.actionId === actionId);
    assert.deepEqual(
      matching.map((row) => row.threadId),
      [bound.threadId],
    );
    const posts = proxy.log.filter(
      (entry) => entry.method === "POST" && entry.url === "/api/v1/threads",
    );
    assert.equal(posts.filter((entry) => entry.mode === "forward-later").length, 1);
  });

  it("binds neither of two chats carrying one label, asks the owner, and keeps the card through a bot turn", async () => {
    await clearCards();
    proxy.setMode({ kind: "swallow", once: true });
    const actionId = await proposeAndConfirm("[stub:reply swallowed task]", "two chats");
    await waitFor("unknown", PASS, async () => (await action(actionId))?.state === "unknown");
    const current = await action(actionId);
    await Promise.all(
      ["duplicate one", "duplicate two"].map((title) =>
        executor.api("POST", "/threads", {
          projectId: ids.executorProject,
          providerId: PROVIDER,
          model: MODEL,
          title,
          origin: "plugin",
          originPluginId: PLUGIN,
          pluginMetadata: { spawn: { actionId, attempt: current.attempt } },
          environment: { type: "project-default" },
          sendAt: Date.now() + 7 * 24 * 3600 * 1000,
          input: [{ type: "text", text: "[stub:reply duplicate]" }],
        }),
      ),
    );
    const card = await waitCard(
      "ambiguous card",
      (data) => data.title === "Найдено два чата одной попытки",
    );
    assert.equal((await action(actionId))?.state, "ambiguous");
    assert.equal((await action(actionId))?.threadId, null);
    await sayToBot("[stub:reply the owner writes while a card is open]");
    const still = (await pendingCards()).find((pending) => pending.id === card.id);
    assert.ok(still, "the card survives the owner's message and the bot's turn");
    await respond(card, "ok");
    await assert.rejects(respond(card, "ok"), /→ (409|400)/);
  });

  it("keeps one card open at a time and counts the others", async () => {
    await clearCards();
    const known = await knownActions();
    await sayToBot(startCall("[stub:reply queued one]", "queued one"));
    await sayToBot(startCall("[stub:reply queued two]", "queued two"));
    await waitFor("two proposals", 60_000, async () => {
      const { actions } = await control.rpc(PLUGIN, "work.v1.actions", {});
      return actions.filter((candidate) => !known.has(candidate.id)).length === 2;
    });
    const card = await waitCard("first of two", (data) => data.quote === "[stub:reply queued one]");
    assert.equal((await pendingCards()).length, 1, "one card open in the chat");
    const waiting = await control.rpc(PLUGIN, "work.v1.waiting", null);
    assert.equal(waiting.questions.filter((question) => question.kind === "start_chat").length, 2);
    await respond(card, "no");
    const second = await waitCard(
      "second of two",
      (data) => data.quote === "[stub:reply queued two]",
    );
    await respond(second, "no");
  });

  it("runs an action exactly once when the control server restarts between the answer and the send", async () => {
    await clearCards();
    proxy.setMode({ kind: "delay", once: true, delayMs: 60_000 });
    const actionId = await proposeAndConfirm("[stub:reply restart task]", "restart task");
    await waitFor("spawn request in flight", 60_000, async () =>
      proxy.log.some((entry) => entry.mode === "delay"),
    );
    await control.stop();
    control.start();
    await control.waitReady();
    const bound = await waitFor("restart action bound", PASS * 2, async () => {
      const current = await action(actionId);
      return current?.state === "bound" ? current : null;
    });
    const matching = (await spawnedOnExecutor()).filter((row) => row.label?.actionId === actionId);
    assert.deepEqual(
      matching.map((row) => row.threadId),
      [bound.threadId],
    );
  });

  it("shows the machine as the reason a new chat waits behind the executor's concurrency limit", async () => {
    await clearCards();
    executor.bb(["concurrency-limit", "global", "0"]);
    const actionId = await proposeAndConfirm("[stub:reply held task]", "held task");
    const bound = await waitFor("held action bound", PASS, async () => {
      const current = await action(actionId);
      return current?.state === "bound" ? current : null;
    });
    await waitFor("waiting reason machine", PASS, async () => {
      const list = await control.rpc(PLUGIN, "work.v1.list", {});
      const work = list.works.find((candidate) => candidate.source.threadId === bound.threadId);
      return work?.waitingReason === "machine";
    });
    executor.bb(["concurrency-limit", "global", "unlimited"]);
  });
});
