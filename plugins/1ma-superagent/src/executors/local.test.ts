import { createFakeSdk, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createLocalExecutor } from "./local.js";

describe("local executor", () => {
  it("lists live chats with hidden ones and asks for the next page while pages are full", async () => {
    const { sdk, harness } = createFakeSdk({
      pluginId: "1ma-superagent",
      overrides: {
        threads: {
          list: async (args?: { offset?: number }) =>
            args?.offset === 0
              ? [makeThreadResponse({ id: "thr_1" }), makeThreadResponse({ id: "thr_2" })]
              : [makeThreadResponse({ id: "thr_3", visibility: "hidden" })],
        },
        environments: { list: async () => [] },
        projects: { list: async () => [] },
      },
    });
    const executor = createLocalExecutor(sdk, {
      pageSize: 2,
      maxPages: 5,
      pageTimeoutMs: 1_000,
      totalTimeoutMs: 5_000,
    });
    const result = await executor.snapshot(new AbortController().signal);
    expect(result.completeness).toBe("complete");
    expect(result.items.threads.map((thread) => [thread.threadId, thread.hidden])).toEqual([
      ["thr_1", false],
      ["thr_2", false],
      ["thr_3", true],
    ]);
    expect(harness.callsTo("threads.list").map((args) => args[0])).toEqual([
      expect.objectContaining({ archived: false, includeHidden: true, limit: 2, offset: 0 }),
      expect.objectContaining({ archived: false, includeHidden: true, limit: 2, offset: 2 }),
    ]);
  });

  it("deletes and stops nothing once the guard refuses after the queue was read", async () => {
    let allowed = true;
    const { sdk, harness } = createFakeSdk({
      pluginId: "1ma-superagent",
      overrides: {
        threads: {
          queuedMessages: {
            list: async () => {
              allowed = false;
              return [{ id: "queued_1" }];
            },
            delete: async () => {},
          },
          stop: async () => {},
        },
      },
    });
    const executor = createLocalExecutor(sdk);
    await executor.clearQueueAndStop("thr_late", () => allowed, new AbortController().signal);
    expect(harness.callsTo("threads.queuedMessages.delete")).toEqual([]);
    expect(harness.callsTo("threads.stop")).toEqual([]);
  });
});
