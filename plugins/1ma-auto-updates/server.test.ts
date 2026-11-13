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

function thread(status = "idle", activity: { backgroundCommands?: number } = {}) {
  return {
    id: "thr_1",
    status,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: activity.backgroundCommands ?? 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
  };
}

function setup(settings: Record<string, boolean> = {}) {
  const threads = { open: [thread()], archived: [] as ReturnType<typeof thread>[] };
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
            {
              id: "pool-usage",
              source: "git:https://github.com/1ma-ai/1ma.git@^0",
              updateState: { outcome: "update-available" },
            },
            {
              id: "focus-board",
              source: "git:https://github.com/someone/focus-board.git@^1",
              updateState: { outcome: "update-available" },
            },
            {
              id: "1ma-theme",
              source: "git:https://github.com/1ma-ai/1ma.git@^0",
              updateState: { outcome: "current" },
            },
            { id: "account-pool", source: "builtin:account-pool", updateState: null },
          ],
        }),
        applyUpdate: async () => ({ applied: true }),
      },
      threads: {
        list: async (args?: { archived?: boolean }) => [
          ...(args?.archived === true ? [] : threads.open),
          ...(args?.archived === false ? [] : threads.archived),
        ],
      },
    },
  });
  plugin(host.bb);
  return { ...host, threads };
}

async function settleAll(isDone: () => boolean, rounds = 10): Promise<void> {
  if (isDone() || rounds === 0) return;
  await vi.advanceTimersByTimeAsync(SETTLE_MS);
  return settleAll(isDone, rounds - 1);
}

async function runPass(harness: ReturnType<typeof setup>["harness"]) {
  let done = false;
  const pass = harness.runSchedule(SCHEDULE_NAME).finally(() => {
    done = true;
  });
  await settleAll(() => done);
  await pass;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

it("checks every fifteen minutes and updates outdated provider CLIs and 1ma plugins once 1ma is quiet", async () => {
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
    expect(harness.recheckCount).toBe(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("leaves plugins from other sources alone by default: their updates arrive without 1ma's review", async () => {
  const { harness } = setup();
  try {
    vi.setSystemTime(START + QUIET_MS);
    await runPass(harness);
    expect(harness.sdk.callsTo("plugins.applyUpdate")).not.toContainEqual([
      { pluginId: "focus-board" },
    ]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("updates plugins from other sources only when that is turned on", async () => {
  const { harness } = setup({ otherPlugins: true });
  try {
    vi.setSystemTime(START + QUIET_MS);
    await runPass(harness);
    expect(harness.sdk.callsTo("plugins.applyUpdate")).toEqual([
      [{ pluginId: "pool-usage" }],
      [{ pluginId: "focus-board" }],
    ]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("holds a message sent while an update installs and lets it go right after", async () => {
  const { harness } = setup();
  try {
    const decide = harness.registrations.hooks["message.dispatch"];
    expect(decide).not.toBeNull();
    vi.setSystemTime(START + QUIET_MS);
    let done = false;
    const pass = harness.runSchedule(SCHEDULE_NAME).finally(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(SETTLE_MS - 1);
    expect(await decide!(makeMessageDispatchHookContext())).toMatchObject({
      action: "wait",
      reason: expect.stringContaining("codex on MacBook"),
    });
    await settleAll(() => done);
    await pass;
    expect(await decide!(makeMessageDispatchHookContext())).toEqual({
      action: "proceed",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each([
  ["a thread runs", () => ({ open: [thread("active")], archived: [] })],
  [
    "a background command runs",
    () => ({ open: [thread("idle", { backgroundCommands: 1 })], archived: [] }),
  ],
  ["an archived thread still runs", () => ({ open: [], archived: [thread("active")] })],
])("leaves everything alone while %s", async (_case, state) => {
  const { harness, threads } = setup();
  try {
    Object.assign(threads, state());
    vi.setSystemTime(START + QUIET_MS);
    await runPass(harness);
    expect(harness.sdk.callsTo("hosts.installProviderCli")).toEqual([]);
    expect(harness.sdk.callsTo("plugins.applyUpdate")).toEqual([]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("waits fifteen minutes after a thread finished", async () => {
  const { harness } = setup();
  try {
    await harness.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse(),
      lastAssistantText: null,
    });
    vi.setSystemTime(START + QUIET_MS - 1);
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
