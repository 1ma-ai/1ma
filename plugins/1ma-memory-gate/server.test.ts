import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createFakePluginHost,
  makeHostResponse,
  makeMessageDispatchHookContext,
  makeQueueEntry,
  makeThreadResponse,
  type ExperimentalFakeHostRpcCall,
} from "@get-bb/plugin-sdk/testing";
import type { MemoryReading } from "./contract.js";
import { ADMISSION_WINDOW_MS, FORGET_AFTER_MS, READING_GRACE_MS } from "./gate.js";
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
    /** Answers the machine list; undefined falls back to `hosts`. */
    listHosts?: () => Promise<ReturnType<typeof makeHostResponse>[] | undefined>;
    /** Runs on each re-attempt the plugin asks for, after core took the request. */
    onRecheck?: () => void | Promise<void>;
    failRecheck?: () => boolean;
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
          (await options.listHosts?.()) ??
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
  let rechecks = 0;
  plugin({
    ...host.bb,
    experimental_hooks: {
      ...host.bb.experimental_hooks,
      async recheck(name) {
        rechecks += 1;
        if (options.failRecheck?.()) throw new Error("server busy");
        await host.bb.experimental_hooks.recheck(name);
        if (options.onRecheck !== undefined) setTimeout(() => void options.onRecheck?.(), 0);
      },
    },
  });
  const decide = (context: ReturnType<typeof newChat>) =>
    host.harness.registrations.hooks["message.dispatch"]!(context);
  return {
    ...host,
    state,
    hostChanged,
    decide,
    /** Re-attempts asked for, including failed asks. */
    rechecks: () => rechecks,
    connect(hostId: string) {
      for (const callback of hostChanged) callback({ id: hostId, changes: ["host-connected"] });
    },
  };
}

function thread(id: string) {
  return { thread: makeThreadResponse({ id }) };
}

function entry(threadId: string) {
  return { entry: makeQueueEntry({ threadId }) };
}

function newChat(threadId = "thr_new") {
  return makeMessageDispatchHookContext({
    thread: { id: threadId, status: "idle" },
    host: { id: "hst_1", name: "Build box" },
  });
}

