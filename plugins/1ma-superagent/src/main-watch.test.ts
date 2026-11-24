import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { GitHubReader } from "./github/reader.js";
import { judgeMainMove, parseJournal } from "./journal.js";
import { mainWatchRows, rollbackKind, runMainWatch } from "./main-watch.js";
import { QuestionStore } from "./questions.js";
import { repoPolicy } from "./repos.js";
import { MIGRATIONS } from "./schema.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function line(record: Record<string, unknown>) {
  return JSON.stringify({ author: "release-train", repo: "example/app", attempt: "t1", ...record });
}

const X = "d".repeat(40);

function journalOf(...records: Array<Record<string, unknown>>) {
  return parseJournal(records.map(line).join("\n"));
}

describe("train journal", () => {
  it("ignores old lines of other shapes and lines not written by the train", () => {
    const text = [
      "not json",
      JSON.stringify({ note: "legacy line" }),
      JSON.stringify({
        author: "someone",
        repo: "example/app",
        attempt: 1,
        event: "merged",
        final_sha: A,
      }),
      line({ event: "merged", base_sha: C, final_sha: A }),
    ].join("\n");
    expect(parseJournal(text)).toEqual([
      { repo: "example/app", attempt: "t1", event: "merged", finalSha: A, baseSha: C },
    ]);
  });

  it("explains a move only when the train's chain leads from the last head to the new one", () => {
    const one = journalOf({ event: "merged", base_sha: A, final_sha: B });
    expect(judgeMainMove(one, "example/app", A, B, false)).toEqual({ kind: "explained" });
    const two = journalOf(
      { event: "merged", base_sha: A, final_sha: B },
      { attempt: "t2", event: "merged", base_sha: B, final_sha: C },
    );
    expect(judgeMainMove(two, "example/app", A, C, false)).toEqual({ kind: "explained" });
  });

  it("treats a train built on a head it did not write as a direct commit", () => {
    const records = journalOf({ event: "merged", base_sha: X, final_sha: C });
    expect(judgeMainMove(records, "example/app", A, C, false).kind).toBe("unexplained");
  });

  it("applies a rollback only to the move away from the rolled-back head", () => {
    const records = journalOf(
      { event: "merged", base_sha: C, final_sha: A },
      { event: "rolled-back", final_sha: A },
    );
    expect(judgeMainMove(records, "example/app", A, C, false)).toEqual({
      kind: "rollback",
      attempt: "t1",
    });
    expect(judgeMainMove(records, "example/app", B, C, false).kind).toBe("unexplained");
  });

  it("needs a reconcile for an unconfirmed push, a record without a base or an incomplete tail", () => {
    const intent = journalOf({ event: "started" }, { event: "push-intent", final_sha: B });
    expect(judgeMainMove(intent, "example/app", A, B, false).kind).toBe("needs_reconcile");
    const baseless = journalOf({ event: "merged", final_sha: B });
    expect(judgeMainMove(baseless, "example/app", A, B, false).kind).toBe("needs_reconcile");
    expect(judgeMainMove([], "example/app", A, B, true).kind).toBe("needs_reconcile");
    expect(judgeMainMove([], "example/app", A, B, false).kind).toBe("unexplained");
  });
});

function setup(journal: string) {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const questions = new QuestionStore(db);
  let head = A;
  const github: GitHubReader = {
    pull: async () => {
      throw new Error("unused");
    },
    recentPulls: async () => ({ pulls: [], complete: true }),
    mainHead: async () => head,
  };
  const watch = { enabled: true, excluded: [] as string[], duringRead: () => {} };
  const run = (enabled = true) =>
    runMainWatch({
      db,
      github,
      readJournal: async () => {
        watch.duringRead();
        return { status: "ok", text: journal, truncated: false };
      },
      enabled: () => enabled && watch.enabled,
      policy: () =>
        repoPolicy([{ repo: "example/app", accounts: { mac: [], linux: [] } }], watch.excluded),
      questions,
      now: 1_000,
      signal: new AbortController().signal,
    });
  return { db, questions, run, watch, setHead: (value: string) => (head = value) };
}

function answer(t: ReturnType<typeof setup>, optionId: string) {
  const [question] = t.questions.waiting();
  if (question === undefined) throw new Error("no question");
  t.questions.markOpen(question.id, "thr_bot", "tok", 1_000);
  return t.questions.answer(
    question.id,
    "tok",
    optionId,
    new Map([["main_rollback", rollbackKind(t.db)]]),
    1_000,
  );
}

describe("main watch", () => {
  it("takes the first head as a baseline and asks once about a head the train did not write", async () => {
    const t = setup(line({ event: "merged", base_sha: A, final_sha: B }));
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
    t.setHead(B);
    await t.run();
    expect(mainWatchRows(t.db)[0]?.state).toBe("ok");
    t.setHead(C);
    await t.run();
    await t.run();
    expect(t.questions.waiting().map((question) => question.kind)).toEqual(["main_bypass"]);
    expect(mainWatchRows(t.db)[0]?.state).toBe("bypass");
  });

  it("marks an unconfirmed push as needing a reconcile instead of asking", async () => {
    const t = setup(line({ event: "push-intent", final_sha: B }));
    await t.run();
    t.setHead(B);
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
    expect(mainWatchRows(t.db)[0]).toMatchObject({ state: "needs_reconcile" });
  });

  it("asks nothing about a repository excluded, or a check turned off, while the journal was read", async () => {
    const t = setup("");
    await t.run();
    t.setHead(C);
    t.watch.duringRead = () => {
      t.watch.excluded = ["example/app"];
    };
    await t.run();
    t.watch.excluded = [];
    t.watch.duringRead = () => {
      t.watch.enabled = false;
    };
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
    expect(mainWatchRows(t.db)[0]).toMatchObject({ lastHead: A, state: "ok" });
  });

  it("is off unless enabled", async () => {
    const t = setup("");
    await t.run(false);
    expect(mainWatchRows(t.db)).toEqual([]);
  });

  it("survives a host that throws, and records that the journal was not read", async () => {
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const recorded: unknown[] = [];
    const problems = await runMainWatch({
      db,
      github: {
        pull: async () => {
          throw new Error("unused");
        },
        recentPulls: async () => ({ pulls: [], complete: true }),
        mainHead: async () => A,
      },
      readJournal: async () => {
        throw new Error("host worker exited");
      },
      enabled: () => true,
      policy: () => repoPolicy([{ repo: "example/app", accounts: { mac: [], linux: [] } }], []),
      questions: new QuestionStore(db),
      now: 5_000,
      signal: new AbortController().signal,
      recordJournal: async (observation) => {
        recorded.push(observation);
      },
    });
    expect(problems).toEqual(["train journal: host worker exited"]);
    expect(recorded).toEqual([{ at: 5_000, status: "error", problem: "host worker exited" }]);
  });

  it("takes the head after a rollback as the baseline only once the owner confirms it", async () => {
    const t = setup(
      [
        line({ event: "merged", base_sha: C, final_sha: A }),
        line({ event: "rolled-back", final_sha: A }),
      ].join("\n"),
    );
    await t.run();
    t.setHead(C);
    await t.run();
    await t.run();
    expect(t.questions.waiting().map((question) => question.kind)).toEqual(["main_rollback"]);
    expect(mainWatchRows(t.db)[0]).toMatchObject({ lastHead: A, state: "needs_reconcile" });
    expect(answer(t, "yes")).toBe("applied");
    expect(mainWatchRows(t.db)[0]).toMatchObject({ lastHead: C, state: "ok" });
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
  });
});
