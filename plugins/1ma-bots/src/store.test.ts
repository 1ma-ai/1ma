import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { acceptDelivery, routeLetter } from "./letters.js";
import { BotStore, INSTALLATION_OWNER, MIGRATIONS, broughtBack } from "./store.js";

const START = Date.parse("2026-11-14T10:00:00Z");

function open(migrations: readonly string[] = MIGRATIONS) {
  const { bb } = createFakePluginHost({ pluginId: "1ma-bots" });
  const db = bb.storage.database();
  bb.storage.migrate(db, [...migrations]);
  const clock = { now: START };
  const told: string[][] = [];
  const storeOf = (owner: string) =>
    new BotStore(
      db,
      () => clock.now,
      owner,
      (tags) => told.push([...tags].sort()),
    );
  const prepare = db.prepare.bind(db);
  const tables = () =>
    prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%owner_id%'")
      .all()
      .map((row) => (row as { name: string }).name);
  const rows = (table: string) => prepare(`SELECT * FROM ${table}`).all();
  const letter = (store: BotStore, fromThreadId: string, to: string, toThreadId: string) =>
    routeLetter(
      store,
      { fromThreadId, to, toBotId: to, toThreadId, now: clock.now, ownerTurn: null },
      { chainLetters: 100, hourlyLetters: 100 },
    );
  return {
    db,
    clock,
    told,
    store: storeOf(INSTALLATION_OWNER),
    storeOf,
    tables,
    rows,
    letter,
    migrate: () => bb.storage.migrate(db, MIGRATIONS),
  };
}

type Opened = ReturnType<typeof open>;

function botWith(store: BotStore, name: string, threadIds: readonly string[]) {
  const bot = store.create({ name });
  for (const id of threadIds) store.bind(id, bot.id, { startedFromBot: false, place: "last" });
  return bot;
}

const orderOf = (store: BotStore, botId: string) =>
  store
    .threads(botId, { from: "first", after: null, limit: 1000 })
    .threads.map(({ threadId }) => threadId);

