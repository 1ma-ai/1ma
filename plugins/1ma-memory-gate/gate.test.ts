import { expect, it } from "vitest";
import type { MemoryReading } from "./contract.js";
import {
  ADMISSION_WINDOW_MS,
  createGate,
  MAX_REASON_LENGTH,
  MEMORY_RETRY_MS,
  READING_RETRY_MS,
  SAMPLE_MAX_AGE_MS,
  type GateInput,
  type GateSettings,
} from "./gate.js";

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const NOW = Date.parse("2026-11-24T10:00:00Z");
const HOST = { id: "hst_1", name: "Build box" };

const settings: GateSettings = {
  enabled: true,
  reserveBytes: 600 * MIB,
  pressurePercent: 10,
  minRunning: 1,
};

function linux(freeBytes: number, pressure: number | null = 0): MemoryReading {
  return {
    supported: true,
    cgroup: { limitBytes: 8 * GIB, workingSetBytes: 8 * GIB - freeBytes },
    machineAvailableBytes: 16 * GIB,
    pressureFullAvg10: pressure,
  };
}

function clock(start = NOW) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function input(overrides: Partial<GateInput> & { threadId?: string } = {}): GateInput {
  const { threadId = "thr_new", ...rest } = overrides;
  return {
    question: { attempt: "start-turn", threadId, threadStatus: "idle", host: HOST },
    settings,
    sample: { reading: linux(4 * GIB), takenAt: NOW },
    runningOnHost: ["thr_running"],
    ...rest,
  };
}

it("lets a new turn start when there is enough memory", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input())).toEqual({ action: "proceed", why: "enough-memory" });
});

it("holds a new turn with a reason and a retry time when memory is short", () => {
  const gate = createGate(clock().now);
  const verdict = gate.answer(input({ sample: { reading: linux(400 * MIB), takenAt: NOW } }));
  expect(verdict).toEqual({
    action: "wait",
    why: "short-of-memory",
    reason: "Waiting for memory on Build box: 0.4 GB free, 0.6 GB needed",
    retryInMs: MEMORY_RETRY_MS,
  });
});

it("takes the smaller of the container room and the machine's available memory", () => {
  const gate = createGate(clock().now);
  const reading: MemoryReading = {
    supported: true,
    cgroup: { limitBytes: 8 * GIB, workingSetBytes: 2 * GIB },
    machineAvailableBytes: 500 * MIB,
    pressureFullAvg10: 0,
  };
  expect(gate.answer(input({ sample: { reading, takenAt: NOW } }))).toMatchObject({
    action: "wait",
    why: "short-of-memory",
  });
});

it("holds a new turn while memory pressure is at the limit or above", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input({ sample: { reading: linux(4 * GIB, 14.25), takenAt: NOW } }))).toEqual({
    action: "wait",
    why: "pressure",
    reason: "Waiting for memory on Build box: memory pressure 14%",
    retryInMs: MEMORY_RETRY_MS,
  });
  expect(
    gate.answer(input({ sample: { reading: linux(4 * GIB, 9.99), takenAt: NOW } })),
  ).toMatchObject({ action: "proceed" });
});

it("lets only one of three queued chats through when there is room for one", () => {
  const gate = createGate(clock().now);
  const sample = { reading: linux(1000 * MIB), takenAt: NOW };
  const verdicts = ["thr_a", "thr_b", "thr_c"].map((threadId) =>
    gate.answer(input({ threadId, sample })),
  );
  expect(verdicts.map((verdict) => verdict.action)).toEqual(["proceed", "wait", "wait"]);
  expect(verdicts[1]).toMatchObject({
    reason: "Waiting for memory on Build box: 1.0 GB free, 1.2 GB needed",
  });
});

it("counts a thread that is re-attempted only once", () => {
  const gate = createGate(clock().now);
  const sample = { reading: linux(1000 * MIB), takenAt: NOW };
  expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
  expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
});

it("forgets an admission after 45 seconds", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(
    gate.answer(input({ threadId: "thr_a", sample: { reading: linux(1000 * MIB), takenAt: NOW } }))
      .action,
  ).toBe("proceed");
  time.advance(ADMISSION_WINDOW_MS - 1);
  const later = { reading: linux(1000 * MIB), takenAt: time.now() };
  expect(gate.answer(input({ threadId: "thr_b", sample: later })).action).toBe("wait");
  time.advance(1);
  const after = { reading: linux(1000 * MIB), takenAt: time.now() };
  expect(gate.answer(input({ threadId: "thr_b", sample: after })).action).toBe("proceed");
});