/** The status line of the connected machine; the disconnected one also counts its waiting turns. */
async function buildBoxLine(harness: ReturnType<typeof setup>["harness"]): Promise<string> {
  const lines = (await harness.runCli(["status"])).stdout.split("\n");
  return lines.find((line) => line.startsWith("Build box")) ?? "";
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
      reason: "Waiting for free memory on Build box",
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
    await expect(decide(newChat("thr_other"))).resolves.toMatchObject({ action: "wait" });
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

it("uses the stored settings and falls back to defaults on an out-of-range value", async () => {
  const { harness } = setup({ settings: { reserveMb: 5000, minRunning: 0 } });
  try {
    await startSampler(harness);
    const decide = harness.registrations.hooks["message.dispatch"]!;
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    expect((await harness.runCli(["status"])).stdout).toContain(
      "4.0 GB free, 4.9 GB needed for a new chat",
    );
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
    ).toMatchObject({ action: "wait" });
    expect((await fallback.harness.runCli(["status"])).stdout).toContain(
      "0.5 GB free, 0.6 GB needed for a new chat",
    );
  } finally {
    await fallback.harness.lifecycle.dispose();
  }
});

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
    expect(text.stdout).toContain(
      "Build box (connected): 4.0 GB free, 0.6 GB needed for a new chat, pressure 0%, read 0 s ago; a new chat starts; 0 turns wait here",
    );
    expect(text.stdout).toContain("Old (disconnected): no reading yet");
    const json = await harness.runCli(["status", "--json"]);
    expect(JSON.parse(json.stdout)).toMatchObject({
      settings: { enabled: true, reserveMb: 600, pressurePercent: 10, minRunning: 1 },
      hosts: [
        {
          id: "hst_1",
          answer: { action: "start" },
          reading: { supported: true },
          neededBytes: 600 * MIB,
          waiting: 0,
        },
        { id: "hst_2", answer: { action: "start", why: "few-running" }, reading: null },
      ],
      hiddenHosts: 0,
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts nothing and leaves no timer behind after dispose", async () => {
  const { harness, state, decide, rechecks } = setup();
  state.reading = linux(300 * MIB);
  const service = await startSampler(harness);
  expect(await decide(newChat())).toMatchObject({ action: "wait" });
  await harness.lifecycle.dispose();
  await service.done;
  expect(vi.getTimerCount()).toBe(0);
  const before = rechecks();
  state.reading = linux(4 * GIB);
  await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 4);
  expect(rechecks()).toBe(before);
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
    await vi.advanceTimersByTimeAsync(1);
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
    expect(json.hiddenHosts).toBe(3);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("asks core once at start to re-attempt turns an earlier instance held", async () => {
  const { harness } = setup();
  try {
    expect(harness.recheckCount).toBe(0);
    await startSampler(harness);
    expect(harness.recheckCount).toBe(1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("answers a wait without a time to send at", async () => {
  const { harness, state, decide } = setup();
  state.reading = linux(300 * MIB);
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toEqual({
      action: "wait",
      reason: "Waiting for free memory on Build box",
    });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts a held turn on a later round when the first re-attempt came before its row existed", async () => {
  let stored = false;
  const answers: string[] = [];
  const s = setup({
    onRecheck: async () => {
      if (stored) answers.push((await s.decide(newChat("thr_held"))).action);
    },
  });
  s.state.reading = linux(300 * MIB);
  try {
    await startSampler(s.harness);
    expect(await s.decide(newChat("thr_held"))).toMatchObject({ action: "wait" });
    s.state.reading = linux(4 * GIB);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(s.harness.recheckCount).toBeGreaterThan(1);
    expect(answers).toEqual([]);
    stored = true;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(answers).toEqual(["proceed"]);
    const after = s.harness.recheckCount;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.harness.recheckCount).toBe(after);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

it("does not re-attempt turns held for memory while memory does not change", async () => {
  let readable = false;
  const held = Array.from({ length: 100 }, (_, index) => `thr_${String(index)}`);
  const s = setup({
    settings: { minRunning: 0 },
    hosts: [
      makeHostResponse({ id: "hst_1", name: "Build box", status: "connected" }),
      makeHostResponse({ id: "hst_2", name: "New box", status: "connected" }),
    ],
    readMemory: (call) => {
      if (call.hostId === "hst_1") return linux(300 * MIB);
      if (!readable) throw new Error("daemon is starting");
      return linux(4 * GIB);
    },
    onRecheck: async () => {
      for (const threadId of held) await s.decide(newChat(threadId));
      await s.decide(newBoxChat());
    },
  });
  const newBoxChat = () =>
    makeMessageDispatchHookContext({
      thread: { id: "thr_new_box", status: "idle" },
      host: { id: "hst_2", name: "New box" },
    });
  try {
    await startSampler(s.harness);
    await vi.advanceTimersByTimeAsync(0);
    for (const threadId of held)
      expect(await s.decide(newChat(threadId))).toMatchObject({ action: "wait" });
    expect(await s.decide(newBoxChat())).toMatchObject({ action: "wait" });
    const atStart = s.harness.recheckCount;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.harness.recheckCount).toBe(atStart);
    readable = true;
    s.connect("hst_2");
    await vi.advanceTimersByTimeAsync(0);
    expect(s.harness.recheckCount).toBe(atStart + 1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(s.harness.recheckCount).toBe(atStart + 1);
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

it("re-attempts a held turn when a share ends 45 s after its turn started", async () => {
  const running = [{ id: "thr_running", hostId: "hst_1" }];
  const { harness, state, decide } = setup({ running: async () => running });
  state.reading = linux(1000 * MIB);
  try {
    await startSampler(harness);
    expect(await decide(newChat("thr_a"))).toEqual({ action: "proceed" });
    running.push({ id: "thr_a", hostId: "hst_1" });
    await harness.emitThreadEvent("thread.active", thread("thr_a"));
    expect(await decide(newChat("thr_b"))).toMatchObject({ action: "wait" });
    const before = harness.recheckCount;
    await vi.advanceTimersByTimeAsync(ADMISSION_WINDOW_MS - SAMPLE_INTERVAL_MS);
    expect(harness.recheckCount).toBe(before);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(harness.recheckCount).toBeGreaterThan(before);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts a held turn when the patience without a reading ends", async () => {
  const { harness, decide } = setup({
    readMemory: () => {
      throw new Error("daemon went away");
    },
  });
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    const before = harness.recheckCount;
    await vi.advanceTimersByTimeAsync(READING_GRACE_MS - 1);
    expect(harness.recheckCount).toBe(before);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(harness.recheckCount).toBeGreaterThan(before);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const)(
  "re-attempts a held turn when %s leaves fewer chats than always allowed",
  async (event) => {
    const running = [{ id: "thr_running", hostId: "hst_1" }];
    const { harness, state, decide } = setup({ running: async () => running });
    state.reading = linux(0);
    try {
      await startSampler(harness);
      expect(await decide(newChat())).toMatchObject({ action: "wait" });
      const before = harness.recheckCount;
      const reads = harness.experimental_hostRpcCalls.length;
      running.length = 0;
      await harness.emitThreadEvent(event, {
        ...thread("thr_running"),
        lastAssistantText: null,
        error: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.recheckCount).toBeGreaterThan(before);
      expect(harness.experimental_hostRpcCalls.length).toBe(reads + 1);
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);

it("re-attempts a held turn at once when a chat ends while the machine list is slow", async () => {
  const running = [{ id: "thr_running", hostId: "hst_1" }];
  let lists = 0;
  const { harness, state, decide } = setup({
    running: async () => running,
    listHosts: () => (++lists === 1 ? Promise.resolve(undefined) : new Promise(() => {})),
  });
  state.reading = linux(0);
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    const before = harness.recheckCount;
    running.length = 0;
    await harness.emitThreadEvent("thread.idle", {
      ...thread("thr_running"),
      lastAssistantText: null,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(lists).toBe(2);
    expect(harness.recheckCount).toBeGreaterThan(before);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const)(
  "frees the share of a turn it let through on %s",
  async (event) => {
    const { harness, state, decide } = setup({ settings: { minRunning: 0 } });
    state.reading = linux(1000 * MIB);
    try {
      await startSampler(harness);
      expect(await decide(newChat("thr_a"))).toEqual({ action: "proceed" });
      expect(await decide(newChat("thr_b"))).toMatchObject({ action: "wait" });
      await harness.emitThreadEvent(event, {
        ...thread("thr_a"),
        lastAssistantText: null,
        error: null,
      });
      expect(await decide(newChat("thr_b"))).toEqual({ action: "proceed" });
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);

it("frees the share of a turn it let through when another check holds it", async () => {
  const { harness, state, decide } = setup({ settings: { minRunning: 0 } });
  state.reading = linux(1000 * MIB);
  try {
    await startSampler(harness);
    expect(await decide(newChat("thr_a"))).toEqual({ action: "proceed" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await decide(newChat("thr_b"))).toMatchObject({ action: "wait" });
    await harness.emitThreadEvent("message.queued", entry("thr_a"));
    expect(await decide(newChat("thr_b"))).toEqual({ action: "proceed" });
  } finally {
    await harness.lifecycle.dispose();
  }
});

it.each(["thread.idle", "thread.failed", "thread.archived", "thread.deleted"] as const)(
  "asks core to re-attempt on %s with no turn known to wait: the chat's other messages may be held",
  async (event) => {
    let lists = 0;
    const { harness } = setup({
      running: async () => {
        lists += 1;
        return [];
      },
    });
    try {
      await startSampler(harness);
      const before = harness.recheckCount;
      await harness.emitThreadEvent(event, {
        ...thread("thr_running"),
        lastAssistantText: null,
        error: null,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(harness.recheckCount).toBe(before + 1);
      expect(lists).toBe(0);
    } finally {
      await harness.lifecycle.dispose();
    }
  },
);

it("re-attempts held turns, with one warning, while the running list cannot be had", async () => {
  let failing = false;
  const { harness, state, decide } = setup({
    running: async () => {
      if (failing) throw new Error("server busy");
      return [{ id: "thr_running", hostId: "hst_1" }];
    },
  });
  state.reading = linux(0);
  const warnings = () =>
    harness.logEntries.filter(
      (entry) =>
        entry.message === "could not check held turns, asking to re-attempt them: server busy",
    ).length;
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    const before = harness.recheckCount;
    failing = true;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(harness.recheckCount).toBeGreaterThan(before);
    expect(warnings()).toBe(1);
    expect(await decide(newChat("thr_b"))).toEqual({ action: "proceed" });
    failing = false;
    expect(await decide(newChat("thr_b"))).toMatchObject({ action: "wait" });
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    failing = true;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(warnings()).toBe(2);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts held turns when the gate is switched off", async () => {
  const { harness, state, decide } = setup();
  state.reading = linux(0);
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    const before = harness.recheckCount;
    await harness.setSettings({ enabled: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.recheckCount).toBe(before + 1);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("asks the server nothing and re-attempts nothing while no turn waits", async () => {
  let lists = 0;
  const { harness } = setup({
    running: async () => {
      lists += 1;
      return [];
    },
  });
  try {
    await startSampler(harness);
    await harness.emitThreadEvent("message.cancelled", entry("thr_new"));
    await harness.emitThreadEvent("message.dispatched", entry("thr_new"));
    await harness.emitThreadEvent("thread.active", thread("thr_new"));
    await harness.setSettings({ reserveMb: 800 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.recheckCount).toBe(1);
    expect(lists).toBe(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts a turn in doubt on every round and forgets it after 10 s with a last re-attempt", async () => {
  const { harness, state, decide } = setup();
  state.reading = linux(0);
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    await harness.emitThreadEvent("message.cancelled", entry("thr_new"));
    await vi.advanceTimersByTimeAsync(0);
    let last = harness.recheckCount;
    expect(last).toBeGreaterThan(1);
    for (let waited = 0; waited < FORGET_AFTER_MS; waited += SAMPLE_INTERVAL_MS) {
      await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
      expect(harness.recheckCount).toBeGreaterThan(last);
      last = harness.recheckCount;
    }
    expect(await buildBoxLine(harness)).toContain("0 turns wait here");
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 4);
    expect(harness.recheckCount).toBe(last);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    expect(await buildBoxLine(harness)).toContain("1 turn waits here");
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("keeps a turn in doubt while the re-attempt cannot be asked for", async () => {
  let failing = true;
  const { harness, state, decide, rechecks } = setup({ failRecheck: () => failing });
  state.reading = linux(0);
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    await harness.emitThreadEvent("message.cancelled", entry("thr_new"));
    await vi.advanceTimersByTimeAsync(FORGET_AFTER_MS * 3);
    expect(
      harness.logEntries.filter(
        (entry) => entry.message === "could not re-attempt held turns: server busy",
      ),
    ).toEqual([expect.objectContaining({ level: "warn" })]);
    expect(await buildBoxLine(harness)).toContain("1 turn waits here");
    failing = false;
    const tried = rechecks();
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(rechecks()).toBeGreaterThan(tried);
    expect(harness.recheckCount).toBeGreaterThan(0);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("re-attempts a turn whose other row is left after one was removed, when memory frees", async () => {
  let walks = 0;
  const s = setup({
    onRecheck: async () => {
      walks += 1;
      await s.decide(newChat());
    },
  });
  s.state.reading = linux(0);
  try {
    await startSampler(s.harness);
    expect(await s.decide(newChat())).toMatchObject({ action: "wait" });
    await s.harness.emitThreadEvent("message.cancelled", entry("thr_new"));
    await vi.advanceTimersByTimeAsync(FORGET_AFTER_MS * 2);
    expect(await buildBoxLine(s.harness)).toContain("1 turn waits here");
    const before = s.harness.recheckCount;
    s.state.reading = linux(4 * GIB);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(s.harness.recheckCount).toBeGreaterThan(before);
    expect(walks).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await buildBoxLine(s.harness)).toContain("0 turns wait here");
  } finally {
    await s.harness.lifecycle.dispose();
  }
});

it("says that readings are back from a sampler round with no turn asking", async () => {
  let failing = true;
  const { harness, state, decide, connect } = setup({
    readMemory: () => {
      if (failing) throw new Error("daemon went away");
      return state.reading;
    },
  });
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    await vi.advanceTimersByTimeAsync(READING_GRACE_MS);
    expect(await decide(newChat())).toEqual({ action: "proceed" });
    failing = false;
    await vi.advanceTimersByTimeAsync(1);
    connect("hst_1");
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 3);
    expect(
      harness.logEntries
        .filter((line) => line.message.includes("are back"))
        .map((line) => line.message),
    ).toEqual(["memory readings from Build box are back, new turns there are checked again"]);
  } finally {
    await harness.lifecycle.dispose();
  }
});

it("asks the server nothing more and leaves no timer after dispose with a check in flight", async () => {
  const hanging: (() => void)[] = [];
  let calls = 0;
  const { harness, state, decide, rechecks } = setup({
    running: () => {
      calls += 1;
      if (calls === 1) return Promise.resolve([{ id: "thr_running", hostId: "hst_1" }]);
      return new Promise((resolve) => hanging.push(() => resolve([])));
    },
  });
  state.reading = linux(0);
  const service = await startSampler(harness);
  expect(await decide(newChat())).toMatchObject({ action: "wait" });
  await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
  expect(hanging.length).toBeGreaterThan(0);
  const before = rechecks();
  await harness.lifecycle.dispose();
  await service.done;
  expect(vi.getTimerCount()).toBe(0);
  for (const resolve of hanging) resolve();
  await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS * 4);
  expect(rechecks()).toBe(before);
  expect(calls).toBe(1 + hanging.length);
  expect(harness.logEntries.filter((entry) => entry.level === "warn")).toEqual([]);
});

it("forgets a held turn when the hook lets it through without asking the gate", async () => {
  const { harness, state, decide } = setup();
  state.reading = linux(0);
  try {
    await startSampler(harness);
    expect(await decide(newChat())).toMatchObject({ action: "wait" });
    const started = makeMessageDispatchHookContext({
      thread: { id: "thr_new", status: "active" },
      host: { id: "hst_1", name: "Build box" },
    });
    expect(await decide(started)).toEqual({ action: "proceed" });
    expect(await buildBoxLine(harness)).toContain("0 turns wait here");
    expect(await decide(newChat("thr_other"))).toMatchObject({ action: "wait" });
    await harness.setSettings({ enabled: false });
    expect(await decide(newChat("thr_other"))).toEqual({ action: "proceed" });
    expect(await buildBoxLine(harness)).toContain("0 turns wait here");
  } finally {
    await harness.lifecycle.dispose();
  }
});
