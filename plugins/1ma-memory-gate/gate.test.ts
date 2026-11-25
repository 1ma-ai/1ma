import { expect, it } from "vitest";
import type { MemoryReading } from "./contract.js";
import {
  ADMISSION_WINDOW_MS,
  createGate,
  MAX_REASON_LENGTH,
  MEMORY_RETRY_MS,
  READING_GRACE_MS,
  READING_RETRY_MS,
  SAMPLE_MAX_AGE_MS,
  freeBytes,
  START_WINDOW_MS,
  type GateInput,
  type GateSettings,
  type Sample,
} from "./gate.js";

const MIB = 2 ** 20;
const GIB = 2 ** 30;
const NOW = 1_000_000;
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

function taken(reading: MemoryReading, takenAt = NOW): Sample {
  return { reading, takenAt, usableAt: freeBytes(reading) === null ? null : takenAt };
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
    sample: taken(linux(4 * GIB)),
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
  const verdict = gate.answer(input({ sample: taken(linux(400 * MIB)) }));
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
  expect(gate.answer(input({ sample: taken(reading) }))).toMatchObject({
    action: "wait",
    why: "short-of-memory",
  });
});

it("holds a new turn while memory pressure is at the limit or above", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input({ sample: taken(linux(4 * GIB, 14.25)) }))).toEqual({
    action: "wait",
    why: "pressure",
    reason: "Waiting for memory on Build box: memory pressure 14%",
    retryInMs: MEMORY_RETRY_MS,
  });
  expect(gate.answer(input({ sample: taken(linux(4 * GIB, 9.99)) }))).toMatchObject({
    action: "proceed",
  });
});

it("lets only one of three queued chats through when there is room for one", () => {
  const gate = createGate(clock().now);
  const sample = taken(linux(1000 * MIB));
  const running = ["thr_running"];
  const verdicts = ["thr_a", "thr_b", "thr_c"].map((threadId) => {
    const verdict = gate.answer(input({ threadId, sample, runningOnHost: [...running] }));
    if (verdict.action === "proceed") running.push(threadId);
    return verdict;
  });
  expect(verdicts.map((verdict) => verdict.action)).toEqual(["proceed", "wait", "wait"]);
  expect(verdicts[1]).toMatchObject({
    reason: "Waiting for memory on Build box: 1.0 GB free, 1.2 GB needed",
  });
});

it("counts a thread that is re-attempted only once", () => {
  const gate = createGate(clock().now);
  const sample = taken(linux(1000 * MIB));
  const runningOnHost = ["thr_running", "thr_a"];
  expect(gate.answer(input({ threadId: "thr_a", sample, runningOnHost })).action).toBe("proceed");
  expect(gate.answer(input({ threadId: "thr_a", sample, runningOnHost })).action).toBe("proceed");
});

it("forgets an admission after 45 seconds", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(gate.answer(input({ threadId: "thr_a", sample: taken(linux(1000 * MIB)) })).action).toBe(
    "proceed",
  );
  const runningOnHost = ["thr_running", "thr_a"];
  time.advance(ADMISSION_WINDOW_MS - 1);
  const later = taken(linux(1000 * MIB), time.now());
  expect(gate.answer(input({ threadId: "thr_b", sample: later, runningOnHost })).action).toBe(
    "wait",
  );
  time.advance(1);
  const after = taken(linux(1000 * MIB), time.now());
  expect(gate.answer(input({ threadId: "thr_b", sample: after, runningOnHost })).action).toBe(
    "proceed",
  );
});

it("lets the only chat start even with no free memory", () => {
  const gate = createGate(clock().now);
  const empty = taken(linux(0, 50));
  expect(gate.answer(input({ sample: empty, runningOnHost: [] }))).toEqual({
    action: "proceed",
    why: "few-running",
  });
  expect(
    gate.answer(input({ threadId: "thr_second", sample: empty, runningOnHost: ["thr_new"] })),
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
        sample: taken(linux(0)),
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
  const base = input({ sample: taken(linux(0, 90)) });
  expect(gate.answer({ ...base, question: { ...base.question, ...question } })).toEqual({
    action: "proceed",
    why: "not-a-new-turn",
  });
});

it("lets a turn through on a machine that cannot report memory", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input({ sample: taken({ supported: false }) }))).toEqual({
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
    gate.answer(input({ sample: taken(linux(4 * GIB), NOW - SAMPLE_MAX_AGE_MS - 1) })),
  ).toEqual(expected);
  expect(
    gate.answer(input({ sample: taken(linux(4 * GIB), NOW - SAMPLE_MAX_AGE_MS) })).action,
  ).toBe("proceed");
});

