import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeThreadResponse,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import type { MemoryReading } from "./contract.js";
import { MEMORY_RETRY_MS, READING_GRACE_MS, READING_RETRY_MS } from "./gate.js";
import { SAMPLE_INTERVAL_MS } from "./sampler.js";
import plugin, { SAMPLER_NAME } from "./server.js";

const GIB = 2 ** 30;
const MIB = 2 ** 20;
const START = Date.parse("2026-11-24T10:00:00Z");
const BLANK: MemoryReading = {
  supported: true,
  cgroup: null,
  machineAvailableBytes: null,
  pressureFullAvg10: null,
};

function linux(freeBytes: number): MemoryReading {
  return {
    supported: true,
    cgroup: { limitBytes: 8 * GIB, workingSetBytes: 8 * GIB - freeBytes },
    machineAvailableBytes: null,
    pressureFullAvg10: 0,
  };
}

function setup(
  options: {
    readMemory?: (call: ExperimentalFakeHostRpcCall) => unknown;
    running?: () => Promise<{ id: string; hostId: string | null }[]>;
    settings?: Record<string, number | boolean>;
    hosts?: ReturnType<typeof makeHostResponse>[];
  } = {},
) {
  const hostChanged: ((event: { id: string; changes: string[] }) => void)[] = [];
  const state: { reading: MemoryReading } = { reading: linux(4 * GIB) };
  const host = createFakePluginHost({
    pluginId: "1ma-memory-gate",
    ...(options.settings === undefined ? {} : { settings: options.settings }),
    experimental_callHostRpc:
      options.readMemory ?? ((call) => (call.method === "readMemory" ? state.reading : null)),
    sdk: {
      hosts: {
        list: async () =>
          options.hosts ?? [
            makeHostResponse({ id: "hst_1", name: "Build box", status: "connected" }),
            makeHostResponse({ id: "hst_2", name: "Old", status: "disconnected" }),
          ],
      },
      threads: {
        listRunning: options.running ?? (async () => [{ id: "thr_running", hostId: "hst_1" }]),
      },
      subscribe: ((args: {
        event: string;
        callback: (event: { id: string; changes: string[] }) => void;
      }) => {
        if (args.event === "host:changed") hostChanged.push(args.callback);
        return () => {
          const index = hostChanged.indexOf(args.callback);
          if (index !== -1) hostChanged.splice(index, 1);
        };
      }) as never,
    },
  });
  plugin(host.bb);
  return { ...host, state, hostChanged };
}

function newChat(threadId = "thr_new") {
  return makeMessageDispatchHookContext({
    thread: { id: threadId, status: "idle" },
    host: { id: "hst_1", name: "Build box" },
  });
}

