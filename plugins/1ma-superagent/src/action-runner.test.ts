import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_AFTER_MS,
  UNKNOWN_KIND,
  WAIT_MS,
  runActions,
  unknownKind,
} from "./action-runner.js";
import { ActionStore, type SpawnParams } from "./actions.js";
import {
  DefiniteSpawnFailure,
  type Executor,
  type SpawnRequest,
  type ThreadMetadataRow,
} from "./observation.js";
import { QuestionStore } from "./questions.js";
import { MIGRATIONS } from "./schema.js";
import { fakeExecutor } from "./test-helpers.js";

const params: SpawnParams = {
  projectId: "proj_app",
  providerId: "claude-code",
  model: "claude-opus-5-5",
  prompt: "Fix the flaky test, exactly as I said.",
  title: "Fix the flaky test",
};

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const actions = new ActionStore(db);
  const questions = new QuestionStore(db);
  let clock = 1_000_000;
  const spawned: SpawnRequest[] = [];
  const existing: ThreadMetadataRow[] = [];
  const stopped: string[] = [];
  let spawnBehavior: (request: SpawnRequest) => Promise<{ threadId: string }> = async (request) => {
    const threadId = `thr_${spawned.length}`;
    existing.push({ threadId, metadata: { spawn: { ...request.label } } });
    return { threadId };
  };
  const executor: Executor = fakeExecutor("linux", {
    spawn: async (request) => {
      spawned.push(request);
      return spawnBehavior(request);
    },
    findSpawned: async () => [...existing],
    clearQueueAndStop: async (threadId) => {
      stopped.push(threadId);
    },
  });
  const run = (claimant = "gen_a") =>
    runActions({
      actions,
      questions,
      executors: new Map([["linux", executor]]),
      observed: new Map([["linux", "complete"]]),
      claimant,
      now: () => clock,
      signal: new AbortController().signal,
      warn: () => {},
    });
  const confirmed = () => {
    const action = actions.propose("linux", params, "thr_bot", clock);
    actions.transition(action.id, ["proposed"], "confirmed", clock);
    return action.id;
  };
  return {
    actions,
    questions,
    run,
    confirmed,
    spawned,
    existing,
    stopped,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    setSpawn: (behavior: typeof spawnBehavior) => {
      spawnBehavior = behavior;
    },
  };
}