describe("a database of an earlier version", () => {
  function fill({ db }: Opened) {
    const appearance = JSON.stringify({ shape: "circle", face: "calm", color: "#7c6cf0" });
    const bot = db.prepare(
      `INSERT INTO bots (id, name, appearance, memory, hidden, position, revision, created_at, updated_at)
       VALUES (?, ?, '${appearance}', ?, ?, ?, 4, 1, ?)`,
    );
    bot.run("bot_b", "Beta", "", 1, 1, 700);
    bot.run("bot_a", "Alpha", "- a fact", 0, 0, 500);
    const thread = db.prepare(
      "INSERT INTO bot_threads (thread_id, bot_id, position, started_from_bot, completed_at, bound_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    thread.run("thr_1", "bot_a", 0.5, 0, null, 30);
    thread.run("thr_2", "bot_a", -1, 1, 90, 20);
    thread.run("thr_3", "bot_a", -1, 0, null, 10);
    thread.run("thr_4", "bot_b", 0, 0, null, 40);
    db.exec(`
      INSERT INTO chains (id, letters, created_at) VALUES ('ch_kept', 2, 1), ('ch_gone', 1, 1);
      INSERT INTO thread_chains (thread_id, chain_id) VALUES ('thr_1', 'ch_kept'), ('thr_left', 'ch_gone'),
        ('thr_unnamed', 'ch_kept'), ('thr_mixed', 'ch_kept');
      INSERT INTO letters (chain_id, from_bot, from_thread, to_bot, to_thread, sent_at) VALUES
        ('ch_kept', 'bot_a', 'thr_1', 'bot_b', 'thr_4', 5),
        ('ch_gone', 'bot_gone', 'thr_left', 'bot_b', 'thr_4', 6),
        ('ch_gone', 'bot_a', 'thr_1', 'bot_gone', 'thr_left', 7),
        ('ch_kept', 'bot_a', 'thr_mixed', 'bot_gone', 'thr_left', 8);
      INSERT INTO bot_events (at, bot_id, kind, actor_kind) VALUES
        (1, 'bot_a', 'bot.created', 'owner'), (2, 'bot_gone', 'bot.removed', 'owner');
      INSERT INTO pending_letters (token, chain_id, to_thread, created_at) VALUES
        ('tok_kept', 'ch_kept', 'thr_4', 5), ('tok_gone', 'ch_gone', 'thr_left', 5),
        ('tok_unnamed', 'ch_kept', 'thr_unnamed', 3);
      INSERT INTO pending_starts (token, bot_id, created_at) VALUES
        ('start_kept', 'bot_a', 5), ('start_gone', 'bot_gone', 5);
    `);
  }

  it.each([1, 3, 4])("keeps its data, less what removed bots left (%i migrations)", (count) => {
    const t = open(MIGRATIONS.slice(0, count));
    const assignment = expect.any(String);
    fill(t);
    t.migrate();
    expect(t.store.list().map(({ id, hidden }) => [id, hidden])).toEqual([
      ["bot_a", false],
      ["bot_b", true],
    ]);
    expect(t.store.get("bot_a")).toMatchObject({
      memory: "- a fact",
      revision: 4,
      conversations: 3,
    });
    expect(t.store.threads("bot_a", { from: "first", after: null, limit: 10 }).threads).toEqual([
      { threadId: "thr_3", startedFromBot: false, completed: false, position: 1, assignment },
      { threadId: "thr_2", startedFromBot: true, completed: true, position: 2, assignment },
      { threadId: "thr_1", startedFromBot: false, completed: false, position: 3, assignment },
    ]);
    const ids = ["thr_1", "thr_2", "thr_3", "thr_4"];
    expect(new Set(ids.map((id) => t.store.assignmentOf(id)!.assignment)).size).toBe(ids.length);
    expect(
      t.store.memberPage("", 10).map(({ threadId, hiddenAt }) => [threadId, hiddenAt]),
    ).toEqual([
      ["thr_1", null],
      ["thr_2", null],
      ["thr_3", null],
      ["thr_4", 700],
    ]);
    expect(t.rows("bot_events")).toMatchObject([{ bot_id: "bot_a" }]);
    expect(t.rows("letters")).toMatchObject([{ id: 1, from_bot: "bot_a", to_bot: "bot_b" }]);
    expect(t.rows("chains")).toMatchObject([{ id: "ch_kept" }]);
    // Only a link every letter shows to be of a removed bot goes.
    expect(t.rows("thread_chains")).toMatchObject([
      { thread_id: "thr_1" },
      { thread_id: "thr_unnamed" },
      { thread_id: "thr_mixed" },
    ]);
    expect(t.rows("pending_letters")).toMatchObject([
      { token: "tok_kept", letter_id: 1 },
      { token: "tok_unnamed", letter_id: null },
    ]);
    expect(t.rows("pending_starts")).toMatchObject([{ token: "start_kept" }]);
    expect(t.rows("letter_spend")).toEqual(
      [5, 6, 7, 8].map((at, index) => ({
        owner_id: INSTALLATION_OWNER,
        bot_id: index === 1 ? "bot_gone" : "bot_a",
        at,
      })),
    );
    expect(t.tables().sort()).toEqual([
      "bot_events",
      "bot_threads",
      "bots",
      "chains",
      "letter_spend",
      "letters",
      "pending_letters",
      "pending_starts",
      "thread_assignment_decisions",
      "thread_chains",
    ]);
    for (const table of t.tables())
      for (const row of t.rows(table)) expect(row).toMatchObject({ owner_id: INSTALLATION_OWNER });
  });
});

describe("a database the released version writes to again after this one", () => {
  // The writes of the released store (f6a016d src/store.ts, src/letters.ts),
  // which knows none of the columns added since.
  const released = {
    setHidden: "UPDATE bots SET hidden = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
    bind: `INSERT INTO bot_threads (thread_id, bot_id, position, started_from_bot, completed_at, bound_at)
           VALUES (?, ?, 0, ?, NULL, ?)`,
    chain: "INSERT INTO chains (id, letters, created_at) VALUES (?, 1, ?)",
    letter: `INSERT INTO letters (chain_id, from_bot, from_thread, to_bot, to_thread, sent_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
    pending: "INSERT INTO pending_letters (token, chain_id, to_thread, created_at) VALUES (?, ?, ?, ?)",
  };

  function sent(t: Opened) {
    const from = botWith(t.store, "From", ["thr_from"]);
    const to = botWith(t.store, "To", ["thr_to"]);
    t.db.prepare(released.chain).run("ch_old", START);
    t.db.prepare(released.letter).run("ch_old", from.id, "thr_from", to.id, "thr_to", START);
    return { from, to };
  }

  it("keeps when a bot it hides was hidden", () => {
    const t = open();
    const bot = botWith(t.store, "Bot", ["thr_1"]);
    const hide = t.db.prepare(released.setHidden);
    hide.run(1, START + 5, bot.id);
    expect(t.store.hiddenAt(bot.id)).toBe(START + 5);
    hide.run(0, START + 9, bot.id);
    expect(t.store.hiddenAt(bot.id)).toBeNull();
    t.store.setHidden(bot.id, true, { kind: "owner", id: null });
    expect(t.store.hiddenAt(bot.id)).toBe(START);
  });

  it("gives each conversation it assigns an assignment of its own", () => {
    const t = open();
    const bot = botWith(t.store, "Bot", []);
    const bind = t.db.prepare(released.bind);
    bind.run("thr_1", bot.id, 0, START);
    bind.run("thr_2", bot.id, 0, START);
    const [first, second] = ["thr_1", "thr_2"].map((id) => t.store.assignmentOf(id)?.assignment);
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(second).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });

  it("counts a letter it sent in the sender's hourly limit", () => {
    const t = open();
    const { from, to } = sent(t);
    expect(() =>
      routeLetter(
        t.store,
        {
          fromThreadId: "thr_from",
          to: to.id,
          toBotId: to.id,
          toThreadId: "thr_to",
          now: START,
          ownerTurn: null,
        },
        { chainLetters: 100, hourlyLetters: 1 },
      ),
    ).toThrow(/already sent 1 letters in the last hour/);
    expect(t.rows("letter_spend")).toEqual([
      { owner_id: INSTALLATION_OWNER, bot_id: from.id, at: START },
    ]);
  });

  it("keeps the record of a letter it sent while the letter waits in bb's queue", () => {
    const t = open();
    sent(t);
    t.db.prepare(released.pending).run("tok_old", "ch_old", "thr_to", START);
    expect(t.rows("pending_letters")).toMatchObject([{ token: "tok_old", letter_id: 1 }]);
    t.store.dropHistory(START + 1, 100);
    expect(t.rows("letters")).toHaveLength(1);
  });
});

describe("removing a bot", () => {
  it("leaves nothing of it but its letters in bb's queue and what it spent, and all of the others", () => {
    const t = open();
    const { store } = t;
    const gone = botWith(store, "Gone", ["thr_gone_1", "thr_gone_2", "thr_gone_3"]);
    const kept = botWith(store, "Kept", ["thr_kept"]);
    const other = botWith(store, "Other", ["thr_other", "thr_deleted"]);
    const { chainId: over } = t.letter(store, "thr_gone_3", other.id, "thr_deleted");
    store.forgetThread("thr_deleted");
    t.letter(store, "thr_gone_1", kept.id, "thr_kept");
    t.letter(store, "thr_kept", gone.id, "thr_gone_2");
    t.letter(store, "thr_other", kept.id, "thr_kept");
    for (const bot of [gone, kept, other])
      store.record({ botId: bot.id, kind: "bot.updated", actor: { kind: "owner", id: null } });
    store.addPendingStart(gone.id, ["thr_gone_1"]);
    const keptRows = () => ({
      bots: store.list().map(({ id }) => id),
      events: [kept, other].map(({ id }) => store.events(id, 10).length),
      letters: t
        .rows("letters")
        .filter((row) => (row as { from_bot: string }).from_bot === other.id),
      threads: [kept, other].map(({ id }) => orderOf(store, id)),
    });
    const before = keptRows();
    const waiting = t.rows("pending_letters");
    store.remove(gone.id);
    const stays = ["pending_letters", "letter_spend"];
    const everything = JSON.stringify(
      t
        .tables()
        .filter((table) => !stays.includes(table))
        .map(t.rows),
    );
    const ids = (table: string, column: string) =>
      t.rows(table).map((row) => (row as Record<string, string>)[column]);
    expect(ids("chains", "id")).toEqual(expect.arrayContaining(ids("pending_letters", "chain_id")));
    expect(everything).not.toContain(gone.id);
    expect(everything).not.toContain("thr_gone");
    expect(everything).not.toContain(over);
    expect(keptRows()).toEqual({ ...before, bots: [kept.id, other.id] });
    expect(before.letters).toHaveLength(1);
    expect(t.rows("pending_letters")).toEqual(waiting);
    expect(waiting).toContainEqual(expect.objectContaining({ to_thread: "thr_gone_2" }));
    expect(ids("letter_spend", "bot_id")).toEqual([
      gone.id,
      gone.id,
      kept.id,
      other.id,
    ]);
  });
});

describe("retention", () => {
  it("drops the old event log and delivered letters in batches, nothing a waiting letter or a limit needs", () => {
    const t = open();
    const { store } = t;
    const a = botWith(store, "Alpha", ["thr_a"]);
    const b = botWith(store, "Beta", ["thr_b"]);
    const c = botWith(store, "Gamma", ["thr_c"]);
    const d = botWith(store, "Delta", ["thr_d"]);
    const { chainId: going } = t.letter(store, "thr_a", b.id, "thr_b");
    const { token } = t.letter(store, "thr_c", d.id, "thr_d");
    expect(acceptDelivery(store, "thr_d", [token], false)).toBe(true);
    for (const id of ["thr_c", "thr_d"]) store.forgetThread(id);
    expect(t.rows("letters")).toHaveLength(2);
    store.record({ botId: c.id, kind: "old", actor: { kind: "owner", id: null } });
    store.record({ botId: a.id, kind: "old", actor: { kind: "owner", id: null } });
    t.clock.now += 1000;
    store.record({ botId: b.id, kind: "new", actor: { kind: "owner", id: null } });
    const waiting = t.rows("pending_letters");
    const spent = t.rows("letter_spend");
    t.told.length = 0;
    const batches = [store.dropHistory(t.clock.now, 1), store.dropHistory(t.clock.now, 1)];
    expect([...batches, store.dropHistory(t.clock.now, 1)]).toEqual([true, true, false]);
    expect(t.rows("letters")).toMatchObject([{ chain_id: going }]);
    expect(t.rows("pending_letters")).toEqual(waiting);
    expect(waiting).toMatchObject([{ chain_id: going }]);
    expect(t.rows("letter_spend")).toEqual(spent);
    expect(store.events(a.id, 10)).toEqual([]);
    expect(store.events(b.id, 10).map(({ kind }) => kind)).toEqual(["new"]);
    expect(t.rows("chains")).toMatchObject([{ id: going, letters: 1 }]);
    expect(t.told).toEqual([[`events:${c.id}`], [`events:${a.id}`]]);
    expect(t.letter(store, "thr_a", b.id, "thr_b").letterNumber).toBe(2);
  });
});

describe("two owners in one database", () => {
  it("never meet", () => {
    const t = open();
    const mine = t.storeOf("mine");
    const theirs = t.storeOf("theirs");
    const statements: string[] = [];
    const prepare = t.db.prepare.bind(t.db);
    t.db.prepare = ((sql: string) => {
      statements.push(sql);
      return prepare(sql);
    }) as typeof t.db.prepare;
    const bot = botWith(mine, "Alpha", ["thr_1", "thr_2"]);
    const peer = botWith(mine, "Beta", ["thr_3"]);
    t.letter(mine, "thr_1", peer.id, "thr_3");
    mine.record({ botId: bot.id, kind: "bot.updated", actor: { kind: "owner", id: null } });
    const token = mine.addPendingStart(bot.id, []);
    const everything = () => JSON.stringify(t.tables().map(t.rows));
    const before = everything();

    expect(theirs.list()).toEqual([]);
    expect(theirs.find(bot.id)).toBeNull();
    expect(theirs.idsNamed("Alpha")).toEqual([]);
    expect(theirs.peers(bot, 10)).toEqual({ listed: [], total: 0 });
    expect(theirs.conversationCounts().size).toBe(0);
    expect(theirs.botOfThread("thr_1")).toBeNull();
    expect(theirs.members(["thr_1", "thr_2"]).size).toBe(0);
    expect(theirs.memberPage("", 10)).toEqual([]);
    expect(theirs.strayLinks("", 10)).toEqual([]);
    expect(orderOf(theirs, bot.id)).toEqual([]);
    expect(theirs.events(bot.id, 10)).toEqual([]);
    expect(theirs.hasAssignmentDecision("thr_1")).toBe(false);
    theirs.complete("thr_1");
    theirs.reopen(["thr_1"]);
    expect(theirs.unbind("thr_1")).toBeNull();
    expect(theirs.claimPendingStart("thr_9", token, null)).toBeNull();
    expect(theirs.dropHistory(Number.MAX_SAFE_INTEGER, 100)).toBe(false);
    theirs.saveDefaults(bot.id, { projectId: "proj_theirs" });
    theirs.reorderBots([], []);
    for (const refused of [
      () => theirs.remove(bot.id),
      () => theirs.setHidden(bot.id, true, { kind: "owner", id: null }),
      () => theirs.update({ botId: bot.id, expectedRevision: 1, name: "Theirs" }),
      () => theirs.writeMemory(bot.id, "theirs", bot.memorySha256),
      () => theirs.bind("thr_9", bot.id, { startedFromBot: false, place: "last" }),
      () => theirs.moveThreads(bot.id, ["thr_1"], { threadId: "thr_2", placement: "after" }),
      () => t.letter(theirs, "thr_1", peer.id, "thr_3"),
    ])
      expect(refused).toThrow();
    expect(everything()).toBe(before);

    const own = botWith(theirs, "Alpha", ["thr_4"]);
    expect(theirs.list().map(({ id }) => id)).toEqual([own.id]);
    mine.complete("thr_1");
    mine.remove(bot.id);
    expect(mine.list().map(({ id }) => id)).toEqual([peer.id]);
    expect(theirs.list().map(({ id }) => id)).toEqual([own.id]);
    expect(orderOf(theirs, own.id)).toEqual(["thr_4"]);
    expect(statements.filter((sql) => !sql.includes("owner_id"))).toEqual([]);
  });
});

describe("the order of a bot's conversations", () => {
  const ids = ["thr_1", "thr_2", "thr_3", "thr_4", "thr_5"];

  it("moves and joins without renumbering the others", () => {
    const t = open();
    const bot = botWith(t.store, "Alpha", ids);
    const positionOf = (id: string) => t.store.members([id]).get(id)!.position;
    const before = ids.map(positionOf);
    t.store.moveThreads(bot.id, ["thr_5", "thr_4"], { threadId: "thr_2", placement: "before" });
    t.store.bind("thr_0", bot.id, { startedFromBot: false, place: "first" });
    t.store.bind("thr_6", bot.id, { startedFromBot: false, place: { after: "thr_1" } });
    expect(orderOf(t.store, bot.id)).toEqual([
      "thr_0",
      "thr_1",
      "thr_6",
      "thr_4",
      "thr_5",
      "thr_2",
      "thr_3",
    ]);
    expect(ids.slice(0, 3).map(positionOf)).toEqual(before.slice(0, 3));
  });

  it("starts with what joins beside a conversation that is another bot's by then", () => {
    const t = open();
    const bot = botWith(t.store, "Alpha", ids);
    botWith(t.store, "Beta", ["thr_x", "thr_y", "thr_left"]);
    t.store.bind("thr_0", bot.id, { startedFromBot: false, place: { after: "thr_left" } });
    expect(orderOf(t.store, bot.id)).toEqual(["thr_0", ...ids]);
  });

  it("is numbered anew when the numbers between two conversations run out", () => {
    const t = open();
    const bot = botWith(t.store, "Alpha", ids);
    const other = botWith(t.store, "Beta", ["thr_other"]);
    const othersBefore = t
      .rows("bot_threads")
      .filter((row) => (row as { bot_id: string }).bot_id === other.id);
    t.told.length = 0;
    let order = [...ids];
    for (let i = 0; i < 200; i += 1) {
      const last = order.at(-1)!;
      t.store.moveThreads(bot.id, [last], { threadId: order[0]!, placement: "after" });
      order = [order[0]!, last, ...order.slice(1, -1)];
      expect(orderOf(t.store, bot.id)).toEqual(order);
    }
    expect(t.told.filter((tags) => tags.includes(`members:${bot.id}`)).length).toBeGreaterThan(0);
    expect(
      t.rows("bot_threads").filter((row) => (row as { bot_id: string }).bot_id === other.id),
    ).toEqual(othersBefore);
  });

  it("is read in pages from either end", () => {
    const t = open();
    const bot = botWith(t.store, "Alpha", ids);
    const read = (from: "first" | "last") => {
      const pages: string[][] = [];
      let after: ReturnType<BotStore["threads"]>["next"] = null;
      do {
        const page: ReturnType<BotStore["threads"]> = t.store.threads(bot.id, {
          from,
          after,
          limit: 2,
        });
        pages.push(page.threads.map(({ threadId }) => threadId));
        after = page.next;
      } while (after !== null);
      return pages;
    };
    expect(read("first")).toEqual([["thr_1", "thr_2"], ["thr_3", "thr_4"], ["thr_5"]]);
    expect(read("last")).toEqual([["thr_5", "thr_4"], ["thr_3", "thr_2"], ["thr_1"]]);
  });
});

describe("what a write tells", () => {
  it.each<[string, (t: Opened, botId: string, otherId: string) => unknown, string[]]>([
    ["done", ({ store }) => store.complete("thr_1"), ["conversations:A", "thread:thr_1"]],
    ["not done of an open one", ({ store }) => store.reopen(["thr_1"]), []],
    [
      "memory",
      ({ store }, id) => store.writeMemory(id, "- x", store.get(id).memorySha256),
      ["bot:A"],
    ],
    [
      "a role",
      ({ store }, id) => store.update({ botId: id, expectedRevision: 1, role: "Ads" }),
      ["bot:A", "bots"],
    ],
    [
      "instructions",
      ({ store }, id) => store.update({ botId: id, expectedRevision: 1, instructions: "Do" }),
      ["bot:A"],
    ],
    [
      "hidden",
      ({ store }, id) => store.setHidden(id, true, { kind: "owner", id: null }),
      ["bot:A", "bots", "events:A"],
    ],
    [
      "a change of bot",
      ({ store }, _id, otherId) =>
        store.bind("thr_1", otherId, { startedFromBot: false, place: "last" }),
      ["conversations:A", "conversations:B", "thread:thr_1"],
    ],
    [
      "a move",
      ({ store }, id) =>
        store.moveThreads(id, ["thr_1"], { threadId: "thr_2", placement: "after" }),
      ["conversations:A", "thread:thr_1"],
    ],
    [
      "a deleted conversation",
      ({ store }) => store.forgetThread("thr_1"),
      ["conversations:A", "thread:thr_1"],
    ],
    [
      "a removed bot",
      ({ store }, id) => store.remove(id),
      ["bot:A", "bots", "conversations:A", "events:A", "members:A"],
    ],
    ["a deleted conversation of no bot", ({ store }) => store.forgetThread("thr_free"), []],
    [
      "a new place among the bots",
      ({ store }, a, b) => store.reorderBots([b, a], [a, b]),
      ["bots"],
    ],
  ])("%s", (_name, write, expected) => {
    const t = open();
    const a = botWith(t.store, "Alpha", ["thr_1", "thr_2"]);
    const b = botWith(t.store, "Beta", ["thr_3"]);
    t.told.length = 0;
    const changes = t.store.watch();
    write(t, a.id, b.id);
    const named = t.told.map((tags) =>
      tags.map((tag) => tag.replace(a.id, "A").replace(b.id, "B")).sort(),
    );
    expect(named).toEqual(expected.length === 0 ? [] : [expected]);
    expect(changes).toEqual(expect.arrayContaining(t.told.flat()));
  });

  it("bringing back a conversation to whoever watches, marked or not", () => {
    const t = open();
    botWith(t.store, "Alpha", ["thr_1"]);
    const early = t.store.watch();
    t.store.unwatch(early);
    const changes = t.store.watch();
    t.store.reopen(["thr_1"]);
    expect(changes).toEqual([broughtBack("thr_1")]);
    expect(early).toEqual([]);
  });

  it("once for a whole transaction, and nothing for one that is undone", () => {
    const t = open();
    const bot = botWith(t.store, "Alpha", ["thr_1", "thr_2"]);
    t.told.length = 0;
    t.store.transaction(() => {
      t.store.complete("thr_1");
      t.store.complete("thr_2");
    });
    expect(t.told).toEqual([[`conversations:${bot.id}`, "thread:thr_1", "thread:thr_2"]]);
    expect(() =>
      t.store.transaction(() => {
        t.store.reopen(["thr_1"]);
        throw new Error("undone");
      }),
    ).toThrow("undone");
    t.store.reopen(["thr_2"]);
    expect(t.told.slice(1)).toEqual([[`conversations:${bot.id}`, "thread:thr_2"]]);
  });
});