async function startSampler(harness: ReturnType<typeof setup>["harness"]) {
  const service = harness.runService(SAMPLER_NAME);
  await vi.advanceTimersByTimeAsync(0);
  return service;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

it("registers one dispatch hook and one sampler", async () => {
  const { harness } = setup();
  try {
    expect(harness.registrations.hooks["message.dispatch"]).toBeTypeOf("function");
    expect(harness.registrations.services.map((service) => service.name)).toEqual([SAMPLER_NAME]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("samples connected machines only and answers from the latest reading", async () => {
  const running = [{ id: "thr_running", hostId: "hst_1" }];
  const { harness, state } = setup({ running: async () => running });
  try {
    await startSampler(harness);
    expect(harness.experimental_hostRpcCalls.map((call) => call.hostId)).toEqual(["hst_1"]);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    expect(await decide(newChat())).toEqual({ action: "proceed" });
    running.push({ id: "thr_new", hostId: "hst_1" });

    state.reading = linux(300 * MIB);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(await decide(newChat("thr_other"))).toEqual({
      action: "wait",
      reason: "Waiting for memory on Build box: 0.3 GB free, 1.2 GB needed",
      sendAt: Date.now() + MEMORY_RETRY_MS,
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("holds briefly without a reading and samples again at once", async () => {
  const { harness, state } = setup();
  try {
    const decide = harness.registrations.hooks["message.dispatch"]!;
    expect(await decide(newChat())).toEqual({
      action: "wait",
      reason: "Checking free memory on Build box",
      sendAt: START + READING_RETRY_MS,
    });
    await startSampler(harness);
    expect(await decide(newChat())).toEqual({ action: "proceed" });
    state.reading = BLANK;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    const before = harness.experimental_hostRpcCalls.length;
    expect(await decide(newChat("thr_later"))).toMatchObject({ action: "wait" });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.experimental_hostRpcCalls.length).toBe(before + 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("keeps answering when a machine cannot be read, and logs the failure", async () => {
  const { harness } = setup({
    readMemory: () => {
      throw new Error("daemon went away");
    },
  });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    await expect(decide(newChat())).resolves.toMatchObject({ action: "wait" });
    expect(harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("daemon went away"),
      }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("lets turns through unchecked, and says so, when a machine gives no reading for long", async () => {
  const { harness } = setup({
    readMemory: () => {
      throw new Error("daemon went away");
    },
  });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    await expect(decide(newChat())).resolves.toMatchObject({ action: "wait" });
    await vi.advanceTimersByTimeAsync(READING_GRACE_MS);
    await expect(decide(newChat())).resolves.toEqual({ action: "proceed" });
    expect(harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: "no memory reading from Build box for 30 s, new turns there go ahead unchecked",
      }),
    );
    const status = await harness.runCli(["status"]);
    expect(status.stdout).toContain("a new chat starts unchecked: no memory reading");
    expect(JSON.parse((await harness.runCli(["status", "--json"])).stdout)).toMatchObject({
      hosts: [{ id: "hst_1", answer: { action: "start", why: "reading-unavailable" } }, {}],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("backs off a machine that keeps failing", async () => {
  const { harness } = setup({
    readMemory: () => {
      throw new Error("daemon went away");
    },
  });
  try {
    await startSampler(harness);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.experimental_hostRpcCalls.length).toBeLessThanOrEqual(5);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("lets the turn through and logs when something unexpected fails", async () => {
  const { harness } = setup({
    running: async () => {
      throw new Error("server busy");
    },
  });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    await expect(decide(newChat())).resolves.toEqual({ action: "proceed" });
    expect(harness.logEntries).toContainEqual(
      expect.objectContaining({ level: "warn", message: expect.stringContaining("server busy") }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("asks core to re-attempt held turns when settings change", async () => {
  const { harness } = setup();
  try {
    await harness.setSettings({ reserveMb: 800 });
    expect(harness.recheckCount).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("uses the stored settings and falls back to defaults on an out-of-range value", async () => {
  const { harness } = setup({ settings: { reserveMb: 5000, minRunning: 0 } });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    expect(await decide(newChat())).toMatchObject({
      action: "wait",
      reason: "Waiting for memory on Build box: 4.0 GB free, 4.9 GB needed",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
  const fallback = setup({ settings: { reserveMb: 10 } });
  try {
    await startSampler(fallback.harness);
    fallback.state.reading = linux(500 * MIB);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(
      await fallback.harness.registrations.hooks["message.dispatch"]!(newChat()),
    ).toMatchObject({
      action: "wait",
      reason: expect.stringContaining("0.6 GB needed"),
    });
  } finally {
    await fallback.harness.lifecycle.dispose();
  }
});

it.each(["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const)(
  "asks core to re-attempt held turns on %s",
  async (event) => {
    const { harness } = setup();
    try {
      await harness.emitThreadEvent(event, {
        thread: makeThreadResponse(),
        lastAssistantText: null,
      } as never);
      expect(harness.recheckCount).toBe(1);
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);

it("samples a machine again as soon as it connects", async () => {
  const { harness, hostChanged } = setup();
  try {
    await startSampler(harness);
    const before = harness.experimental_hostRpcCalls.length;
    for (const callback of hostChanged) callback({ id: "hst_1", changes: ["host-connected"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.experimental_hostRpcCalls.length).toBe(before + 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("reads a machine as soon as it connects even while its failed reads are backed off", async () => {
  let available = false;
  const { harness, hostChanged, state } = setup({
    readMemory: () => {
      if (!available) throw new Error("daemon went away");
      return state.reading;
    },
  });
  try {
    await startSampler(harness);
    await vi.advanceTimersByTimeAsync(75_000);
    const before = harness.experimental_hostRpcCalls.length;
    available = true;
    for (const callback of hostChanged) callback({ id: "hst_1", changes: ["host-connected"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.experimental_hostRpcCalls.length).toBe(before + 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("stops sampling and unsubscribes on dispose", async () => {
  const { harness, hostChanged } = setup();
  const service = await startSampler(harness);
  expect(hostChanged).toHaveLength(1);
  await harness.lifecycle.dispose();
  await service.done;
  const after = harness.experimental_hostRpcCalls.length;
  await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 4);
  expect(harness.experimental_hostRpcCalls.length).toBe(after);
  expect(hostChanged).toHaveLength(0);
});

it("prints each machine's reading and the answer for a new chat", async () => {
  const { harness } = setup();
  try {
    await startSampler(harness);
    const text = await harness.runCli(["status"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toContain("Memory gate: on; 600 MB per chat");
    expect(text.stdout).toContain("Build box (connected): 4.0 GB free");
    expect(text.stdout).toContain("a new chat starts");
    expect(text.stdout).toContain("Old (disconnected): no reading yet");
    const json = await harness.runCli(["status", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      settings: { enabled: true, reserveMb: 600, pressurePercent: 10, minRunning: 1 },
      hosts: [
        { id: "hst_1", answer: { action: "start" }, reading: { supported: true } },
        { id: "hst_2", answer: { action: "start", why: "few-running" }, reading: null },
      ],
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts its own held turns at the retry time when nothing else happens", async () => {
  const { harness, state } = setup();
  try {
    const decide = harness.registrations.hooks["message.dispatch"]!;
    expect(await decide(newChat())).toMatchObject({ sendAt: START + READING_RETRY_MS });
    await vi.advanceTimersByTimeAsync(READING_RETRY_MS - 1);
    expect(harness.recheckCount).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recheckCount).toBe(1);

    state.reading = linux(300 * MIB);
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ sendAt: Date.now() + MEMORY_RETRY_MS });
    await vi.advanceTimersByTimeAsync(MEMORY_RETRY_MS - 1);
    expect(harness.recheckCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.recheckCount).toBe(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("books a re-attempt at the earliest and the latest retry time, not one per held turn", async () => {
  const { harness, state } = setup();
  state.reading = linux(300 * MIB);
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    for (const threadId of ["thr_a", "thr_b", "thr_c"]) {
      expect(await decide(newChat(threadId))).toMatchObject({ action: "wait" });
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.advanceTimersByTimeAsync(MEMORY_RETRY_MS - 3_000);
    expect(harness.recheckCount).toBe(1);
    await vi.advanceTimersByTimeAsync(MEMORY_RETRY_MS * 2);
    expect(harness.recheckCount).toBe(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts nothing and leaves no timer behind after dispose", async () => {
  const { harness, state } = setup();
  state.reading = linux(300 * MIB);
  const service = await startSampler(harness);
  expect(await harness.registrations.hooks["message.dispatch"]!(newChat())).toMatchObject({
    action: "wait",
  });
  await harness.lifecycle.dispose();
  await service.done;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(MEMORY_RETRY_MS * 2);
  expect(harness.recheckCount).toBe(0);
});

it("lets the turn through with a warning when the running list never answers", async () => {
  const { harness } = setup({ running: () => new Promise(() => {}) });
  try {
    await startSampler(harness);
    const answer = harness.registrations.hooks["message.dispatch"]!(newChat());
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(answer).resolves.toEqual({ action: "proceed" });
    expect(harness.logEntries).toContainEqual(
      expect.objectContaining({
        level: "warn",
        message: expect.stringContaining("memory check failed, the turn goes ahead"),
      }),
    );
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("leaves no timer behind when disposed while the running list is being asked", async () => {
  const { harness } = setup({ running: () => new Promise(() => {}) });
  const service = await startSampler(harness);
  const answer = harness.registrations.hooks["message.dispatch"]!(newChat());
  await vi.advanceTimersByTimeAsync(0);
  await harness.lifecycle.dispose();
  await service.done;
  expect(vi.getTimerCount()).toBe(0);
  await expect(answer).resolves.toEqual({ action: "proceed" });
});

it("stops taking a machine for non-Linux once it connects again, until it answers anew", async () => {
  let answering = true;
  const { harness, hostChanged } = setup({
    settings: { minRunning: 0 },
    readMemory: () => {
      if (!answering) throw new Error("daemon is starting");
      return { supported: false };
    },
  });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    answering = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await decide(newChat())).toEqual({ action: "proceed" });
    for (const callback of hostChanged) callback({ id: "hst_1", changes: ["host-connected"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    answering = true;
    for (const callback of hostChanged) callback({ id: "hst_1", changes: ["host-connected"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(await decide(newChat())).toEqual({ action: "proceed" });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("decides from a fresh reading after the wall clock jumps", async () => {
  const { harness } = setup();
  try {
    await startSampler(harness);
    vi.setSystemTime(Date.now() + 3_600_000);
    expect(await harness.registrations.hooks["message.dispatch"]!(newChat())).toEqual({
      action: "proceed",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("does not let a turn through unchecked because the wall clock jumped", async () => {
  const { harness } = setup({
    readMemory: () => {
      throw new Error("daemon went away");
    },
  });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    await expect(decide(newChat())).resolves.toMatchObject({ action: "wait" });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(decide(newChat())).resolves.toMatchObject({ action: "wait" });
    vi.setSystemTime(Date.now() + 25_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(decide(newChat())).resolves.toMatchObject({ action: "wait" });
    vi.setSystemTime(Date.now() + 3_600_000);
    await expect(decide(newChat())).resolves.toMatchObject({ action: "wait" });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("warns once when a machine's turns go unchecked and says once when its readings are back", async () => {
  let failing = true;
  const { harness, hostChanged, state } = setup({
    readMemory: () => {
      if (failing) throw new Error("daemon went away");
      return state.reading;
    },
  });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    await decide(newChat());
    await vi.advanceTimersByTimeAsync(READING_GRACE_MS);
    for (const threadId of ["thr_a", "thr_b", "thr_c"])
      await expect(decide(newChat(threadId))).resolves.toEqual({ action: "proceed" });
    failing = false;
    for (const callback of hostChanged) callback({ id: "hst_1", changes: ["host-connected"] });
    await vi.advanceTimersByTimeAsync(0);
    await decide(newChat("thr_d"));
    await decide(newChat("thr_e"));
    const said = (level: string) =>
      harness.logEntries.filter(
        (entry) => entry.level === level && entry.message.includes("memory reading"),
      );
    expect(said("warn").map((entry) => entry.message)).toEqual([
      "no memory reading from Build box for 30 s, new turns there go ahead unchecked",
    ]);
    expect(said("info").map((entry) => entry.message)).toEqual([
      "memory readings from Build box are back, new turns there are checked again",
    ]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("prints at most 50 machines and counts the rest", async () => {
  const hosts = Array.from({ length: 53 }, (_, index) =>
    makeHostResponse({
      id: `hst_${String(index)}`,
      name: `Box ${String(index)}`,
      status: "connected",
    }),
  );
  const { harness } = setup({ hosts });
  try {
    const text = (await harness.runCli(["status"])).stdout.split("\n");
    expect(text.filter((line) => line.startsWith("Box "))).toHaveLength(50);
    expect(text.at(-1)).toBe("…and 3 more machines");
    const json = JSON.parse((await harness.runCli(["status", "--json"])).stdout);
    expect(json.hosts).toHaveLength(50);
  } finally {
    await harness.lifecycle.dispose();
  }
});
