import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  RELEASED_LATE,
  REVIVED_KIND,
  UNKNOWN_AFTER_MS,
  UNKNOWN_KIND,
  WAIT_MS,
  revivedKind,
  runActions,
  unknownKind,
} from "./action-runner.js";
import { ActionStore, type SpawnParams } from "./actions.js";
import type { PluginSettings } from "./admission.js";
import {
  DefiniteSpawnFailure,
  type Executor,
  type SpawnRequest,
  type SpawnedThread,
  type ThreadMetadataRow,
} from "./observation.js";
import { QuestionStore } from "./questions.js";
import { repoPolicy } from "./repos.js";
import { MIGRATIONS } from "./schema.js";
import { createRemoteHttpExecutor } from "./executors/remote-http.js";
import { fakeExecutor } from "./test-helpers.js";

const params: SpawnParams = {
  projectId: "proj_app",
  providerId: "claude-code",
  model: "claude-opus-5-5",
  prompt: "Fix the flaky test, exactly as I said.",
  title: "Fix the flaky test",
  repo: "example/app",
};

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const actions = new ActionStore(db);
  const questions = new QuestionStore(db);
  let clock = 1_000_000;
  const spawned: SpawnRequest[] = [];
  const existing: Array<ThreadMetadataRow & Partial<SpawnedThread>> = [];
  const stopped: string[] = [];
  const stopping = { failures: 0 };
  const queues = new Map<string, number>();
  const reads: { onQueueRead?: (threadId: string) => void; statusFails?: boolean } = {};
  const target = { remote: "https://github.com/example/app.git", excluded: [] as string[] };
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
    findSpawned: async () =>
      existing.map((row) => ({
        projectId: "proj_app",
        createdAt: clock,
        status: "idle",
        queuedWork: "none",
        ...row,
      })),
    projectRemote: async () => target.remote,
    clearQueueAndStop: async (threadId) => {
      if (stopping.failures > 0) {
        stopping.failures -= 1;
        throw new TypeError("fetch failed");
      }
      stopped.push(threadId);
      queues.delete(threadId);
      return true;
    },
    queuedWaits: async (threadId) => {
      reads.onQueueRead?.(threadId);
      return Array.from({ length: queues.get(threadId) ?? 0 }, () => ({
        retry: false,
        waitingOn: null,
      }));
    },
    threadStatus: async (threadId) => {
      if (reads.statusFails) throw new TypeError("fetch failed");
      return existing.find((row) => row.threadId === threadId)?.status ?? "idle";
    },
  });
  const settingsOf = (active: boolean): PluginSettings => ({
    generation: 0,
    active,
    executors: new Map([["linux", executor]]),
    policy: repoPolicy(
      [{ repo: "example/app", accounts: { mac: [], linux: [] } }],
      target.excluded,
    ),
  });
  const run = (
    claimant = "gen_a",
    signal = new AbortController().signal,
    { active = true }: { active?: boolean } = {},
  ) =>
    runActions({
      actions,
      questions,
      read: settingsOf(active),
      settings: () => settingsOf(active),
      observed: new Map([["linux", "complete"]]),
      claimant,
      now: () => clock,
      signal,
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
    stopping,
    queues,
    reads,
    target,
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
  it("starts no action from an instance that is being turned off, and keeps a request in flight as unknown", async () => {
    const t = setup();
    const id = t.confirmed();
    const off = new AbortController();
    off.abort();
    await t.run("gen_old", off.signal);
    expect(t.spawned).toEqual([]);
    expect(t.actions.get(id)?.state).toBe("confirmed");

    const inFlight = new AbortController();
    t.setSpawn(
      (request) =>
        new Promise((_resolve, reject) => {
          t.existing.push({ threadId: "thr_maybe", metadata: { spawn: { ...request.label } } });
          inFlight.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    const running = t.run("gen_old", inFlight.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight.abort();
    await running;
    expect(t.actions.get(id)?.state).toBe("unknown");
  });

  it("binds a lost answer only to a chat with its secret label, in its project, created after the send", async () => {
    const t = setup();
    const id = t.confirmed();
    t.setSpawn(async () => {
      throw new TypeError("fetch failed: other side closed");
    });
    await t.run();
    const action = t.actions.get(id);
    if (action === null || action.sentAt === null) throw new Error("not sent");
    t.existing.push(
      { threadId: "thr_by_id", metadata: { spawn: { actionId: id, attempt: action.attempt } } },
      {
        threadId: "thr_other_project",
        metadata: { spawn: { nonce: action.label } },
        projectId: "proj_other",
      },
      {
        threadId: "thr_before",
        metadata: { spawn: { nonce: action.label } },
        createdAt: action.sentAt - 10 * 60 * 1000,
      },
    );
    await t.run();
    expect(t.actions.get(id)?.state).toBe("unknown");
    t.existing.push({ threadId: "thr_real", metadata: { spawn: { nonce: action.label } } });
    await t.run();
    expect(t.actions.get(id)).toMatchObject({ state: "bound", threadId: "thr_real" });
  });

  it("cancels a confirmed start whose project was excluded while its card was open", async () => {
    const t = setup();
    const id = t.confirmed();
    t.target.excluded.push("example/app");
    await t.run("gen_b");
    expect(t.spawned).toEqual([]);
    expect(t.actions.get(id)).toMatchObject({ state: "canceled" });
    expect(t.questions.waiting().map((question) => question.card.title)).toEqual([
      "Запуск чата отменён",
    ]);
  });

  it("cancels a confirmed start whose project now points at another repository", async () => {
    const t = setup();
    const id = t.confirmed();
    t.target.remote = "https://github.com/example/other.git";
    await t.run();
    expect(t.spawned).toEqual([]);
    expect(t.actions.get(id)?.state).toBe("canceled");
  });

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
    expect(t.questions.waiting()).toEqual([]);
    await t.run();
    expect(t.questions.waiting().map((item) => item.kind)).toEqual(["notice"]);
    await t.run();
    expect(t.stopped).toEqual(["thr_first_late"]);
  });

  function lateChat(t: ReturnType<typeof setup>) {
    const id = t.confirmed();
    t.setSpawn(async () => {
      throw new Error("timeout");
    });
    return (async () => {
      await t.run();
      const action = t.actions.get(id);
      if (action === null) throw new Error("no action");
      t.actions.transition(id, ["unknown"], "canceled", t.now(), { result: "replaced" });
      const chat: { threadId: string; metadata: unknown; status?: string; queuedWork?: string } = {
        threadId: "thr_late",
        metadata: { spawn: { nonce: action.label } },
      };
      t.existing.push(chat);
      return { id, chat };
    })();
  }

  const titles = (t: ReturnType<typeof setup>) =>
    t.questions.waiting().map((item) => item.card.title);

  it("says nothing about a stop when the chat started running while its queue was read", async () => {
    const t = setup();
    const { id, chat } = await lateChat(t);
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopping late");
    t.reads.onQueueRead = () => {
      chat.status = "active";
    };
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopping late");
    expect(titles(t)).toEqual([]);
    t.reads.onQueueRead = undefined;
    const stops = t.stopped.length;
    await t.run();
    expect(t.stopped.length).toBe(stops + 1);
    expect(t.actions.get(id)?.result).toBe("stopping late");
  });

  it("confirms no stop when the chat's status cannot be read after its queue", async () => {
    const t = setup();
    const { id } = await lateChat(t);
    await t.run();
    t.reads.statusFails = true;
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopping late");
    expect(titles(t)).toEqual([]);
  });

  it("confirms a stop once when the chat is idle before and after its empty queue was read", async () => {
    const t = setup();
    const { id } = await lateChat(t);
    await t.run();
    await t.run();
    await t.run();
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopped late");
    expect(titles(t)).toEqual(["Отменённый чат всё-таки создан"]);
  });

  it("keeps stopping a late chat until it is seen stopped", async () => {
    const t = setup();
    const { id, chat } = await lateChat(t);
    chat.status = "active";
    t.stopping.failures = 1;
    await t.run();
    expect(t.stopped).toEqual([]);
    expect(t.actions.get(id)).toMatchObject({ threadId: null, result: "replaced" });
    expect(titles(t)).toEqual(["Отменённый чат создан, остановить пока не удалось"]);
    await t.run();
    expect(t.stopped).toEqual(["thr_late"]);
    expect(t.actions.get(id)?.result).toBe("stopping late");
    chat.status = "idle";
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopped late");
    await t.run();
    expect(t.stopped).toEqual(["thr_late"]);
  });

  it("stops a late chat again whenever it runs or has a queue after it was seen stopped, and tells the owner", async () => {
    const t = setup();
    const { id, chat } = await lateChat(t);
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopping late");
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopped late");
    for (const question of t.questions.waiting()) t.questions.cancel(question.key);

    chat.status = "active";
    await t.run();
    expect(t.stopped).toEqual(["thr_late", "thr_late"]);
    expect(t.actions.get(id)).toMatchObject({ state: "canceled", result: "stopping late" });
    expect(titles(t)).toEqual(["Остановленный чат отменённого запуска снова ожил"]);

    chat.status = "idle";
    t.queues.set("thr_late", 1);
    await t.run();
    expect(t.stopped).toEqual(["thr_late", "thr_late", "thr_late"]);
    expect(titles(t)).toEqual(["Остановленный чат отменённого запуска снова ожил"]);

    await t.run();
    await t.run();
    expect(t.stopped).toEqual(["thr_late", "thr_late", "thr_late"]);
    expect(t.actions.get(id)?.result).toBe("stopped late");
  });

  it("never stops a late chat again after the owner chose to keep it", async () => {
    const t = setup();
    const { id, chat } = await lateChat(t);
    await t.run();
    await t.run();
    for (const question of t.questions.waiting()) t.questions.cancel(question.key);
    chat.status = "active";
    await t.run();
    const card = t.questions
      .waiting()
      .find((item) => item.card.title === "Остановленный чат отменённого запуска снова ожил");
    if (card === undefined) throw new Error("no revived card");
    expect(card.card.options.map((option) => [option.id, option.label])).toEqual([
      ["ok", "Понятно"],
      ["keep", "Оставить этот чат"],
    ]);
    t.questions.markOpen(card.id, "thr_bot", "tok", t.now());
    expect(
      t.questions.answer(
        card.id,
        "tok",
        "keep",
        new Map([[REVIVED_KIND, revivedKind(t.actions)]]),
        t.now(),
      ),
    ).toBe("applied");
    const before = t.stopped.length;
    await t.run();
    await t.run();
    chat.status = "idle";
    t.queues.set("thr_late", 1);
    await t.run();
    expect(t.stopped).toHaveLength(before);
    expect(t.actions.get(id)?.result).toBe("kept by the owner");
    expect(t.questions.waiting().filter((item) => item.kind === REVIVED_KIND)).toEqual([]);
  });

  it("confirms no stop from an empty queue summary while the full queue still holds a message", async () => {
    const t = setup();
    const { id } = await lateChat(t);
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopping late");
    t.queues.set("thr_late", 1);
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopping late");
    expect(t.stopped).toEqual(["thr_late", "thr_late"]);
    expect(titles(t)).toEqual([]);
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopped late");
    expect(titles(t)).toEqual(["Отменённый чат всё-таки создан"]);
  });

  it("confirms no stop that was never sent after the first attempt failed", async () => {
    const t = setup();
    const { id } = await lateChat(t);
    t.stopping.failures = 1;
    await t.run();
    expect(t.stopped).toEqual([]);
    await t.run();
    expect(t.stopped).toEqual(["thr_late"]);
    expect(t.actions.get(id)?.result).toBe("stopping late");
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopped late");
  });

  it("clears a stopped chat's new queue without saying it came back while it is not running", async () => {
    const t = setup();
    const { id, chat } = await lateChat(t);
    await t.run();
    await t.run();
    expect(t.actions.get(id)?.result).toBe("stopped late");
    for (const question of t.questions.waiting()) t.questions.cancel(question.key);
    chat.queuedWork = "waiting";
    t.queues.set("thr_late", 1);
    await t.run();
    expect(t.stopped).toEqual(["thr_late", "thr_late"]);
    expect(t.actions.get(id)?.result).toBe("stopped late");
    expect(t.questions.waiting()).toEqual([]);
  });

  it("stops a revived chat again when the owner only acknowledges the card", async () => {
    const t = setup();
    const { chat } = await lateChat(t);
    await t.run();
    await t.run();
    for (const question of t.questions.waiting()) t.questions.cancel(question.key);
    chat.status = "active";
    await t.run();
    const card = t.questions
      .waiting()
      .find((item) => item.card.title === "Остановленный чат отменённого запуска снова ожил");
    if (card === undefined) throw new Error("no revived card");
    t.questions.markOpen(card.id, "thr_bot", "tok", t.now());
    t.questions.answer(
      card.id,
      "tok",
      "ok",
      new Map([[REVIVED_KIND, revivedKind(t.actions)]]),
      t.now(),
    );
    const before = t.stopped.length;
    await t.run();
    expect(t.stopped).toHaveLength(before + 1);
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

const remoteThread = (id: string, status: string) => ({
  id,
  projectId: "proj_app",
  environmentId: null,
  title: null,
  titleFallback: null,
  providerId: "claude-code",
  status,
  visibility: "visible",
  parentThreadId: null,
  originPluginId: "1ma-superagent",
  createdAt: 1_000_000,
  updatedAt: 1_000_000,
  queuedWork: "waiting",
  hasPendingInteraction: false,
});

describe("admission of changes made by a pass", () => {
  function lateRun(hooks: {
    readonly onQueueRead?: () => void;
    readonly onDelete?: () => Promise<void>;
    readonly onMetadata?: () => void;
  }) {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const actions = new ActionStore(db);
    const questions = new QuestionStore(db);
    const action = actions.propose("linux", params, "thr_bot", 1_000_000);
    actions.transition(action.id, ["proposed"], "confirmed", 1_000_000);
    actions.claim(action.id, "gen_a", 1_000_000);
    actions.transition(action.id, ["sending"], "unknown", 1_000_000);
    const settings = { generation: 0, active: true };
    const requests: string[] = [];
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: async (url, { method }) => {
        const path = new URL(url).pathname;
        requests.push(`${method} ${path}`);
        if (path === "/api/v1/threads") return Response.json([remoteThread("thr_late", "active")]);
        if (path.endsWith("/plugin-metadata")) {
          hooks.onMetadata?.();
          return Response.json({
            threads: [{ threadId: "thr_late", metadata: { spawn: { nonce: action.label } } }],
          });
        }
        if (method === "GET" && path.endsWith("/queued-messages")) {
          hooks.onQueueRead?.();
          return Response.json([{ id: "queued_1", payload: { kind: "inline" }, waitingOn: null }]);
        }
        if (method === "DELETE") await hooks.onDelete?.();
        return Response.json({});
      },
    });
    const current = (): PluginSettings => ({
      ...settings,
      executors: new Map([["linux", executor]]),
      policy: repoPolicy([{ repo: "example/app", accounts: { mac: [], linux: [] } }], []),
    });
    const read = current();
    const run = () =>
      runActions({
        actions,
        questions,
        read,
        settings: current,
        observed: new Map([["linux", "complete"]]),
        claimant: "gen_a",
        now: () => 1_000_000 + UNKNOWN_AFTER_MS,
        signal: new AbortController().signal,
        warn: () => {},
      });
    const changes = () =>
      requests.filter(
        (request) => !request.startsWith("GET") && !request.endsWith("/plugin-metadata"),
      );
    return { actions, questions, action, settings, run, changes };
  }

  it("deletes nothing and stops nothing when the settings change while the late chat's queue is read", async () => {
    const t = lateRun({
      onQueueRead: () => {
        t.settings.generation = 1;
      },
    });
    t.actions.transition(t.action.id, ["unknown"], "canceled", 1_000_000, { result: "replaced" });
    await t.run();
    expect(t.changes()).toEqual([]);
    expect(t.actions.get(t.action.id)).toMatchObject({ threadId: null, result: "replaced" });
  });

  it("sends no stop when the settings change while a queued message is being deleted", async () => {
    const t = lateRun({
      onDelete: async () => {
        t.settings.generation = 1;
      },
    });
    t.actions.transition(t.action.id, ["unknown"], "canceled", 1_000_000, { result: "replaced" });
    await t.run();
    expect(t.changes()).toEqual(["DELETE /api/v1/threads/thr_late/queued-messages/queued_1"]);
  });

  it("binds no chat found under settings that changed while spawned chats were read", async () => {
    const t = lateRun({
      onMetadata: () => {
        t.settings.generation = 1;
      },
    });
    await t.run();
    expect(t.actions.get(t.action.id)).toMatchObject({ state: "unknown", threadId: null });
    expect(t.questions.waiting()).toEqual([]);
  });

  it("sends nothing while the plugin is switched off or is an executor", async () => {
    const t = setup();
    const id = t.confirmed();
    await t.run("gen_a", new AbortController().signal, { active: false });
    expect(t.spawned).toEqual([]);
    expect(t.actions.get(id)?.state).toBe("confirmed");
  });
});

describe("a spawn over HTTP whose answer is an error", () => {
  it("binds the chat found by its label after an error answer, without a second request", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const actions = new ActionStore(db);
    const questions = new QuestionStore(db);
    const action = actions.propose("linux", params, "thr_bot", 1_000_000);
    actions.transition(action.id, ["proposed"], "confirmed", 1_000_000);
    const posts: string[] = [];
    let created = false;
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: async (url, { method, body }) => {
        const path = new URL(url).pathname;
        if (path === "/api/v1/projects/proj_app")
          return Response.json({ id: "proj_app", gitRemoteUrl: "https://github.com/example/app" });
        if (method === "POST" && path === "/api/v1/threads") {
          posts.push(body ?? "");
          created = true;
          return Response.json(
            { code: "project_not_found", message: "Project not found", retryable: false },
            { status: 404 },
          );
        }
        if (path === "/api/v1/threads")
          return Response.json(created ? [remoteThread("thr_new", "idle")] : []);
        if (path.endsWith("/plugin-metadata"))
          return Response.json({
            threads: created
              ? [{ threadId: "thr_new", metadata: { spawn: { nonce: action.label } } }]
              : [],
          });
        return Response.json([]);
      },
    });
    const current = (): PluginSettings => ({
      generation: 0,
      active: true,
      executors: new Map([["linux", executor]]),
      policy: repoPolicy([{ repo: "example/app", accounts: { mac: [], linux: [] } }], []),
    });
    const run = (now: number) =>
      runActions({
        actions,
        questions,
        read: current(),
        settings: current,
        observed: new Map([["linux", "complete"]]),
        claimant: "gen_a",
        now: () => now,
        signal: new AbortController().signal,
        warn: () => {},
      });
    await run(1_000_000);
    expect(actions.get(action.id)).toMatchObject({ state: "bound", threadId: "thr_new" });
    await run(1_000_000 + UNKNOWN_AFTER_MS);
    expect(actions.get(action.id)).toMatchObject({ state: "bound", threadId: "thr_new" });
    expect(posts).toHaveLength(1);
  });
});

describe("a stop answered before the chat stopped", () => {
  it("reports a late chat stopped only once a later observation shows it idle with an empty queue", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const actions = new ActionStore(db);
    const questions = new QuestionStore(db);
    const action = actions.propose("linux", params, "thr_bot", 1_000_000);
    actions.transition(action.id, ["proposed"], "confirmed", 1_000_000);
    actions.claim(action.id, "gen_a", 1_000_000);
    actions.transition(action.id, ["sending"], "unknown", 1_000_000);
    actions.transition(action.id, ["unknown"], "canceled", 1_000_000, { result: "replaced" });
    const thread = { ...remoteThread("thr_late", "active"), queuedWork: "none" };
    const stops: string[] = [];
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: async (url, { method }) => {
        const path = new URL(url).pathname;
        if (path === "/api/v1/threads") return Response.json([thread]);
        if (path.endsWith("/plugin-metadata"))
          return Response.json({
            threads: [{ threadId: "thr_late", metadata: { spawn: { nonce: action.label } } }],
          });
        if (path.endsWith("/queued-messages")) return Response.json([]);
        if (method === "POST" && path.endsWith("/stop")) {
          stops.push(path);
          return Response.json({ ok: true });
        }
        if (path.endsWith("/thr_late")) return Response.json(thread);
        throw new Error(`unexpected ${method} ${path}`);
      },
    });
    const settings = (): PluginSettings => ({
      generation: 0,
      active: true,
      executors: new Map([["linux", executor]]),
      policy: repoPolicy([], []),
    });
    const run = () =>
      runActions({
        actions,
        questions,
        read: settings(),
        settings,
        observed: new Map([["linux", "complete"]]),
        claimant: "gen_a",
        now: () => 1_000_000 + 1_000,
        signal: new AbortController().signal,
        warn: () => {},
      });
    const titles = () => questions.waiting().map((question) => question.card.title);
    await run();
    expect(stops).toHaveLength(1);
    expect(actions.get(action.id)?.result).toBe("stopping late");
    expect(titles()).toEqual([]);
    thread.status = "idle";
    await run();
    expect(actions.get(action.id)?.result).toBe("stopped late");
    expect(titles()).toEqual(["Отменённый чат всё-таки создан"]);
    await run();
    expect(stops).toHaveLength(1);
    expect(titles()).toEqual(["Отменённый чат всё-таки создан"]);
  });
});

