import { describe, expect, it } from "vitest";
import type { MemoryReading } from "./contract.js";
import {
  ADMISSION_WINDOW_MS,
  createGate,
  FORGET_AFTER_MS,
  MAX_REASON_LENGTH,
  PENDING_MAX_MS,
  READING_GRACE_MS,
  SAMPLE_MAX_AGE_MS,
  freeBytes,
  type GateInput,
  type GateSettings,
  type Readings,
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

function input(
  overrides: Partial<Omit<GateInput, "running">> & {
    threadId?: string;
    runningOnHost?: readonly string[];
  } = {},
): GateInput {
  const { threadId = "thr_new", runningOnHost = ["thr_running"], ...rest } = overrides;
  return {
    question: { attempt: "start-turn", threadId, threadStatus: "idle", host: HOST },
    settings,
    sample: taken(linux(4 * GIB)),
    running: runningOnHost.map((id) => ({ id, hostId: HOST.id })),
    ...rest,
  };
}

function readings(samples: Record<string, Sample>, gone: readonly string[] = []): Readings {
  return { get: (hostId) => samples[hostId], gone: (hostId) => gone.includes(hostId) };
}

it("lets a new turn start when there is enough memory", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input())).toEqual({ action: "proceed", why: "enough-memory" });
});

it("holds a new turn with a reason that names the machine when memory is short", () => {
  const gate = createGate(clock().now);
  const verdict = gate.answer(input({ sample: taken(linux(400 * MIB)) }));
  expect(verdict).toEqual({
    action: "wait",
    why: "short-of-memory",
    reason: "Waiting for free memory on Build box",
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
    reason: "Waiting for memory pressure on Build box to ease",
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
});

it("counts a thread that is re-attempted only once", () => {
  const gate = createGate(clock().now);
  const sample = taken(linux(1000 * MIB));
  const runningOnHost = ["thr_running", "thr_a"];
  expect(gate.answer(input({ threadId: "thr_a", sample, runningOnHost })).action).toBe("proceed");
  expect(gate.answer(input({ threadId: "thr_a", sample, runningOnHost })).action).toBe("proceed");
});

it("frees a share 45 seconds after its turn started", () => {
  const time = clock();
  const gate = createGate(time.now);
  expect(gate.answer(input({ threadId: "thr_a", sample: taken(linux(1000 * MIB)) })).action).toBe(
    "proceed",
  );
  const runningOnHost = ["thr_running", "thr_a"];
  time.advance(5_000);
  gate.active("thr_a");
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

it("holds a turn and asks for a reading when there is none or it is stale", () => {
  const gate = createGate(clock().now);
  const expected = {
    action: "wait",
    why: "no-reading",
    reason: "Checking free memory on Build box",
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
  nameless.running = [{ id: "thr_running", hostId: "hst_9" }];
  expect(gate.answer(nameless)).toMatchObject({ reason: "Waiting for free memory on hst_9" });
  const long = input({ sample: taken(linux(0)) });
  long.question.host = { id: "hst_9", name: "x".repeat(400) };
  long.running = nameless.running;
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
  ).toMatchObject({ action: "wait", why: "short-of-memory" });
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

describe("a turn it let through before core starts it", () => {
  it.each([
    { name: "one memory share", minRunning: 0, free: 650 * MIB },
    { name: "the only-chat exception", minRunning: 1, free: 0 },
  ])("keeps its $name until the turn starts", ({ minRunning, free }) => {
    const time = clock();
    const gate = createGate(time.now);
    const ask = (threadId: string) =>
      gate.answer(
        input({
          threadId,
          settings: { ...settings, minRunning },
          sample: taken(linux(free), time.now()),
          runningOnHost: [],
        }),
      );
    expect(ask("thr_a").action).toBe("proceed");
    for (const at of [10_000, 60_000, 119_000]) {
      time.advance(at - (time.now() - NOW));
      expect(ask("thr_b")).toMatchObject({ action: "wait", why: "short-of-memory" });
    }
    time.advance(1_000);
    expect(ask("thr_b").action).toBe("proceed");
  });

  it("frees its share when another check held the attempt", () => {
    const gate = createGate(clock().now);
    const sample = taken(linux(1000 * MIB));
    expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
    gate.queued("thr_a");
    expect(gate.answer(input({ threadId: "thr_b", sample }))).toEqual({
      action: "proceed",
      why: "enough-memory",
    });
  });

  it("keeps its share when an attempt is held while the server lists it as running", () => {
    const gate = createGate(clock().now);
    const sample = taken(linux(1000 * MIB));
    const runningOnHost = ["thr_running", "thr_a"];
    expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
    gate.queued("thr_a");
    expect(gate.answer(input({ threadId: "thr_b", sample, runningOnHost })).action).toBe("wait");
    gate.active("thr_a");
    gate.queued("thr_a");
    expect(gate.answer(input({ threadId: "thr_b", sample, runningOnHost })).action).toBe("wait");
  });

  it("keeps its share while listed as starting past 2 minutes, and 45 s more once it started", () => {
    const time = clock();
    const gate = createGate(time.now);
    const runningOnHost = ["thr_running", "thr_a"];
    const ask = () =>
      gate.answer(
        input({ threadId: "thr_b", sample: taken(linux(1000 * MIB), time.now()), runningOnHost }),
      ).action;
    expect(gate.answer(input({ threadId: "thr_a", sample: taken(linux(1000 * MIB)) })).action).toBe(
      "proceed",
    );
    time.advance(PENDING_MAX_MS + 10_000);
    expect(ask()).toBe("wait");
    gate.active("thr_a");
    time.advance(ADMISSION_WINDOW_MS - 1);
    expect(ask()).toBe("wait");
    time.advance(1);
    expect(ask()).toBe("proceed");
  });

  it.each(["ended", "removed"] as const)("frees its share when the thread is %s", (end) => {
    const gate = createGate(clock().now);
    const sample = taken(linux(1000 * MIB));
    expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
    gate[end]("thr_a");
    expect(gate.answer(input({ threadId: "thr_b", sample })).action).toBe("proceed");
  });

  it("holds one share for a thread it let through twice", () => {
    const time = clock();
    const gate = createGate(time.now);
    const sample = () => taken(linux(1300 * MIB), time.now());
    expect(gate.answer(input({ threadId: "thr_a", sample: sample() })).action).toBe("proceed");
    time.advance(5_000);
    expect(gate.answer(input({ threadId: "thr_a", sample: sample() })).action).toBe("proceed");
    expect(gate.answer(input({ threadId: "thr_b", sample: sample() })).action).toBe("proceed");
  });

  it("counts a thread on another machine only there", () => {
    const gate = createGate(clock().now);
    const sample = taken(linux(1000 * MIB));
    expect(gate.answer(input({ threadId: "thr_a", sample })).action).toBe("proceed");
    const other = input({ threadId: "thr_b", sample });
    other.question.host = { id: "hst_2", name: "Other" };
    other.running = [{ id: "thr_running_2", hostId: "hst_2" }];
    expect(gate.answer(other).action).toBe("proceed");
  });
});

it("lets the only chat start with no reading at all", () => {
  const gate = createGate(clock().now);
  expect(gate.answer(input({ sample: undefined, runningOnHost: [] }))).toEqual({
    action: "proceed",
    why: "few-running",
  });
});

describe("patience without a reading", () => {
  it("lets a turn through once one waited 30 s and the machine gave no reading for 30 s", () => {
    const time = clock();
    const gate = createGate(time.now);
    expect(gate.answer(input({ sample: undefined }))).toMatchObject({ why: "no-reading" });
    time.advance(READING_GRACE_MS - 1);
    expect(gate.answer(input({ threadId: "thr_b", sample: undefined }))).toMatchObject({
      why: "no-reading",
    });
    time.advance(1);
    expect(gate.answer(input({ threadId: "thr_b", sample: undefined }))).toEqual({
      action: "proceed",
      why: "reading-unavailable",
      readings: "lost",
    });
  });

  it("lets a turn that waited long for memory through 30 s after the readings stop being usable", () => {
    const time = clock();
    const gate = createGate(time.now);
    expect(gate.answer(input({ sample: taken(linux(100 * MIB)) }))).toMatchObject({
      why: "short-of-memory",
    });
    time.advance(10 * 60_000);
    const last = taken(linux(100 * MIB), time.now());
    time.advance(SAMPLE_MAX_AGE_MS + READING_GRACE_MS - 1);
    expect(gate.answer(input({ sample: last }))).toMatchObject({ why: "no-reading" });
    time.advance(1);
    expect(gate.answer(input({ sample: last }))).toMatchObject({
      action: "proceed",
      why: "reading-unavailable",
    });
  });

  it("holds the first turn after a quiet time even when the readings are long gone", () => {
    const time = clock();
    const gate = createGate(time.now);
    const old = taken(linux(4 * GIB));
    time.advance(10 * 60_000);
    expect(gate.answer(input({ sample: old }))).toMatchObject({ why: "no-reading" });
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

  it("previews an answer without starting to wait", () => {
    const time = clock();
    const gate = createGate(time.now);
    gate.preview(input({ sample: undefined }));
    time.advance(READING_GRACE_MS);
    expect(gate.answer(input({ sample: undefined }))).toMatchObject({ action: "wait" });
  });
});

describe("the note on unchecked turns", () => {
  function unchecked(gate: ReturnType<typeof createGate>, time: ReturnType<typeof clock>) {
    gate.answer(input({ sample: undefined }));
    gate.answer(input({ threadId: "thr_next", sample: undefined }));
    time.advance(READING_GRACE_MS);
    const answer = gate.answer(input({ sample: undefined }));
    time.advance(1);
    return answer;
  }

  it("says once that readings are lost and once that they are back", () => {
    const time = clock();
    const gate = createGate(time.now);
    expect(unchecked(gate, time)).toMatchObject({ readings: "lost" });
    expect(gate.answer(input({ threadId: "thr_next", sample: undefined }))).toEqual({
      action: "proceed",
      why: "reading-unavailable",
    });
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
    expect(gate.readingsBack(readings({ [HOST.id]: fresh() }))).toEqual([]);
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

  it("reports a second unchecked time after a usable reading between two asks", () => {
    const time = clock(0);
    const gate = createGate(time.now);
    const ask = (usableAt: number | null) =>
      gate.answer(
        input({
          threadId: "thr_waiting",
          settings: { ...settings, minRunning: 0 },
          sample:
            usableAt === null
              ? undefined
              : { reading: linux(100 * MIB), takenAt: usableAt, usableAt },
          runningOnHost: [],
        }),
      );
    expect(ask(null).action).toBe("wait");
    time.advance(30_000);
    expect(ask(null)).toMatchObject({ why: "reading-unavailable", readings: "lost" });
    time.advance(18_000);
    expect(ask(31_000)).toMatchObject({ why: "no-reading", readings: "back" });
    time.advance(30_000);
    expect(ask(31_000)).toMatchObject({ why: "reading-unavailable", readings: "lost" });
  });

  it("ends the unchecked time from the readings alone, once", () => {
    const time = clock();
    const gate = createGate(time.now);
    unchecked(gate, time);
    expect(gate.readingsBack(readings({}))).toEqual([]);
    const fresh = readings({ [HOST.id]: taken(linux(4 * GIB), time.now() + 1) });
    expect(gate.readingsBack(fresh)).toEqual([HOST.id]);
    expect(gate.readingsBack(fresh)).toEqual([]);
    expect(gate.answer(input({ sample: fresh.get(HOST.id) }))).toEqual({
      action: "proceed",
      why: "enough-memory",
    });
  });

  it("drops a machine that left the list without a note", () => {
    const time = clock();
    const gate = createGate(time.now);
    unchecked(gate, time);
    expect(gate.readingsBack(readings({}, [HOST.id]))).toEqual([]);
    expect(
      gate.readingsBack(readings({ [HOST.id]: taken(linux(4 * GIB), time.now() + 1) })),
    ).toEqual([]);
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
});

describe("turns it holds", () => {
  const short = taken(linux(100 * MIB));
  const due = (gate: ReturnType<typeof createGate>, sample: Sample = short) => [
    ...gate
      .due(settings, readings({ [HOST.id]: sample }), [{ id: "thr_running", hostId: HOST.id }])
      .keys(),
  ];

  it("are due when they would go ahead now", () => {
    const gate = createGate(clock().now);
    expect(gate.answer(input({ threadId: "thr_a", sample: short })).action).toBe("wait");
    expect(gate.hasWaiting()).toBe(true);
    expect(gate.waitingOn(HOST.id)).toBe(1);
    expect(due(gate)).toEqual([]);
    expect(due(gate, taken(linux(4 * GIB)))).toEqual(["thr_a"]);
  });

  it.each([
    [
      "any other answer",
      (gate: ReturnType<typeof createGate>) => gate.answer(input({ threadId: "thr_a" })),
    ],
    ["an answer without the gate", (gate: ReturnType<typeof createGate>) => gate.passed("thr_a")],
    ["a dispatched row", (gate: ReturnType<typeof createGate>) => gate.dispatched("thr_a")],
    ["a started turn", (gate: ReturnType<typeof createGate>) => gate.active("thr_a")],
    ["a removed thread", (gate: ReturnType<typeof createGate>) => gate.removed("thr_a")],
  ])("are forgotten on %s", (_case, forget) => {
    const gate = createGate(clock().now);
    gate.answer(input({ threadId: "thr_a", sample: short }));
    forget(gate);
    expect(gate.hasWaiting()).toBe(false);
  });

  it("stay when the thread's turn ends", () => {
    const gate = createGate(clock().now);
    gate.answer(input({ threadId: "thr_a", sample: short }));
    gate.ended("thr_a");
    expect(gate.hasWaiting()).toBe(true);
  });

  it("in doubt are due until a re-attempt 10 s later, then forgotten", () => {
    const time = clock();
    const gate = createGate(time.now);
    gate.answer(input({ threadId: "thr_a", sample: short }));
    gate.cancelled("thr_a");
    for (let waited = 0; waited < FORGET_AFTER_MS; waited += 5_000) {
      const now = gate.due(settings, readings({ [HOST.id]: short }), []);
      expect([...now.keys()]).toEqual(["thr_a"]);
      gate.rechecked(now);
      expect(gate.hasWaiting()).toBe(true);
      time.advance(5_000);
    }
    gate.rechecked(gate.due(settings, readings({ [HOST.id]: short }), []));
    expect(gate.hasWaiting()).toBe(false);
  });

  it("asked again after a re-attempt are no longer in doubt", () => {
    const time = clock();
    const gate = createGate(time.now);
    gate.answer(input({ threadId: "thr_a", sample: short }));
    gate.cancelled("thr_a");
    time.advance(FORGET_AFTER_MS);
    const last = gate.due(settings, readings({ [HOST.id]: short }), []);
    gate.answer(input({ threadId: "thr_a", sample: short }));
    gate.rechecked(last);
    expect(gate.hasWaiting()).toBe(true);
    time.advance(FORGET_AFTER_MS);
    expect(due(gate)).toEqual([]);
    expect(gate.hasWaiting()).toBe(true);
  });

  it("re-attempted because they would go ahead are forgotten after 10 s", () => {
    const time = clock();
    const gate = createGate(time.now);
    gate.answer(input({ threadId: "thr_a", sample: short }));
    const enough = taken(linux(4 * GIB));
    gate.rechecked(gate.due(settings, readings({ [HOST.id]: enough }), []));
    time.advance(FORGET_AFTER_MS - 1);
    gate.rechecked(gate.due(settings, readings({ [HOST.id]: enough }), []));
    expect(gate.hasWaiting()).toBe(true);
    time.advance(1);
    gate.rechecked(gate.due(settings, readings({ [HOST.id]: enough }), []));
    expect(gate.hasWaiting()).toBe(false);
  });
});
