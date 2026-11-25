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