describe("the owner's Keep this chat during a pass", () => {
  function keepRace() {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const actions = new ActionStore(db);
    const questions = new QuestionStore(db);
    const kinds = new Map([[REVIVED_KIND, revivedKind(actions)]]);
    const action = actions.propose("linux", params, "thr_bot", 1_000_000);
    actions.transition(action.id, ["proposed"], "confirmed", 1_000_000);
    actions.claim(action.id, "gen_a", 1_000_000);
    actions.transition(action.id, ["sending"], "canceled", 1_000_000, {
      threadId: "thr_late",
      result: "stopped late",
    });
    const thread = { ...remoteThread("thr_late", "active"), queuedWork: "none" };
    const hooks: {
      onMetadata?: () => void;
      onQueueRead?: () => void;
      onDelete?: (path: string) => void | Promise<void>;
      onStop?: () => Promise<void>;
    } = {};
    let queued = [{ id: "queued_1" }, { id: "queued_2" }];
    const changes: string[] = [];
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: async (url, { method }) => {
        const path = new URL(url).pathname;
        if (path === "/api/v1/threads") return Response.json([thread]);
        if (path.endsWith("/plugin-metadata")) {
          hooks.onMetadata?.();
          return Response.json({
            threads: [{ threadId: "thr_late", metadata: { spawn: { nonce: action.label } } }],
          });
        }
        if (method === "GET" && path.endsWith("/queued-messages")) {
          hooks.onQueueRead?.();
          return Response.json(queued);
        }
        changes.push(`${method} ${path}`);
        if (method === "DELETE") await hooks.onDelete?.(path);
        if (path.endsWith("/stop")) await hooks.onStop?.();
        return Response.json({});
      },
    });
    const settings = (): PluginSettings => ({
      generation: 0,
      active: true,
      executors: new Map([["linux", executor]]),
      policy: repoPolicy([], []),
    });
    const run = () =>
      runActions({
        actions,
        questions,
        read: settings(),
        settings,
        observed: new Map([["linux", "complete"]]),
        claimant: "gen_a",
        now: () => 1_000_000 + 1_000,
        signal: new AbortController().signal,
        warn: () => {},
      });
    const keep = () => {
      const card = questions.waiting().find((question) => question.kind === REVIVED_KIND);
      if (card === undefined) throw new Error("no revived card");
      questions.markOpen(card.id, "thr_bot", "token_keep", 1_000_000);
      expect(questions.answer(card.id, "token_keep", "keep", kinds, 1_000_000)).toBe("applied");
    };
    const result = () => actions.get(action.id)?.result;
    const reset = (rows: Array<{ id: string }>) => {
      changes.length = 0;
      queued = rows;
    };
    return { questions, thread, hooks, changes, run, keep, result, reset };
  }

  function held() {
    let release = () => {};
    let entered = () => {};
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    return {
      reached,
      release,
      wait: () => {
        entered();
        return gate;
      },
    };
  }

  it("sends no second delete once the owner keeps the chat while the first is still unanswered", async () => {
    const t = keepRace();
    await t.run();
    t.reset([{ id: "queued_3" }, { id: "queued_4" }]);
    const first = held();
    t.hooks.onDelete = (path) => (path.endsWith("/queued_3") ? first.wait() : undefined);
    const pass = t.run();
    await first.reached;
    t.keep();
    first.release();
    await pass;
    expect({ changes: t.changes, result: t.result() }).toEqual({
      changes: ["DELETE /api/v1/threads/thr_late/queued-messages/queued_3"],
      result: "kept by the owner",
    });
    expect(t.questions.waiting()).toEqual([]);
  });

  it("keeps the owner's choice and asks nothing when a stop sent before it answers after it", async () => {
    const t = keepRace();
    await t.run();
    t.reset([]);
    const stop = held();
    t.hooks.onStop = stop.wait;
    const pass = t.run();
    await stop.reached;
    t.keep();
    stop.release();
    await pass;
    expect({ changes: t.changes, result: t.result() }).toEqual({
      changes: ["POST /api/v1/threads/thr_late/stop"],
      result: "kept by the owner",
    });
    expect(t.questions.waiting()).toEqual([]);
  });

  it("sends nothing to a second chat of the action once the owner keeps it while the first is being stopped", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const actions = new ActionStore(db);
    const questions = new QuestionStore(db);
    const action = actions.propose("linux", params, "thr_bot", 1_000_000);
    actions.transition(action.id, ["proposed"], "confirmed", 1_000_000);
    actions.claim(action.id, "gen_a", 1_000_000);
    actions.transition(action.id, ["sending"], "canceled", 1_000_000, {
      threadId: "thr_one",
      result: "stopping late",
    });
    const first = held();
    const requested: string[] = [];
    const executor = fakeExecutor("linux", {
      findSpawned: async () =>
        ["thr_one", "thr_two"].map((threadId) => ({
          threadId,
          metadata: { spawn: { nonce: action.label } },
          projectId: "proj_app",
          createdAt: 1_000_000,
          status: "active",
          queuedWork: "none",
        })),
      clearQueueAndStop: async (threadId, admitted) => {
        requested.push(threadId);
        if (threadId === "thr_one") await first.wait();
        return admitted();
      },
    });
    const settings = (): PluginSettings => ({
      generation: 0,
      active: true,
      executors: new Map([["linux", executor]]),
      policy: repoPolicy([], []),
    });
    const pass = runActions({
      actions,
      questions,
      read: settings(),
      settings,
      observed: new Map([["linux", "complete"]]),
      claimant: "gen_a",
      now: () => 1_000_000 + 1_000,
      signal: new AbortController().signal,
      warn: () => {},
    });
    await first.reached;
    actions.transition(action.id, ["canceled"], "canceled", 1_000_500, { result: RELEASED_LATE });
    first.release();
    await pass;
    expect(requested).toEqual(["thr_one"]);
    expect(actions.get(action.id)?.result).toBe(RELEASED_LATE);
    expect(questions.waiting()).toEqual([]);
  });

  it("deletes and stops nothing once the owner keeps the chat while its queue is read", async () => {
    const t = keepRace();
    await t.run();
    expect(t.result()).toBe("stopping late");
    t.reset([{ id: "queued_3" }]);
    t.hooks.onQueueRead = t.keep;
    await t.run();
    expect({ changes: t.changes, result: t.result() }).toEqual({
      changes: [],
      result: "kept by the owner",
    });
  });

  it("sends no further delete and no stop once the owner keeps the chat between two deletes", async () => {
    const t = keepRace();
    await t.run();
    t.reset([{ id: "queued_3" }, { id: "queued_4" }]);
    t.hooks.onDelete = (path) => {
      if (path.endsWith("/queued_3")) t.keep();
    };
    await t.run();
    expect({ changes: t.changes, result: t.result() }).toEqual({
      changes: ["DELETE /api/v1/threads/thr_late/queued-messages/queued_3"],
      result: "kept by the owner",
    });
  });

  it("does not confirm a stop over the owner's keep recorded while the chats were read", async () => {
    const t = keepRace();
    await t.run();
    t.thread.status = "idle";
    t.reset([]);
    t.hooks.onMetadata = t.keep;
    await t.run();
    expect(t.result()).toBe("kept by the owner");
    expect(t.questions.waiting().map((question) => question.kind)).toEqual([]);
  });
});
