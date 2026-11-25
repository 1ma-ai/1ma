import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { INSTRUCTIONS_MAX, MEMORY_MAX, NAME_MAX, ROLE_MAX } from "./src/limits.js";
import { INSTALLATION_OWNER, MIGRATIONS } from "./src/store.js";
import botsPlugin, {
  AUTO_COMPLETE_SCHEDULE,
  RECONCILE_SERVICE,
  UPKEEP_SCHEDULE,
} from "./server.js";

const BOTS = 1_000;
const CONVERSATIONS = 50_000;
const EACH = CONVERSATIONS / BOTS;
// What bb gives one plugin's instructions; it cuts the rest without a word.
const HOST_INSTRUCTIONS_MAX = 32_768;
const START = Date.parse("2026-11-14T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

const botId = (index: number) => `bot_${String(index).padStart(16, "0")}`;
const threadId = (bot: number, index: number) => `thr_${bot}_${index}`;

function setup() {
  const quiet = new Set<string>();
  const calls: string[] = [];
  const row = (id: string) =>
    makeThreadResponse({
      id,
      status: "idle",
      pinnedAt: null,
      queuedMessageCount: 0,
      updatedAt: quiet.has(id) ? START - 30 * DAY : START,
    });
  const host = createFakePluginHost({
    pluginId: "1ma-bots",
    agentSkillIds: ["1ma-bots"],
    settings: { autoCompleteHours: 72 },
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          calls.push("get");
          return row(threadId);
        },
        list: async (filter = {}) => {
          calls.push("list");
          expect(filter.threadIds?.length ?? 0).toBeLessThanOrEqual(200);
          return (filter.threadIds ?? []).map((id) => ({
            ...row(id),
            hasPendingInteraction: false,
            queuedWork: "none",
          }));
        },
        experimental_listAncestors: async ({ threadIds }) => {
          calls.push("ancestors");
          expect(threadIds.length).toBeLessThanOrEqual(200);
          return { threads: threadIds.map((threadId) => ({ threadId, ancestorIds: [] })) };
        },
        experimental_listDescendants: async ({ threadIds }) => {
          calls.push("descendants");
          expect(threadIds.length).toBeLessThanOrEqual(200);
          return { threads: threadIds.map((threadId) => ({ threadId, descendantIds: [] })) };
        },
        interactions: {
          list: async () => {
            calls.push("interactions");
            return [];
          },
        },
      },
    },
  });
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, MIGRATIONS);
  // Quotes count twice where bb's agents read the text.
  const longest = (length: number) => '"'.repeat(length);
  db.transaction(() => {
    const appearance = JSON.stringify({ shape: "circle", face: "calm", color: "#7c6cf0" });
    const bot = db.prepare(
      `INSERT INTO bots (owner_id, id, name, role, appearance, instructions, memory, position, created_at, updated_at)
       VALUES ('${INSTALLATION_OWNER}', ?, ?, ?, '${appearance}', ?, ?, ?, 1, 1)`,
    );
    const thread = db.prepare(
      `INSERT INTO bot_threads (owner_id, thread_id, bot_id, position, started_from_bot, completed_at, bound_at)
       VALUES ('${INSTALLATION_OWNER}', ?, ?, ?, 1, NULL, 1)`,
    );
    for (let i = 0; i < BOTS; i += 1) {
      bot.run(
        botId(i),
        longest(NAME_MAX),
        longest(ROLE_MAX),
        "i".repeat(INSTRUCTIONS_MAX),
        "m".repeat(MEMORY_MAX),
        i,
      );
      for (let j = 0; j < EACH; j += 1) thread.run(threadId(i, j), botId(i), j + 1);
    }
  })();
  botsPlugin(host.bb, () => START);
  const sql = { statements: 0 };
  const prepare = db.prepare.bind(db);
  db.prepare = ((source: string) => {
    const statement = prepare(source);
    for (const method of ["run", "get", "all"] as const) {
      const call = statement[method].bind(statement) as (...args: unknown[]) => unknown;
      statement[method] = ((...args: unknown[]) => {
        sql.statements += 1;
        return call(...args);
      }) as never;
    }
    return statement;
  }) as typeof db.prepare;
  const cost = async <T>(run: () => Promise<T>) => {
    sql.statements = 0;
    calls.length = 0;
    const result = await run();
    return { result, sql: sql.statements, calls: calls.length };
  };
  const rpc = (method: string, input: unknown) =>
    cost(async () => JSON.stringify(await host.harness.behavior.callRpc(method, input)));
  return { harness: host.harness, db, quiet, calls, cost, rpc };
}

