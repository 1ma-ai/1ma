import { getEventListeners } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoryReading } from "./contract.js";
import type { GateHost } from "./gate.js";
import {
  createSampler,
  READ_DEADLINE_MS,
  SAMPLE_INTERVAL_MS,
  type SamplerDeps,
} from "./sampler.js";

const MIB = 2 ** 20;
const HEALTHY = { id: "hst_1", name: "Build box" };
const SLOW = { id: "hst_2", name: "Slow box" };

function linux(freeBytes: number | null): MemoryReading {
  return {
    supported: true,
    cgroup: null,
    machineAvailableBytes: freeBytes,
    pressureFullAvg10: 0,
  };
}

function deferred() {
  let resolve: (reading: MemoryReading) => void = () => {};
  const promise = new Promise<MemoryReading>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<SamplerDeps> = {}) {
  const warnings: string[] = [];
  const reads: string[] = [];
  const changes: number[] = [];
  const read = overrides.read ?? (async () => linux(4096 * MIB));
  const sampler = createSampler({
    now: () => performance.now(),
    connectedHosts: async () => [HEALTHY],
    warn: (message) => warnings.push(message),
    changed: () => changes.push(performance.now()),
    ...overrides,
    read: (hostId, signal) => {
      reads.push(hostId);
      return read(hostId, signal);
    },
  });
  const controller = new AbortController();
  let ended = false;
  const done = sampler.run(controller.signal).then(() => {
    ended = true;
  });
  return {
    sampler,
    warnings,
    reads,
    changes,
    ended: () => ended,
    async stop() {
      controller.abort();
      await done;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout", "performance"] });
});

afterEach(() => {
  vi.useRealTimers();
});

it("keeps reading a healthy machine while another one never answers", async () => {
  const run = setup({
    connectedHosts: async () => [HEALTHY, SLOW],
    read: (hostId) =>
      hostId === SLOW.id ? new Promise<MemoryReading>(() => {}) : Promise.resolve(linux(MIB)),
  });
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.sampler.get(HEALTHY.id)?.takenAt).toBeGreaterThanOrEqual(
      30_000 - SAMPLE_INTERVAL_MS,
    );
  } finally {
    await run.stop();
  }
});

it("counts a read past its deadline as a failure and starts no second read while it hangs", async () => {
  const run = setup({
    connectedHosts: async () => [SLOW],
    read: () => new Promise<MemoryReading>(() => {}),
  });
  try {
    await vi.advanceTimersByTimeAsync(READ_DEADLINE_MS);
    expect(run.warnings).toEqual([expect.stringContaining("could not read memory on Slow box")]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run.reads).toEqual([SLOW.id]);
  } finally {
    await run.stop();
  }
});

