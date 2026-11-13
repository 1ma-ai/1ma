import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { QUIET_MS, SETTLE_MS } from "./auto-updates.js";
import plugin, { SCHEDULE_CRON, SCHEDULE_NAME } from "./server.js";

const START = Date.parse("2026-11-13T10:00:00Z");

function quietThread(status = "idle") {
  return {
    id: "thr_1",
    status,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 1,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
  };
}

function setup(settings: Record<string, boolean> = {}) {
  const threads = { list: [quietThread()] };
  const host = createFakePluginHost({
    pluginId: "1ma-auto-updates",
    settings,
    sdk: {
      hosts: {
        list: async () => [
          makeHostResponse({ id: "mac", name: "MacBook", status: "connected" }),
          makeHostResponse({ id: "old", name: "Old", status: "disconnected" }),
        ],
        providerCliStatus: async () => ({
          codex: { installAction: { kind: "update" } },
          "claude-code": { installAction: null },
          opencode: { installAction: { kind: "install" } },
        }),
        installProviderCli: async () => [
          { type: "output", text: "updated" },
          { type: "completed", success: true },
        ],
      },
      plugins: {
        list: async () => ({
          plugins: [
            { id: "pool-usage", updateState: { outcome: "update-available" } },
            { id: "focus-board", updateState: { outcome: "current" } },
            { id: "local", updateState: null },
          ],
        }),
        applyUpdate: async () => ({ applied: true }),
      },
      threads: { list: async () => threads.list },
    },
  });
  plugin(host.bb);
  return { ...host, threads };
}

async function runPass(harness: ReturnType<typeof setup>["harness"]) {
  const pass = harness.runSchedule(SCHEDULE_NAME);
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  await pass;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

it("checks every fifteen minutes and updates outdated provider CLIs and plugins once 1ma is quiet", async () => {
  const { harness } = setup();
  try {
    expect(harness.registrations.schedules).toEqual([
      expect.objectContaining({ name: SCHEDULE_NAME, cron: SCHEDULE_CRON }),
    ]);
    vi.setSystemTime(START + QUIET_MS);
    await runPass(harness);
    expect(harness.sdk.callsTo("hosts.providerCliStatus")).toEqual([[{ hostId: "mac" }]]);
    expect(harness.sdk.callsTo("hosts.installProviderCli")).toEqual([
      [{ hostId: "mac", provider: "codex", actionKind: "update" }],
    ]);
    expect(harness.sdk.callsTo("plugins.applyUpdate")).toEqual([[{ pluginId: "pool-usage" }]]);
    expect(harness.recheckCount).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("holds a message sent while updates install and lets it go right after", async () => {
  const { harness } = setup();
  try {
    const decide = harness.registrations.hooks["message.dispatch"];
    expect(decide).not.toBeNull();
    vi.setSystemTime(START + QUIET_MS);
    const pass = harness.runSchedule(SCHEDULE_NAME);
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(await decide!(makeMessageDispatchHookContext())).toMatchObject({
      action: "wait",
    });
    await vi.advanceTimersByTimeAsync(1);
    await pass;
    expect(await decide!(makeMessageDispatchHookContext())).toEqual({
      action: "proceed",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("leaves everything alone while a thread runs, and for fifteen minutes after one did", async () => {
  const { harness, threads } = setup();
  try {
    vi.setSystemTime(START + QUIET_MS);
    threads.list = [quietThread("active")];
    await runPass(harness);
    expect(harness.sdk.callsTo("hosts.installProviderCli")).toEqual([]);

    threads.list = [quietThread()];
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse(),
      lastAssistantText: null,
    });
    vi.setSystemTime(START + 2 * QUIET_MS - 1);
    await runPass(harness);
    expect(harness.sdk.callsTo("hosts.installProviderCli")).toEqual([]);
    expect(harness.recheckCount).toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("does not touch plugins when plugin updates are turned off", async () => {
  const { harness } = setup({ plugins: false });
  try {
    vi.setSystemTime(START + QUIET_MS);
    await runPass(harness);
    expect(harness.sdk.callsTo("plugins.list")).toEqual([]);
    expect(harness.sdk.callsTo("plugins.applyUpdate")).toEqual([]);
    expect(harness.sdk.callsTo("hosts.installProviderCli")).toHaveLength(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});