describe("1000 bots and 50 000 conversations", () => {
  let t: ReturnType<typeof setup>;
  beforeAll(() => {
    t = setup();
  });
  const bot = botId(500);
  const thread = threadId(500, 7);

  // Characters of the answer, SQL statements, calls to bb.
  it.each<[string, unknown, number, number, number]>([
    ["bots.v1.list", {}, 650_000, 1, 0],
    ["bots.v1.forThread", { threadId: thread }, 100, 3, 0],
    [
      "bots.v1.forThreads",
      { keys: Array.from({ length: 200 }, (_, i) => threadId(i, 3)) },
      25_000,
      1,
      0,
    ],
    ["bots.v1.threads", { botId: bot }, 5_000, 3, 0],
    ["bots.v1.get", { botId: bot }, 21_000, 2, 0],
    ["bots.v1.instructions", { botId: bot }, HOST_INSTRUCTIONS_MAX * 1.5, 4, 0],
    ["bots.v1.mains", { keys: Array.from({ length: 200 }, (_, i) => botId(i)) }, 12_000, 205, 4],
    ["bots.v1.events", { botId: bot }, 100, 3, 0],
  ])("%s costs what its answer does", async (method, input, characters, statements, calls) => {
    const cost = await t.rpc(method, input);
    expect(cost.result.length).toBeLessThanOrEqual(characters);
    expect(cost.sql).toBeLessThanOrEqual(statements);
    expect(cost.calls).toBeLessThanOrEqual(calls);
  });

  it("an agent gets its whole instructions, and the rest of the bots by name", async () => {
    const { result, sql } = await t.cost(() =>
      t.harness.behavior.resolveAgentConfiguration(
        makePluginAgentConfigurationContext({ thread: { id: thread } }),
      ),
    );
    expect(sql).toBeLessThanOrEqual(6);
    expect(result.instructions!.length).toBeLessThanOrEqual(HOST_INSTRUCTIONS_MAX);
    expect(result.instructions).toContain("i".repeat(INSTRUCTIONS_MAX));
    expect(result.instructions).toContain("m".repeat(MEMORY_MAX));
    expect(result.instructions).toContain(botId(19));
    expect(result.instructions).not.toContain(botId(20));
    expect(result.instructions).toContain(`${BOTS - 1 - 20} more`);
    const found = JSON.parse(
      String(
        await t.harness.behavior.callAgentTool("bot_find", { query: '"""' }, { threadId: thread }),
      ),
    ) as { bots: unknown[]; total: number };
    expect(found.bots).toHaveLength(20);
    expect(found.total).toBe(BOTS - 1);
  });

  it("a write costs the same in a bot of 50 conversations and tells only what it changed", async () => {
    const before = t.harness.experimental_rpcInvalidations.length;
    const write = async (method: string, input: unknown, statements: number) =>
      expect((await t.rpc(method, input)).sql).toBeLessThanOrEqual(statements);
    const moved = threadId(500, 40);
    await write(
      "bots.v1.moveThreads",
      {
        botId: bot,
        sources: [{ threadId: moved, parentThreadId: null, real: true }],
        target: { threadId: thread, placement: "before", parentThreadId: null },
        levelShown: true,
      },
      10,
    );
    await write("bots.v1.assign", { threadId: moved, botId: botId(501), place: "first" }, 10);
    await write("bots.v1.setCompleted", { threadId: thread, completed: true }, 8);
    await write("bots.v1.setCompleted", { threadId: thread, completed: false }, 8);
    expect(
      t.harness.experimental_rpcInvalidations.slice(before).map((tags) => [...tags!].sort()),
    ).toEqual([
      [`conversations:${bot}`, `thread:${moved}`],
      [
        `conversations:${bot}`,
        `conversations:${botId(501)}`,
        `events:${botId(501)}`,
        `thread:${moved}`,
      ],
      [`conversations:${bot}`, `thread:${thread}`],
      [`conversations:${bot}`, `thread:${thread}`],
    ]);
  });

  it.each(["thread.active", "thread.idle", "thread.failed", "thread.deleted"] as const)(
    "%s of a conversation of no bot tells nothing",
    async (event) => {
      const before = t.harness.experimental_rpcInvalidations.length;
      const { sql } = await t.cost(async () => {
        await t.harness.behavior.emitThreadEvent(event, {
          thread: makeThreadResponse({ id: "thr_free" }),
          error: "boom",
          lastAssistantText: null,
        } as never);
      });
      expect(sql).toBeLessThanOrEqual(5);
      expect(t.harness.experimental_rpcInvalidations).toHaveLength(before);
    },
  );

  it("the command lists a page of bots and how many more there are", async () => {
    const { result, sql } = await t.cost(() => t.harness.behavior.runCli(["list"]));
    expect(sql).toBeLessThanOrEqual(2);
    expect(result.stdout.trimEnd().split("\n")).toHaveLength(201);
    expect(result.stdout).toContain("800 more");
  });

  it("auto-complete asks bb about pages, and about single conversations only before marking them", async () => {
    const pages = CONVERSATIONS / 200;
    const old = [threadId(10, 5), threadId(20, 6), threadId(999, 49)];
    for (const id of old) t.quiet.add(id);
    const { calls } = await t.cost(() => t.harness.behavior.runSchedule(AUTO_COMPLETE_SCHEDULE));
    // A list per page; for each page with a quiet conversation also the main
    // conversation (3 calls), the branches and the last look at it (3).
    expect(calls).toBeLessThanOrEqual(pages + old.length * 8);
    const members = JSON.parse((await t.rpc("bots.v1.forThreads", { keys: old })).result) as Record<
      string,
      { completed: boolean }
    >;
    expect(old.map((id) => members[id]!.completed)).toEqual([true, true, true]);
    t.quiet.clear();
    for (const id of old) await t.rpc("bots.v1.setCompleted", { threadId: id, completed: false });
  });

  it("looking for missed events asks bb about pages only", async () => {
    const { calls } = await t.cost(() => t.harness.behavior.runSchedule(UPKEEP_SCHEDULE));
    expect(calls).toBeLessThanOrEqual(CONVERSATIONS / 200 + 1);
    expect(new Set(t.calls)).toEqual(new Set(["list"]));
    const run = t.harness.behavior.runService(RECONCILE_SERVICE);
    run.controller.abort();
    await run.done;
  });

  it("removing a bot costs the same however many there are", async () => {
    const { sql } = await t.rpc("bots.v1.remove", { botId: botId(0) });
    expect(sql).toBeLessThanOrEqual(10);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM bot_threads").get()).toEqual({
      n: CONVERSATIONS - EACH,
    });
  });
});