it("lets everything through when turned off", () => {
  const gate = createGate(clock().now);
  expect(
    gate.answer(
      input({
        settings: { ...settings, enabled: false },
        sample: taken(linux(0, 90)),
      }),
    ),
  ).toEqual({ action: "proceed", why: "disabled" });
});

it("previews an answer without recording an admission", () => {
  const gate = createGate(clock().now);
  const sample = taken(linux(1000 * MIB));
  expect(gate.preview(input({ threadId: "thr_a", sample })).action).toBe("proceed");
  expect(
    gate.answer(input({ threadId: "thr_b", sample, runningOnHost: ["thr_running", "thr_a"] }))
      .action,
  ).toBe("proceed");
});

it("names the machine by id when it has no name and keeps the reason short", () => {
  const gate = createGate(clock().now);
  const nameless = input({ sample: taken(linux(0)) });
  nameless.question.host = { id: "hst_9", name: "  " };
  expect(gate.answer(nameless)).toMatchObject({ reason: expect.stringContaining("on hst_9:") });
  const long = input({ sample: taken(linux(0)) });
  long.question.host = { id: "hst_9", name: "x".repeat(400) };
  const verdict = gate.answer(long);
  expect(verdict.action === "wait" && verdict.reason.length).toBe(MAX_REASON_LENGTH);
});

it("holds a share for a turn it let through before the server lists it as running", () => {
  const gate = createGate(clock().now);
  const unlimited = { ...settings, minRunning: 0 };
  const sample = taken(linux(650 * MIB));
  expect(
    gate.answer(input({ threadId: "thr_a", settings: unlimited, sample, runningOnHost: [] })),
  ).toEqual({ action: "proceed", why: "enough-memory" });
  expect(
    gate.answer(input({ threadId: "thr_b", settings: unlimited, sample, runningOnHost: [] })),
  ).toMatchObject({
    action: "wait",
    reason: "Waiting for memory on Build box: 0.6 GB free, 1.2 GB needed",
  });
});

it("lets only one turn use the only-chat exception while the first is not yet listed", () => {
  const gate = createGate(clock().now);
  const empty = taken(linux(0));
  expect(gate.answer(input({ threadId: "thr_a", sample: empty, runningOnHost: [] }))).toEqual({
    action: "proceed",
    why: "few-running",
  });
  expect(gate.answer(input({ threadId: "thr_b", sample: empty, runningOnHost: [] }))).toMatchObject(
    { action: "wait", why: "short-of-memory" },
  );
});

it("frees the share of a turn it let through that never shows as running after 10 seconds", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(
    gate.answer(input({ threadId: "thr_held_elsewhere", sample: taken(linux(1000 * MIB)) })).action,
  ).toBe("proceed");
  time.advance(START_WINDOW_MS - 1);
  expect(
    gate.answer(input({ threadId: "thr_b", sample: taken(linux(1000 * MIB), time.now()) })),
  ).toMatchObject({ action: "wait", why: "short-of-memory" });
  time.advance(1);
  expect(
    gate.answer(input({ threadId: "thr_b", sample: taken(linux(1000 * MIB), time.now()) })),
  ).toEqual({ action: "proceed", why: "enough-memory" });
});

it("lets the only chat start with no reading at all", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input({ sample: undefined, runningOnHost: [] }))).toEqual({
    action: "proceed",
    why: "few-running",
  });
});

it("restarts the patience when a usable reading arrived between two asks", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(gate.answer(input({ sample: undefined }))).toMatchObject({ why: "no-reading" });
  const reading = taken(linux(4 * GIB), NOW + 1_000);
  time.advance(17_000);
  expect(gate.answer(input({ sample: reading }))).toMatchObject({ why: "no-reading" });
  time.advance(13_000);
  expect(gate.answer(input({ sample: reading }))).toMatchObject({ why: "no-reading" });
  time.advance(1_000 + SAMPLE_MAX_AGE_MS + READING_GRACE_MS - 30_000 - 1);
  expect(gate.answer(input({ sample: reading }))).toMatchObject({ why: "no-reading" });
  time.advance(1);
  expect(gate.answer(input({ sample: reading }))).toEqual({
    action: "proceed",
    why: "reading-unavailable",
    readings: "lost",
  });
});

it("counts a reading without a free figure as no reading, and keeps the last usable one's time", () => {
  const time = clock();
  const gate = createGate(time.now);
  const blank: MemoryReading = {
    supported: true,
    cgroup: null,
    machineAvailableBytes: null,
    pressureFullAvg10: null,
  };
  expect(gate.answer(input({ sample: taken(blank) }))).toMatchObject({ why: "no-reading" });
  time.advance(READING_GRACE_MS);
  expect(
    gate.answer(input({ sample: { reading: blank, takenAt: time.now(), usableAt: NOW } })),
  ).toMatchObject({ why: "no-reading" });
  expect(gate.answer(input({ sample: { ...taken(blank), takenAt: time.now() } }))).toEqual({
    action: "proceed",
    why: "reading-unavailable",
    readings: "lost",
  });
});

