import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./schema.js";
import { Store } from "./store.js";
import { snapshot, threadSummary } from "./test-helpers.js";

function store(): Store {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  return new Store(db);
}

function apply(target: Store, result: ReturnType<typeof snapshot>, mainBot: string | null = null) {
  target.recordServerObservation("mac", result);
  target.applySnapshot("mac", result.items, result, mainBot);
}

describe("Store.applySnapshot", () => {
  it("records only the owner's own top-level chats as works", () => {
    const target = store();
    apply(
      target,
      snapshot([
        threadSummary({ threadId: "thr_owner" }),
        threadSummary({ threadId: "thr_hidden", hidden: true }),
        threadSummary({ threadId: "thr_child", parentThreadId: "thr_owner" }),
        threadSummary({ threadId: "thr_plugin", originPluginId: "automations" }),
        threadSummary({ threadId: "thr_bot" }),
      ]),
      "thr_bot",
    );
    const works = target.listWorks({ limit: 10, offset: 0, includeClosed: true });
    expect(works.map((work) => work.threadId)).toEqual(["thr_owner"]);
    expect(works[0]).toMatchObject({
      serverId: "mac",
      state: "idle",
      branch: "main",
      repo: "https://github.com/example/app.git",
      version: 1,
    });
  });

  it("bumps the version only when the state changes", () => {
    const target = store();
    apply(target, snapshot([threadSummary({ threadId: "thr_1" })], "complete", 1));
    apply(target, snapshot([threadSummary({ threadId: "thr_1" })], "complete", 2));
    expect(target.getWork("work_mac_thr_1")?.version).toBe(1);
    apply(
      target,
      snapshot([threadSummary({ threadId: "thr_1", status: "active" })], "complete", 3),
    );
    expect(target.getWork("work_mac_thr_1")).toMatchObject({ version: 2, state: "active" });
  });

  it("closes a missing chat only when the list was complete", () => {
    const target = store();
    apply(
      target,
      snapshot([threadSummary({ threadId: "thr_1" }), threadSummary({ threadId: "thr_2" })]),
    );
    apply(target, snapshot([threadSummary({ threadId: "thr_1" })], "partial", 20_000));
    expect(target.getWork("work_mac_thr_2")?.state).toBe("idle");
    apply(target, snapshot([threadSummary({ threadId: "thr_1" })], "complete", 30_000));
    expect(target.getWork("work_mac_thr_2")?.state).toBe("closed");
    expect(target.listWorks({ limit: 10, offset: 0, includeClosed: false })).toHaveLength(1);
  });
});

describe("Store.recordServerObservation", () => {
  it("keeps the last time the server was seen when an attempt fails", () => {
    const target = store();
    target.recordServerObservation("linux", { observedAt: 100, completeness: "complete" });
    target.recordServerObservation("linux", {
      observedAt: 200,
      completeness: "failed",
      error: "connect ECONNREFUSED",
    });
    expect(target.servers()).toEqual([
      {
        id: "linux",
        lastSeenAt: 100,
        lastCompleteAt: 100,
        lastAttemptAt: 200,
        completeness: "failed",
        lastError: "connect ECONNREFUSED",
      },
    ]);
  });

  it("does not count a partial answer as a complete one", () => {
    const target = store();
    target.recordServerObservation("linux", { observedAt: 100, completeness: "partial" });
    expect(target.servers()[0]).toMatchObject({ lastSeenAt: 100, lastCompleteAt: null });
  });
});