describe("spawn actions", () => {
  it("creates exactly one chat for a confirmed action, even with two runners at once", async () => {
    const t = setup();
    const id = t.confirmed();
    await Promise.all([t.run("gen_a"), t.run("gen_b")]);
    await t.run("gen_a");
    expect(t.spawned).toHaveLength(1);
    expect(t.actions.get(id)).toMatchObject({ state: "bound", threadId: "thr_1" });
  });

  it("does nothing with a proposal the owner has not confirmed", async () => {
    const t = setup();
    t.actions.propose("linux", params, "thr_bot", t.now());
    await t.run();
    expect(t.spawned).toEqual([]);
  });

  it("finds a chat whose creation answer was lost instead of creating a second one", async () => {
    const t = setup();
    const id = t.confirmed();
    t.setSpawn(async (request) => {
      t.existing.push({ threadId: "thr_lost", metadata: { spawn: { ...request.label } } });
      throw new TypeError("fetch failed: other side closed");
    });
    await t.run();
    expect(t.actions.get(id)).toMatchObject({
      state: "bound",
      threadId: "thr_lost",
      result: expect.stringContaining("other side closed"),
    });
    await t.run();
    expect(t.spawned).toHaveLength(1);
  });

  it("binds a chat that appears only after the first empty read, without a retry", async () => {
    const t = setup();
    const id = t.confirmed();
    let late: SpawnRequest | null = null;
    t.setSpawn(async (request) => {
      late = request;
      throw new Error("timeout");
    });
    await t.run();
    await t.run();
    expect(t.actions.get(id)?.state).toBe("unknown");
    if (late === null) throw new Error("no request");
    t.existing.push({
      threadId: "thr_late",
      metadata: { spawn: { ...(late as SpawnRequest).label } },
    });
    await t.run();
    expect(t.actions.get(id)).toMatchObject({ state: "bound", threadId: "thr_late" });
    expect(t.spawned).toHaveLength(1);
  });

  it("binds neither of two chats with one label and asks the owner", async () => {
    const t = setup();
    const id = t.confirmed();
    t.setSpawn(async (request) => {
      t.existing.push({ threadId: "thr_a", metadata: { spawn: { ...request.label } } });
      t.existing.push({ threadId: "thr_b", metadata: { spawn: { ...request.label } } });
      throw new Error("timeout");
    });
    await t.run();
    await t.run();
    expect(t.actions.get(id)).toMatchObject({ state: "ambiguous", threadId: null });
    expect(t.questions.waiting().map((question) => question.kind)).toEqual(["ambiguous_spawn"]);
  });

  it("fails without a retry when the server says the chat was not created", async () => {
    const t = setup();
    const id = t.confirmed();
    t.setSpawn(async () => {
      throw new DefiniteSpawnFailure("POST /threads answered 400");
    });
    await t.run();
    await t.run();
    expect(t.actions.get(id)?.state).toBe("failed");
    expect(t.spawned).toHaveLength(1);
  });

  it("treats a send another plugin generation left half-way as unknown", async () => {
    const t = setup();
    const id = t.confirmed();
    t.actions.claim(id, "gen_old", t.now());
    await t.run("gen_new");
    expect(t.actions.get(id)?.state).toBe("unknown");
    expect(t.spawned).toEqual([]);
  });

  it("escalates after ten minutes, waits on request, and on a relaunch stops a first chat that appears later", async () => {
    const t = setup();
    const id = t.confirmed();
    let first: SpawnRequest | null = null;
    t.setSpawn(async (request) => {
      first = request;
      throw new Error("timeout");
    });
    await t.run();
    t.advance(UNKNOWN_AFTER_MS - 1);
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
    t.advance(1);
    await t.run();
    const [question] = t.questions.waiting();
    expect(question).toMatchObject({ kind: UNKNOWN_KIND });
    expect(question?.card.options.map((option) => [option.id, option.recommended])).toEqual([
      ["wait", true],
      ["retry", false],
    ]);
    const kinds = new Map([[UNKNOWN_KIND, unknownKind(t.actions)]]);
    if (question === undefined) throw new Error("no question");
    t.questions.markOpen(question.id, "thr_bot", "tok", t.now());
    expect(t.questions.answer(question.id, "tok", "wait", kinds, t.now())).toBe("applied");
    expect(t.actions.get(id)?.remindAt).toBe(t.now() + WAIT_MS);
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
    expect(t.spawned).toHaveLength(1);

    t.advance(WAIT_MS);
    await t.run();
    const [again] = t.questions.waiting();
    if (again === undefined) throw new Error("no second question");
    t.questions.markOpen(again.id, "thr_bot", "tok2", t.now());
    expect(t.questions.answer(again.id, "tok2", "retry", kinds, t.now())).toBe("applied");
    t.setSpawn(async (request) => {
      t.existing.push({ threadId: "thr_second", metadata: { spawn: { ...request.label } } });
      return { threadId: "thr_second" };
    });
    await t.run();
    expect(t.spawned).toHaveLength(2);
    expect(t.actions.get(id)).toMatchObject({ state: "canceled", result: "replaced" });

    if (first === null) throw new Error("no first request");
    t.existing.push({
      threadId: "thr_first_late",
      metadata: { spawn: { ...(first as SpawnRequest).label } },
    });
    await t.run();
    expect(t.stopped).toEqual(["thr_first_late"]);
    expect(t.questions.waiting().map((item) => item.kind)).toEqual(["notice"]);
    await t.run();
    expect(t.stopped).toEqual(["thr_first_late"]);
  });
});

describe("ActionStore.claim", () => {
  it("lets exactly one handler take a confirmed action", () => {
    const t = setup();
    const id = t.confirmed();
    expect(t.actions.claim(id, "gen_a", t.now())).toBe(true);
    expect(t.actions.claim(id, "gen_b", t.now())).toBe(false);
    expect(t.actions.get(id)).toMatchObject({ state: "sending", claimedBy: "gen_a" });
  });

  it("does not let a proposal be taken before the owner confirms it", () => {
    const t = setup();
    const action = t.actions.propose("linux", params, "thr_bot", t.now());
    expect(t.actions.claim(action.id, "gen_a", t.now())).toBe(false);
  });
});
