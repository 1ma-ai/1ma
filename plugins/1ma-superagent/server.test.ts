import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Executor, ServerId } from "./src/observation.js";
import { snapshot, threadSummary } from "./src/test-helpers.js";
import { PASS_SCHEDULE_NAME, createPlugin } from "./server.js";

function fakeExecutor(serverId: ServerId, threads: string[], calls: ServerId[]): Executor {
  return {
    serverId,
    async snapshot() {
      calls.push(serverId);
      return snapshot(threads.map((threadId) => threadSummary({ threadId })));
    },
  };
}

async function setup(settings: Record<string, string | boolean> = {}) {
  const calls: ServerId[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "1ma-superagent", settings });
  await createPlugin({
    executors: () => [
      fakeExecutor("mac", ["thr_mac"], calls),
      fakeExecutor("linux", ["thr_linux"], calls),
    ],
  })(bb);
  return { harness, calls };
}

describe("1ma-superagent server", () => {
  it("records chats of both servers on the scheduled pass and serves them over work.v1", async () => {
    const { harness } = await setup();
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    const result = await harness.behavior.callRpc("work.v1.list", {});
    expect(result).toMatchObject({
      works: expect.arrayContaining([
        expect.objectContaining({
          source: { kind: "owner-chat", serverId: "mac", threadId: "thr_mac" },
        }),
        expect.objectContaining({
          source: { kind: "owner-chat", serverId: "linux", threadId: "thr_linux" },
        }),
      ]),
      servers: [
        expect.objectContaining({ id: "linux", completeness: "complete" }),
        expect.objectContaining({ id: "mac", completeness: "complete" }),
      ],
      nextOffset: null,
    });
    await harness.lifecycle.dispose();
  });

  it("does not run a pass on a server in the executor role", async () => {
    const { harness, calls } = await setup({ role: "executor" });
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(calls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("does not run the scheduled pass when watching is turned off", async () => {
    const { harness, calls } = await setup({ passEnabled: false });
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    expect(calls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("reads only the local server when a local chat finishes a turn", async () => {
    const { harness, calls } = await setup();
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_mac" }),
      lastAssistantText: null,
    });
    await harness.behavior.callRpc("work.v1.waiting", null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(["mac"]);
    await harness.lifecycle.dispose();
  });

  it("refuses an unknown work id with not_found", async () => {
    const { harness } = await setup();
    await expect(
      harness.behavior.callRpc("work.v1.get", { workId: "work_none" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await harness.lifecycle.dispose();
  });
});

describe("default executors", () => {
  it("watches this server through the SDK and marks an unreachable second server as not seen", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "1ma-superagent",
      settings: { linuxServerUrl: "http://127.0.0.1:9" },
      sdk: {
        threads: { list: async () => [makeThreadResponse({ id: "thr_local" })] },
        environments: { list: async () => [] },
        projects: { list: async () => [] },
      },
    });
    await createPlugin()(bb);
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    const result = await harness.behavior.callRpc("work.v1.list", {});
    expect(result).toMatchObject({
      works: [
        expect.objectContaining({
          source: { kind: "owner-chat", serverId: "mac", threadId: "thr_local" },
        }),
      ],
      servers: [
        expect.objectContaining({ id: "linux", completeness: "failed", lastSeenAt: null }),
        expect.objectContaining({ id: "mac", completeness: "complete" }),
      ],
    });
    await harness.lifecycle.dispose();
  });
});