it("reads a machine at once when it connects again, even while it is backed off", async () => {
  let failing = true;
  const run = setup({
    read: async () => {
      if (failing) throw new Error("daemon went away");
      return linux(MIB);
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(75_000);
    const before = run.reads.length;
    failing = false;
    run.sampler.reconnected(HEALTHY.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.reads.length).toBe(before + 1);
    expect(run.sampler.get(HEALTHY.id)?.reading).toEqual(linux(MIB));
  } finally {
    await run.stop();
  }
});

it("does not store a result of the previous connection that arrives after a reconnect", async () => {
  const old = deferred();
  let calls = 0;
  const run = setup({
    read: () => (++calls === 1 ? old.promise : Promise.resolve(linux(4096 * MIB))),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    run.sampler.reconnected(HEALTHY.id);
    await vi.advanceTimersByTimeAsync(0);
    old.resolve(linux(100 * MIB));
    await vi.advanceTimersByTimeAsync(0);
    expect(run.sampler.get(HEALTHY.id)?.reading).toEqual(linux(4096 * MIB));
  } finally {
    await run.stop();
  }
});

it("drops the reading of the previous connection when the machine connects again", async () => {
  const next = deferred();
  let calls = 0;
  const run = setup({
    read: () => (++calls === 1 ? Promise.resolve(linux(MIB)) : next.promise),
  });
  try {
    await vi.advanceTimersByTimeAsync(1_000);
    expect(run.sampler.get(HEALTHY.id)?.reading).toEqual(linux(MIB));
    run.sampler.reconnected(HEALTHY.id);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.sampler.get(HEALTHY.id)).toEqual({ reading: null, takenAt: 0, usableAt: 0 });
    next.resolve({ supported: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.sampler.get(HEALTHY.id)).toEqual({
      reading: { supported: false },
      takenAt: 1_000,
      usableAt: 0,
    });
  } finally {
    await run.stop();
  }
});

it("leaves no listener on a read's signal once the read answered", async () => {
  const signals: AbortSignal[] = [];
  const run = setup({
    read: async (_hostId, signal) => {
      signals.push(signal);
      return linux(MIB);
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(1);
    expect(getEventListeners(signals[0]!, "abort")).toHaveLength(0);
  } finally {
    await run.stop();
  }
});

it("forgets a machine that is no longer in the list", async () => {
  let hosts: GateHost[] = [HEALTHY];
  const run = setup({ connectedHosts: async () => hosts });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(run.sampler.get(HEALTHY.id)).toBeDefined();
    expect(run.sampler.gone(HEALTHY.id)).toBe(false);
    hosts = [];
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(run.sampler.get(HEALTHY.id)).toBeUndefined();
    expect(run.sampler.gone(HEALTHY.id)).toBe(true);
  } finally {
    await run.stop();
  }
});

it("lets a reading age while the machine list cannot be had", async () => {
  let listing = true;
  const run = setup({
    connectedHosts: () => (listing ? Promise.resolve([HEALTHY]) : new Promise(() => {})),
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    listing = false;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS + READ_DEADLINE_MS);
    expect(run.warnings).toEqual([expect.stringContaining("could not list machines")]);
    expect(run.sampler.get(HEALTHY.id)?.takenAt).toBe(0);
  } finally {
    await run.stop();
  }
});

it("ends promptly on dispose while the machine list hangs", async () => {
  const run = setup({ connectedHosts: () => new Promise(() => {}) });
  await vi.advanceTimersByTimeAsync(0);
  void run.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(run.ended()).toBe(true);
});

it("ends promptly on dispose with a read in flight and does not store its late result", async () => {
  const late = deferred();
  const run = setup({ read: () => late.promise });
  await vi.advanceTimersByTimeAsync(0);
  void run.stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(run.ended()).toBe(true);
  late.resolve(linux(MIB));
  await vi.advanceTimersByTimeAsync(0);
  expect(run.sampler.get(HEALTHY.id)).toBeUndefined();
});

it("keeps the time of the last reading that gave a free figure", async () => {
  let reading = linux(MIB);
  const run = setup({ read: async () => reading });
  try {
    await vi.advanceTimersByTimeAsync(0);
    reading = linux(null);
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(run.sampler.get(HEALTHY.id)).toEqual({
      reading: linux(null),
      takenAt: SAMPLE_INTERVAL_MS,
      usableAt: 0,
    });
  } finally {
    await run.stop();
  }
});

it("warns once while the machine list keeps failing, and again when it fails anew", async () => {
  let failing = true;
  let lists = 0;
  const run = setup({
    connectedHosts: async () => {
      lists += 1;
      if (failing) throw new Error("server busy");
      return [HEALTHY];
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(12 * SAMPLE_INTERVAL_MS);
    expect(lists).toBe(13);
    expect(run.warnings).toEqual([
      "could not list machines: server busy; readings age until the list is back",
    ]);

    failing = false;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(run.sampler.get(HEALTHY.id)?.takenAt).toBe(13 * SAMPLE_INTERVAL_MS);
    failing = true;
    await vi.advanceTimersByTimeAsync(2 * SAMPLE_INTERVAL_MS);
    expect(run.warnings).toHaveLength(2);
  } finally {
    await run.stop();
  }
});

it("calls back after each stored reading and at the end of each round", async () => {
  let failing = false;
  const run = setup({
    read: async () => {
      if (failing) throw new Error("daemon went away");
      return linux(MIB);
    },
  });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(run.changes).toEqual([0, 0]);
    failing = true;
    await vi.advanceTimersByTimeAsync(SAMPLE_INTERVAL_MS);
    expect(run.changes).toEqual([0, 0, SAMPLE_INTERVAL_MS]);
  } finally {
    await run.stop();
  }
});

it("takes no machine for gone before the machine list first answered", async () => {
  const run = setup({ connectedHosts: () => new Promise(() => {}) });
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(run.sampler.gone(HEALTHY.id)).toBe(false);
  } finally {
    await run.stop();
  }
});