it("keeps admissions on one machine from holding turns on another", () => {
  const gate = createGate(clock().now);
  const sample = { reading: linux(1000 * MIB), takenAt: NOW };
  expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
  const other = input({ threadId: "thr_b", sample });
  other.question.host = { id: "hst_2", name: "Other" };
  expect(gate.answer(other).action).toBe("proceed");
});

it("lets the only chat start even with no free memory", () => {
  const gate = createGate(clock().now);
  const empty = { reading: linux(0, 50), takenAt: NOW };
  expect(gate.answer(input({ sample: empty, runningOnHost: [] }))).toEqual({
    action: "proceed",
    why: "few-running",
  });
  expect(
    gate.answer(input({ threadId: "thr_second", sample: empty, runningOnHost: [] })),
  ).toMatchObject({
    action: "wait",
  });
});

it("with minRunning 0 checks memory even for the first chat", () => {
  const gate = createGate(clock().now);
  expect(
    gate.answer(
      input({
        settings: { ...settings, minRunning: 0 },
        sample: { reading: linux(0), takenAt: NOW },
        runningOnHost: [],
      }),
    ).action,
  ).toBe("wait");
});

it.each([
  ["a join of a running turn", { attempt: "join-turn" }],
  ["an active thread", { threadStatus: "active" }],
  ["a starting thread", { threadStatus: "starting" }],
  ["a thread without a machine", { host: null }],
])("lets %s through", (_case, question) => {
  const gate = createGate(clock().now);
  const base = input({ sample: { reading: linux(0, 90), takenAt: NOW } });
  expect(gate.answer({ ...base, question: { ...base.question, ...question } })).toEqual({
    action: "proceed",
    why: "not-a-new-turn",
  });
});

it("lets a turn through on a machine that cannot report memory", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input({ sample: { reading: { supported: false }, takenAt: NOW } }))).toEqual({
    action: "proceed",
    why: "unsupported",
  });
});

it("holds briefly and asks for a reading when there is none or it is stale", () => {
  const gate = createGate(clock().now);
  const expected = {
    action: "wait",
    why: "no-reading",
    reason: "Checking free memory on Build box",
    retryInMs: READING_RETRY_MS,
  };
  expect(gate.answer(input({ sample: undefined }))).toEqual(expected);
  expect(
    gate.answer(
      input({ sample: { reading: linux(4 * GIB), takenAt: NOW - SAMPLE_MAX_AGE_MS - 1 } }),
    ),
  ).toEqual(expected);
  expect(
    gate.answer(input({ sample: { reading: linux(4 * GIB), takenAt: NOW - SAMPLE_MAX_AGE_MS } }))
      .action,
  ).toBe("proceed");
});

it("lets everything through when turned off", () => {
  const gate = createGate(clock().now);
  expect(
    gate.answer(
      input({
        settings: { ...settings, enabled: false },
        sample: { reading: linux(0, 90), takenAt: NOW },
      }),
    ),
  ).toEqual({ action: "proceed", why: "disabled" });
});

it("previews an answer without recording an admission", () => {
  const gate = createGate(clock().now);
  const sample = { reading: linux(1000 * MIB), takenAt: NOW };
  expect(gate.preview(input({ threadId: "thr_a", sample })).action).toBe("proceed");
  expect(gate.answer(input({ threadId: "thr_b", sample })).action).toBe("proceed");
});

it("names the machine by id when it has no name and keeps the reason short", () => {
  const gate = createGate(clock().now);
  const nameless = input({ sample: { reading: linux(0), takenAt: NOW } });
  nameless.question.host = { id: "hst_9", name: "  " };
  expect(gate.answer(nameless)).toMatchObject({ reason: expect.stringContaining("on hst_9:") });
  const long = input({ sample: { reading: linux(0), takenAt: NOW } });
  long.question.host = { id: "hst_9", name: "x".repeat(400) };
  const verdict = gate.answer(long);
  expect(verdict.action === "wait" && verdict.reason.length).toBe(MAX_REASON_LENGTH);
});
