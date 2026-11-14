import { describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeMessageDispatchHookContext,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import type { BotDetail } from "./src/contract.js";
import botsPlugin, { AUTO_COMPLETE_SCHEDULE } from "./server.js";

const START = Date.parse("2026-11-14T10:00:00Z");

function setup(settings: Record<string, number> = {}) {
  let clock = START;
  let nextThread = 100;
  const threads = new Map<string, ReturnType<typeof makeThreadResponse>>();
  const host = createFakePluginHost({
    pluginId: "1ma-bots",
    agentSkillIds: ["1ma-bots"],
    settings,
    sdk: {
      threads: {
        send: async () => ({ kind: "queued" }),
        spawn: async () => ({ id: `thr_new${nextThread++}` }),
        fork: async () => ({ id: `thr_fork${nextThread++}` }),
        get: async ({ threadId }: { threadId: string }) =>
          threads.get(threadId) ?? makeThreadResponse({ id: threadId }),
        interactions: { list: async () => [] },
      },
    },
  });
  botsPlugin(host.bb, () => clock);
  const { harness } = host;
  const rpc = <T>(method: string, input: unknown = {}) =>
    harness.behavior.callRpc(method, input) as Promise<T>;
  const create = (name: string, extra: Record<string, unknown> = {}) =>
    rpc<BotDetail>("bots.v1.create", { name, ...extra });
  const assign = (threadId: string, botId: string | null) =>
    rpc("bots.v1.assign", { threadId, botId });
  const configure = (threadId: string, pluginMetadata: Record<string, string> = {}) =>
    harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ thread: { id: threadId }, pluginMetadata }),
    );
  const letter = (fromThreadId: string, to: string, threadId?: string) =>
    harness.behavior.callAgentTool(
      "bot_message",
      { to, text: "Please check the landing copy", ...(threadId ? { threadId } : {}) },
      { threadId: fromThreadId },
    );
  const dispatch = (threadId: string, initiator: "user" | "agent", senderThreadId: string | null) =>
    harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({ thread: { id: threadId }, initiator, senderThreadId }),
    );
  const list = () =>
    rpc<{
      bots: Array<{
        id: string;
        threads: Array<{ threadId: string; completed: boolean; startedFromBot: boolean }>;
      }>;
    }>("bots.v1.list");
  return {
    harness,
    rpc,
    create,
    assign,
    configure,
    letter,
    dispatch,
    list,
    threads,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

async function threeBots() {
  const t = setup({ chainLetters: 4 });
  const a = await t.create("Alpha");
  const b = await t.create("Beta");
  const c = await t.create("Gamma");
  await t.assign("thr_a", a.id);
  await t.assign("thr_b", b.id);
  await t.assign("thr_c", c.id);
  return { ...t, a, b, c };
}

describe("the superagent seam", () => {
  it("forThread returns exactly the bot id and work areas, or null", async () => {
    const t = setup();
    const bot = await t.create("Main", { capabilities: ["dev", "marketing"] });
    await t.assign("thr_main", bot.id);
    expect(await t.rpc("bots.v1.forThread", { threadId: "thr_main" })).toStrictEqual({
      botId: bot.id,
      capabilities: ["dev", "marketing"],
    });
    expect(await t.rpc("bots.v1.forThread", { threadId: "thr_other" })).toBeNull();
  });

  it("a conversation started from the bot is created by this plugin and bound before its first turn", async () => {
    const t = setup();
    const bot = await t.create("Main");
    let configuredDuringSpawn: Awaited<ReturnType<typeof t.configure>> | null = null;
    t.harness.sdk.stub(
      "threads.spawn",
      async (args: { pluginMetadata: Record<string, string> }) => {
        configuredDuringSpawn = await t.configure("thr_started", args.pluginMetadata);
        return { id: "thr_started" };
      },
    );
    await t.rpc("bots.v1.startThread", {
      botId: bot.id,
      request: { projectId: "proj_1", input: [], originPluginId: "someone-else" },
    });
    const [args] = t.harness.sdk.callsTo("threads.spawn")[0] as [Record<string, unknown>];
    expect(args.originPluginId).toBe("1ma-bots");
    expect(args.pluginMetadata).toEqual({ startToken: expect.any(String) });
    expect(configuredDuringSpawn!.instructions).toContain('You are the bot "Main"');
    const [listed] = (await t.list()).bots;
    expect(listed!.threads).toEqual([
      { threadId: "thr_started", startedFromBot: true, completed: false },
    ]);
  });

  it("a stale start token does not bind a conversation", async () => {
    const t = setup();
    await t.create("Main");
    expect((await t.configure("thr_x", { startToken: "made-up" })).tools).toEqual([]);
  });
});

describe("an old conversation bound to a bot", () => {
  it("gets the bot's instructions and tools but is marked as not started from the bot", async () => {
    const t = setup();
    const bot = await t.create("Marketer", { instructions: "Write landing copy." });
    expect(await t.assign("thr_old", bot.id)).toEqual({ botId: bot.id, startedFromBot: false });
    const config = await t.configure("thr_old");
    expect(config.tools.map((tool) => tool.name).sort()).toEqual([
      "bot_memory_update",
      "bot_message",
      "bot_read",
      "bot_update_identity",
    ]);
    expect(config.instructions).toContain("Write landing copy.");
  });

  it("continue in a bot conversation forks it with this plugin as origin", async () => {
    const t = setup();
    const bot = await t.create("Marketer");
    await t.assign("thr_old", bot.id);
    const { threadId } = await t.rpc<{ threadId: string }>("bots.v1.continueInBot", {
      threadId: "thr_old",
    });
    const [args] = t.harness.sdk.callsTo("threads.fork")[0] as [Record<string, unknown>];
    expect(args).toMatchObject({
      sourceThreadId: "thr_old",
      pluginMetadata: { startToken: expect.any(String) },
    });
    const threads = (await t.list()).bots[0]!.threads;
    expect(threads).toContainEqual({ threadId, startedFromBot: true, completed: false });
    expect(threads).toContainEqual({
      threadId: "thr_old",
      startedFromBot: false,
      completed: false,
    });
  });

  it("an unbound conversation gets nothing", async () => {
    const t = setup();
    await t.create("Marketer");
    expect(await t.configure("thr_free")).toMatchObject({ tools: [], instructions: null });
  });
});

describe("letters between bots", () => {
  it("A to B to C and back to A continues one exchange and counts every letter", async () => {
    const t = await threeBots();
    await t.letter("thr_a", t.b.id);
    await t.letter("thr_b", t.c.id);
    await t.letter("thr_c", t.a.id);
    expect(await t.letter("thr_a", t.b.id)).toContain("Letter 4/4");
    await expect(t.letter("thr_b", t.a.id)).rejects.toThrow(/limit of 4 letters/);
    expect(t.harness.sdk.callsTo("threads.send")).toHaveLength(4);
  });

  it("sending again from the same conversation does not reset the count", async () => {
    const t = await threeBots();
    for (let i = 0; i < 4; i++) await t.letter("thr_a", t.b.id);
    await expect(t.letter("thr_a", t.c.id)).rejects.toThrow(/limit/);
  });

  it("letters sent at the same time do not exceed the limit", async () => {
    const t = await threeBots();
    const results = await Promise.allSettled(
      Array.from({ length: 7 }, () => t.letter("thr_a", t.b.id)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(4);
  });

  it("the owner's own message starts a new exchange; a bot's letter does not", async () => {
    const t = await threeBots();
    for (let i = 0; i < 4; i++) await t.letter("thr_a", t.b.id);
    await t.dispatch("thr_a", "agent", "thr_b");
    await expect(t.letter("thr_a", t.b.id)).rejects.toThrow(/limit/);
    await t.dispatch("thr_a", "user", null);
    expect(await t.letter("thr_a", t.b.id)).toContain("Letter 1/4");
  });

  it("the sender comes from the tool call and is named in the delivered letter", async () => {
    const t = await threeBots();
    await t.letter("thr_a", "Beta");
    const [args] = t.harness.sdk.callsTo("threads.send")[0] as [
      { threadId: string; senderThreadId: string; input: Array<{ text: string }> },
    ];
    expect(args.threadId).toBe("thr_b");
    expect(args.senderThreadId).toBe("thr_a");
    expect(args.input[0]!.text).toContain(`Letter from the bot "Alpha" (${t.a.id})`);
  });

  it("refuses a conversation of another bot and a conversation outside bots", async () => {
    const t = await threeBots();
    await expect(t.letter("thr_a", t.b.id, "thr_c")).rejects.toThrow(/does not belong/);
    await expect(t.letter("thr_free", t.b.id)).rejects.toThrow(/Only a bot's conversation/);
  });

  it("limits letters per bot per hour across exchanges", async () => {
    const t = setup({ chainLetters: 100, hourlyLetters: 2 });
    const a = await t.create("Alpha");
    const b = await t.create("Beta");
    await t.assign("thr_a", a.id);
    await t.assign("thr_b", b.id);
    await t.letter("thr_a", b.id);
    await t.dispatch("thr_a", "user", null);
    await t.letter("thr_a", b.id);
    await t.dispatch("thr_a", "user", null);
    await expect(t.letter("thr_a", b.id)).rejects.toThrow(/last hour/);
    t.advance(61 * 60 * 1000);
    await expect(t.letter("thr_a", b.id)).resolves.toContain("Letter");
  });
});

describe("done", () => {
  async function botWithChats(settings: Record<string, number> = {}) {
    const t = setup(settings);
    const bot = await t.create("Marketer");
    await t.assign("thr_first", bot.id);
    await t.assign("thr_creatives", bot.id);
    const old = START - 30 * 24 * 60 * 60 * 1000;
    for (const id of ["thr_first", "thr_creatives"]) {
      t.threads.set(id, makeThreadResponse({ id, status: "idle", updatedAt: old, pinnedAt: null }));
    }
    return { ...t, bot };
  }
  const completedOf = async (t: ReturnType<typeof setup>) =>
    Object.fromEntries(
      (await t.list()).bots[0]!.threads.map((thread) => [thread.threadId, thread.completed]),
    );

  it("an idle conversation is not marked done unless auto-complete is turned on", async () => {
    const t = await botWithChats();
    await t.harness.behavior.runSchedule(AUTO_COMPLETE_SCHEDULE);
    expect(await completedOf(t)).toEqual({ thr_first: false, thr_creatives: false });
  });

  it("auto-complete, when turned on, never marks the bot's first conversation", async () => {
    const t = await botWithChats({ autoCompleteHours: 72 });
    await t.harness.behavior.runSchedule(AUTO_COMPLETE_SCHEDULE);
    expect(await completedOf(t)).toEqual({ thr_first: false, thr_creatives: true });
  });

  it("a new message, a question or a failure brings a done conversation back", async () => {
    const t = await botWithChats();
    const done = () =>
      t.rpc("bots.v1.setCompleted", { threadId: "thr_creatives", completed: true });
    await done();
    await t.dispatch("thr_creatives", "user", null);
    expect((await completedOf(t)).thr_creatives).toBe(false);
    await done();
    await t.harness.behavior.emitThreadEvent("interaction.pending", {
      thread: makeThreadResponse({ id: "thr_creatives" }),
      interaction: {} as never,
    });
    expect((await completedOf(t)).thr_creatives).toBe(false);
    await done();
    await t.harness.behavior.emitThreadEvent("thread.failed", {
      thread: makeThreadResponse({ id: "thr_creatives" }),
      error: "boom",
    });
    expect((await completedOf(t)).thr_creatives).toBe(false);
  });

  it("done and archive stay separate", async () => {
    const t = await botWithChats();
    await t.rpc("bots.v1.setCompleted", { threadId: "thr_creatives", completed: true });
    expect(t.harness.sdk.callsTo("threads.archive")).toHaveLength(0);
    await t.harness.behavior.emitThreadEvent("thread.archived", {
      thread: makeThreadResponse({ id: "thr_first" }),
    });
    expect(await completedOf(t)).toEqual({ thr_first: false, thr_creatives: true });
  });
});

describe("bot state", () => {
  it("memory keeps one line per fact, ignores duplicates and enforces its limit", async () => {
    const t = setup();
    const bot = await t.create("Marketer");
    await t.assign("thr_m", bot.id);
    const update = (change: unknown) =>
      t.harness.behavior.callAgentTool("bot_memory_update", change, { threadId: "thr_m" });
    await update({ action: "append", fact: "The owner prefers short posts." });
    await update({ action: "append", fact: "- The owner prefers short posts." });
    expect((await t.rpc<BotDetail>("bots.v1.get", { botId: bot.id })).memory).toBe(
      "- The owner prefers short posts.",
    );
    await expect(
      update({ action: "overwrite", content: "x".repeat(3001), expectedSha256: "" }),
    ).rejects.toThrow(/3000/);
    await expect(
      update({ action: "overwrite", content: "new", expectedSha256: "stale" }),
    ).rejects.toThrow(/changed since it was read/);
  });

  it("an edit against a stale revision fails instead of overwriting", async () => {
    const t = setup();
    const bot = await t.create("Marketer");
    await t.rpc("bots.v1.update", { botId: bot.id, expectedRevision: bot.revision, role: "Ads" });
    await expect(
      t.rpc("bots.v1.update", { botId: bot.id, expectedRevision: bot.revision, role: "Posts" }),
    ).rejects.toThrow(/changed since revision/);
  });

  it("the bot's prompt names the other visible bots it can write to", async () => {
    const t = setup();
    const a = await t.create("Alpha");
    const b = await t.create("Beta", { role: "Accounting" });
    const hidden = await t.create("Ghost");
    await t.rpc("bots.v1.update", {
      botId: hidden.id,
      expectedRevision: hidden.revision,
      hidden: true,
    });
    await t.assign("thr_a", a.id);
    const { instructions } = await t.configure("thr_a");
    expect(instructions).toContain(`- Beta (${b.id}): Accounting`);
    expect(instructions).not.toContain("Ghost");
    expect(instructions).toContain("You have no instructions yet");
  });
});

describe("whom a bot may write to and what it did", () => {
  it("a bot writes only to the bots the owner allowed, and the refusal is logged", async () => {
    const t = await threeBots();
    await t.rpc("bots.v1.update", {
      botId: t.a.id,
      expectedRevision: t.a.revision,
      reach: [t.b.id],
    });
    await expect(t.letter("thr_a", t.c.id)).rejects.toThrow(/may not write to that bot/);
    await expect(t.letter("thr_a", t.b.id)).resolves.toContain("Letter 1/4");
    const { instructions } = await t.configure("thr_a");
    expect(instructions).toContain(`- Beta (${t.b.id})`);
    expect(instructions).not.toContain("Gamma");
    const { events } = await t.rpc<{
      events: Array<{ kind: string; actor: { kind: string; id: string | null } }>;
    }>("bots.v1.events", { botId: t.a.id });
    expect(events.map((event) => event.kind)).toEqual([
      "letter.sent",
      "letter.refused",
      "bot.updated",
      "thread.assigned",
      "bot.created",
    ]);
    expect(events[0]!.actor).toEqual({ kind: "agent", id: "thr_a" });
    expect(events[2]!.actor).toEqual({ kind: "owner", id: null });
  });

  it("a change made by another plugin is logged under that plugin", async () => {
    const t = setup();
    const bot = await t.create("Main");
    await t.harness.behavior.callRpc(
      "bots.v1.assign",
      { threadId: "thr_1", botId: bot.id },
      { experimental_caller: { kind: "plugin", pluginId: "1ma-superagent" } },
    );
    const { events } = await t.rpc<{ events: Array<{ kind: string; actor: unknown }> }>(
      "bots.v1.events",
      {
        botId: bot.id,
      },
    );
    expect(events[0]).toMatchObject({
      kind: "thread.assigned",
      actor: { kind: "plugin", id: "1ma-superagent" },
    });
  });
});