it("lets a turn through once its machine gave no reading for 30 seconds", () => {
  const time = clock();
  const gate = createGate(time.now);
  for (let waited = 0; waited < READING_GRACE_MS; waited += READING_RETRY_MS) {
    expect(gate.answer(input({ sample: undefined }))).toMatchObject({
      action: "wait",
      why: "no-reading",
    });
    time.advance(READING_RETRY_MS);
  }
  expect(gate.answer(input({ sample: undefined }))).toEqual({
    action: "proceed",
    why: "reading-unavailable",
    readings: "lost",
  });
  expect(gate.answer(input({ threadId: "thr_next", sample: undefined }))).toEqual({
    action: "proceed",
    why: "reading-unavailable",
  });
});

it("waits for a reading again after one arrived", () => {
  const time = clock();
  const gate = createGate(time.now);
  gate.answer(input({ sample: undefined }));
  time.advance(READING_GRACE_MS);
  expect(gate.answer(input({ sample: undefined })).action).toBe("proceed");
  expect(gate.answer(input({ sample: taken(linux(4 * GIB), time.now()) }))).toEqual({
    action: "proceed",
    why: "enough-memory",
    readings: "back",
  });
  time.advance(SAMPLE_MAX_AGE_MS + 1);
  expect(gate.answer(input({ sample: undefined }))).toMatchObject({
    action: "wait",
    why: "no-reading",
  });
});

it("waits for a reading again when no turn asked for longer than the patience", () => {
  const time = clock();
  const gate = createGate(time.now);
  gate.answer(input({ sample: undefined }));
  time.advance(READING_GRACE_MS + 1);
  expect(gate.answer(input({ sample: undefined }))).toMatchObject({
    action: "wait",
    why: "no-reading",
  });
});

it("previews an answer without starting to wait for a reading", () => {
  const time = clock();
  const gate = createGate(time.now);
  gate.preview(input({ sample: undefined }));
  time.advance(READING_GRACE_MS);
  expect(gate.answer(input({ sample: undefined }))).toMatchObject({ action: "wait" });
});

function unchecked(gate: ReturnType<typeof createGate>, time: ReturnType<typeof clock>) {
  gate.answer(input({ sample: undefined }));
  time.advance(READING_GRACE_MS);
  return gate.answer(input({ sample: undefined }));
}

it("says once that a machine's readings are back after its turns went unchecked", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(unchecked(gate, time)).toMatchObject({ readings: "lost" });
  const fresh = () => taken(linux(4 * GIB), time.now());
  expect(gate.answer(input({ threadId: "thr_a", sample: fresh() }))).toEqual({
    action: "proceed",
    why: "enough-memory",
    readings: "back",
  });
  expect(gate.answer(input({ threadId: "thr_b", sample: fresh() }))).toEqual({
    action: "proceed",
    why: "enough-memory",
  });
});

it("says that readings are back with a wait as well", () => {
  const time = clock();
  const gate = createGate(time.now);
  unchecked(gate, time);
  expect(gate.answer(input({ sample: taken(linux(100 * MIB), time.now()) }))).toMatchObject({
    why: "short-of-memory",
    readings: "back",
  });
});

it("says nothing about readings that were only awaited", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(gate.answer(input({ sample: undefined }))).toEqual(
    expect.not.objectContaining({ readings: expect.anything() }),
  );
  expect(gate.answer(input({ sample: taken(linux(4 * GIB), time.now()) }))).toEqual({
    action: "proceed",
    why: "enough-memory",
  });
});

it("says again that readings are lost when turns ask anew after a quiet time", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(unchecked(gate, time)).toMatchObject({ readings: "lost" });
  time.advance(READING_GRACE_MS + 1);
  expect(gate.answer(input({ sample: undefined }))).toMatchObject({ why: "no-reading" });
  time.advance(READING_GRACE_MS);
  expect(gate.answer(input({ sample: undefined }))).toEqual({
    action: "proceed",
    why: "reading-unavailable",
    readings: "lost",
  });
});

it("previews an unchecked start without saying that readings were lost", () => {
  const time = clock();
  const gate = createGate(time.now);
  gate.answer(input({ sample: undefined }));
  time.advance(READING_GRACE_MS);
  expect(gate.preview(input({ sample: undefined }))).toEqual({
    action: "proceed",
    why: "reading-unavailable",
  });
  expect(gate.answer(input({ sample: undefined }))).toMatchObject({ readings: "lost" });
});
