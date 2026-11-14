import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { PASS_SCHEDULE_NAME, createPlugin } from "../server.js";
import type { SpawnRequest } from "./observation.js";
import { questionPayloadSchema } from "./questions.js";
import { START_TOOL } from "./start-tool.js";
import { fakeExecutor, snapshot } from "./test-helpers.js";

const BOT = "thr_bot";
const PROMPT = "Rename the setting, nothing else. Do not touch the release scripts.";

async function setup(remote = "https://github.com/example/app.git") {
  const spawned: SpawnRequest[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "1ma-superagent",
    settings: { role: "control", mainBotThreadId: BOT, excludedRepos: "example/private" },
  });
  const linux = fakeExecutor("linux", {
    snapshot: async () => snapshot([]),
    projectRemote: async () => remote,
    spawn: async (request) => {
      spawned.push(request);
      return { threadId: "thr_task" };
    },
  });
  await createPlugin({
    executors: () => [fakeExecutor("mac", { snapshot: async () => snapshot([]) }), linux],
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
  return { harness, spawned, propose };
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
    harness.behavior.submitInteraction(card.id, { token: card.payload.token, optionId: "start" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      prompt: PROMPT,
      projectId: "proj_app",
      label: { attempt: 1 },
    });
    await harness.lifecycle.dispose();
  });

  it("starts nothing when the owner declines", async () => {
    const { harness, spawned, propose } = await setup();
    await propose();
    const card = openCard(harness);
    harness.behavior.submitInteraction(card.id, { token: card.payload.token, optionId: "no" });
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
