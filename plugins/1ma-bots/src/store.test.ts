import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { BotStore, MIGRATIONS } from "./store.js";

function storeWithBot() {
  const { bb } = createFakePluginHost({ pluginId: "1ma-bots" });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new BotStore(db);
  const bot = store.create({ name: "Marketer" });
  for (const id of ["thr_a", "thr_b"])
    store.bind(id, bot.id, { startedFromBot: false, place: "last" });
  return { store, bot };
}

it("gives every assignment of the released database an identity of its own", () => {
  const { bb } = createFakePluginHost({ pluginId: "1ma-bots" });
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS.slice(0, 3));
  db.exec(`INSERT INTO bots (id, name, appearance, position, created_at, updated_at)
      VALUES ('bot_a', 'Marketer', '{}', 1, 1, 1);
    INSERT INTO bot_threads (thread_id, bot_id, position, started_from_bot, bound_at)
      VALUES ('thr_a', 'bot_a', 1, 0, 1), ('thr_b', 'bot_a', 2, 0, 1);`);

  bb.storage.migrate(db, MIGRATIONS);

  const store = new BotStore(db);
  const [a, b] = ["thr_a", "thr_b"].map((id) => store.assignmentOf(id)?.assignment);
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(a).not.toBe(b);
});

it.each<[string, (store: BotStore, botId: string) => unknown]>([
  ["bind", (store, id) => store.bind("thr_c", id, { startedFromBot: false, place: "last" })],
  ["unbind", (store) => store.unbind("thr_a")],
  ["forgetThread", (store) => store.forgetThread("thr_a")],
  ["remove", (store, id) => store.remove(id)],
  [
    "moveThreads",
    (store, id) => store.moveThreads(id, ["thr_b"], { threadId: "thr_a", placement: "before" }),
  ],
  ["complete", (store) => store.complete("thr_a")],
  ["reopen", (store) => store.reopen(["thr_a"])],
  ["bindContinuation", (store) => store.bindContinuation("thr_c", "thr_a", ["thr_a"], false)],
  [
    "claimPendingStart",
    (store, id) => store.claimPendingStart("thr_c", store.addPendingStart(id, []), null),
  ],
])("%s moves the generation on", (_name, change) => {
  const { store, bot } = storeWithBot();
  const before = store.generation;
  change(store, bot.id);
  expect(store.generation).toBeGreaterThan(before);
});
