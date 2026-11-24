import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PASS_SCHEDULE_NAME, createPlugin } from "../server.js";
import type { SpawnRequest } from "./observation.js";
import { questionPayloadSchema } from "./questions.js";
import { START_TOOL } from "./start-tool.js";
import { answerCard, fakeExecutor, snapshot } from "./test-helpers.js";

const BOT = "thr_bot";
const PROMPT = "Rename the setting, nothing else. Do not touch the release scripts.";

interface Gate {
  armed: boolean;
  entered: () => void;
  release: Promise<void>;
}

function gate(): Gate & { reached: Promise<void>; open: () => void } {
  let entered = () => {};
  let open = () => {};
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const release = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { armed: false, entered, release, reached, open };
}

async function setup(remote = "https://github.com/example/app.git") {
  const spawned: SpawnRequest[] = [];
  const spawnedElsewhere: SpawnRequest[] = [];
  const wait = gate();
  const { bb, harness } = createFakePluginHost({
    pluginId: "1ma-superagent",
    settings: { role: "control", mainBotThreadId: BOT, excludedRepos: "example/private" },
    sdk: { projects: { get: async () => ({ id: "proj_bot", gitRemoteUrl: null }) } },
  });
  const linux = fakeExecutor("linux", {
    snapshot: async () => snapshot([]),
    projectRemote: async () => {
      if (wait.armed) {
        wait.entered();
        await wait.release;
      }
      return remote;
    },
    spawn: async (request) => {
      spawned.push(request);
      return { threadId: "thr_task" };
    },
  });
  const otherLinux = fakeExecutor("linux", {
    snapshot: async () => snapshot([]),
    projectRemote: async () => remote,
    spawn: async (request) => {
      spawnedElsewhere.push(request);
      return { threadId: "thr_elsewhere" };
    },
  });
  const mac = fakeExecutor("mac", { snapshot: async () => snapshot([]) });
  await createPlugin({
    executors: (config) => [
      mac,
      config.linuxServerUrl === "http://linux-new:7000" ? otherLinux : linux,
    ],
    gh: () => async () => ({ status: "error", message: "unused" }),
  })(bb);
  const propose = (threadId = BOT) =>
    harness.behavior.callAgentTool(
      START_TOOL,
      {
        server: "linux",
        projectId: "proj_app",
        providerId: "claude-code",
        model: "claude-opus-5-5",
        prompt: PROMPT,
      },
      { threadId, projectId: "proj_bot" },
    );
  return { harness, spawned, spawnedElsewhere, propose, wait };
}

async function confirmedWhileTargetIsChecked(t: Awaited<ReturnType<typeof setup>>) {
  await t.propose();
  t.wait.armed = true;
  await answerCard(t.harness, openCard(t.harness), "start");
  await t.wait.reached;
  t.wait.armed = false;
}

function passSettled() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

async function actionState(t: Awaited<ReturnType<typeof setup>>) {
  const result = await t.harness.behavior.callRpc("work.v1.actions", {});
  return JSON.stringify(result).match(/"state":"(\w+)"/)?.[1];
}

function openCard(harness: Awaited<ReturnType<typeof setup>>["harness"]) {
  const [request] = harness.inspection.pendingInteractions;
  if (request === undefined) throw new Error("no card");
  return {
    id: request.id,
    threadId: request.threadId,
    payload: questionPayloadSchema.parse(request.payload),
  };
}

describe("sa_start_chat", () => {
  it("only proposes: the card shows the owner's words verbatim and nothing starts before the answer", async () => {
    const { harness, spawned, propose } = await setup();
    const result = await propose();
    expect(JSON.stringify(result)).toContain("nothing starts until they answer");
    const card = openCard(harness);
    expect(card.threadId).toBe(BOT);
    expect(card.payload.quote).toBe(PROMPT);
    expect(card.payload.options[0]).toMatchObject({ id: "start", recommended: true });
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(spawned).toEqual([]);
    await answerCard(harness, card, "start");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      prompt: PROMPT,
      projectId: "proj_app",
      label: { nonce: expect.stringMatching(/^lbl_[0-9a-f]{32}$/) },
    });
    await harness.lifecycle.dispose();
  });

  it("starts nothing when the owner declines", async () => {
    const { harness, spawned, propose } = await setup();
    await propose();
    const card = openCard(harness);
    await answerCard(harness, card, "no");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(spawned).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("refuses a chat that is not the main bot and a project that is excluded", async () => {
    const other = await setup();
    expect(await other.propose("thr_someone")).toMatchObject({ isError: true });
    expect(other.harness.inspection.pendingInteractions).toEqual([]);
    await other.harness.lifecycle.dispose();
    const excluded = await setup("https://github.com/example/private.git");
    expect(await excluded.propose()).toMatchObject({ isError: true });
    expect(excluded.harness.inspection.pendingInteractions).toEqual([]);
    await excluded.harness.lifecycle.dispose();
  });
});

describe("settings changed while a confirmed start checks its target", () => {
  it("sends nothing and cancels with a notice when the project is excluded during the check", async () => {
    const t = await setup();
    await confirmedWhileTargetIsChecked(t);
    await t.harness.behavior.setSettings({ excludedRepos: "example/private, example/app" });
    t.wait.open();
    await passSettled();
    expect(t.spawned).toEqual([]);
    expect(await actionState(t)).toBe("canceled");
    expect(t.harness.inspection.pendingInteractions.map((request) => request.title)).toContain(
      "Запуск чата отменён",
    );
    await t.harness.lifecycle.dispose();
  });

  it("does not send through the old server when its address changes during the check", async () => {
    const t = await setup();
    await confirmedWhileTargetIsChecked(t);
    await t.harness.behavior.setSettings({ linuxServerUrl: "http://linux-new:7000" });
    t.wait.open();
    await passSettled();
    expect(t.spawned).toEqual([]);
    expect(await actionState(t)).toBe("confirmed");
    await t.harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(t.spawned).toEqual([]);
    expect(t.spawnedElsewhere).toHaveLength(1);
    await t.harness.lifecycle.dispose();
  });

  it("proposes nothing when the settings change while the proposal checks its project", async () => {
    const t = await setup();
    t.wait.armed = true;
    const proposal = t.propose();
    await t.wait.reached;
    await t.harness.behavior.setSettings({ role: "executor" });
    t.wait.open();
    expect(await proposal).toMatchObject({ isError: true });
    expect(t.harness.inspection.pendingInteractions).toEqual([]);
    expect(await t.harness.behavior.callRpc("work.v1.actions", {})).toEqual({ actions: [] });
    await t.harness.lifecycle.dispose();
  });

  it("sends nothing once the plugin became an executor during the check", async () => {
    const t = await setup();
    await confirmedWhileTargetIsChecked(t);
    await t.harness.behavior.setSettings({ role: "executor" });
    t.wait.open();
    await passSettled();
    await t.harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(t.spawned).toEqual([]);
    expect(t.spawnedElsewhere).toEqual([]);
    expect(await actionState(t)).toBe("confirmed");
    await t.harness.lifecycle.dispose();
  });
});

describe("work.v1.actions", () => {
  it("lists the bot's proposals with their state and without the owner's words", async () => {
    const { harness, propose } = await setup();
    await propose();
    const result = await harness.behavior.callRpc("work.v1.actions", {});
    expect(result).toMatchObject({
      actions: [{ kind: "spawn_thread", serverId: "linux", state: "proposed", attempt: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain(PROMPT);
    await harness.lifecycle.dispose();
  });
});
