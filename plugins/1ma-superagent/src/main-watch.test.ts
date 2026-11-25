import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { GitHubReader } from "./github/reader.js";
import { bypassKind, mainWatchRows, rollbackKind, runMainWatch } from "./main-watch.js";
import { QuestionStore } from "./questions.js";
import { repoPolicy } from "./repos.js";
import { MIGRATIONS } from "./schema.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const X = "d".repeat(40);
const REPO = "example/app";

function line(record: Record<string, unknown>) {
  return JSON.stringify({ author: "release-train", repo: "example/app", token: "t1", ...record });
}

function train(base: string, finalSha: string) {
  return [
    line({ outcome: "push-intent", base, final_sha: finalSha, merges: [finalSha] }),
    line({ outcome: "merged", final_sha: finalSha }),
  ].join("\n");
}

function setup(initialJournal: string) {
  let journal = initialJournal;
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
  return {
    db,
    questions,
    run,
    watch,
    setHead: (value: string) => (head = value),
    setJournal: (...lines: string[]) => (journal = lines.join("\n")),
  };
}

function answer(t: ReturnType<typeof setup>, optionId: string, subject?: string) {
  const question = t.questions
    .waiting()
    .find((candidate) => subject === undefined || candidate.subject === subject);
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
    const t = setup(train(A, B));
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

  it("marks an unconfirmed push as needing a reconcile and keeps the confirmed head", async () => {
    const t = setup(line({ outcome: "push-intent", base: A, final_sha: B }));
    await t.run();
    t.setHead(B);
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
    expect(mainWatchRows(t.db)[0]).toMatchObject({
      anchor: A,
      observedHead: B,
      state: "needs_reconcile",
    });
  });

  it("confirms the push once merged arrives for the same head, without main moving again", async () => {
    const t = setup(line({ outcome: "push-intent", base: A, final_sha: B }));
    await t.run();
    t.setHead(B);
    await t.run();
    t.setJournal(
      line({ outcome: "push-intent", base: A, final_sha: B }),
      line({ outcome: "merged", final_sha: B }),
    );
    await t.run();
    expect(mainWatchRows(t.db)[0]).toMatchObject({ anchor: B, observedHead: B, state: "ok" });
    expect(t.questions.waiting()).toEqual([]);
  });

  it("explains a normal train whose base is written only in its push-intent", async () => {
    const t = setup(
      [
        line({ outcome: "push-intent", base: A, final_sha: B, merges: [B] }),
        line({ outcome: "merged", final_sha: B }),
      ].join("\n"),
    );
    await t.run();
    t.setHead(B);
    await t.run();
    expect(mainWatchRows(t.db)[0]).toMatchObject({ anchor: B, state: "ok", detail: null });
  });

  it("refuses an answer to a rollback card once another head is observed", async () => {
    const t = setup([train(C, A), line({ outcome: "rolled-back", final_sha: A })].join("\n"));
    await t.run();
    t.setHead(C);
    await t.run();
    t.setHead(X);
    await t.run();
    expect(t.questions.waiting().map((question) => question.subject)).toEqual([
      `example/app@${C}`,
      `example/app@${X}`,
    ]);
    expect(answer(t, "yes", `example/app@${C}`)).toBe("stale");
    expect(mainWatchRows(t.db)[0]).toMatchObject({
      anchor: A,
      observedHead: X,
      state: "needs_reconcile",
    });
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
    expect(mainWatchRows(t.db)[0]).toMatchObject({ anchor: A, state: "ok" });
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
    const t = setup([train(C, A), line({ outcome: "rolled-back", final_sha: A })].join("\n"));
    await t.run();
    t.setHead(C);
    await t.run();
    await t.run();
    expect(t.questions.waiting().map((question) => question.kind)).toEqual(["main_rollback"]);
    expect(mainWatchRows(t.db)[0]).toMatchObject({ anchor: A, state: "needs_reconcile" });
    expect(answer(t, "yes")).toBe("applied");
    expect(mainWatchRows(t.db)[0]).toMatchObject({ anchor: C, state: "ok" });
    await t.run();
    expect(t.questions.waiting()).toEqual([]);
  });
});

const BEFORE_SPLIT = 16;

function legacy(rows: Array<{ lastHead: string; state: string }>) {
  const directory = mkdtempSync(join(tmpdir(), "sa-main-watch-"));
  const db = new Database(join(directory, "superagent.db"));
  for (const statement of MIGRATIONS.slice(0, BEFORE_SPLIT)) db.exec(statement);
  const insert = db.prepare(
    `INSERT INTO main_watch (repo, last_head, state, detail, checked_at) VALUES (?, ?, ?, NULL, 1000)`,
  );
  rows.forEach((row, index) =>
    insert.run(index === 0 ? REPO : `example/app${index}`, row.lastHead, row.state),
  );
  return {
    db,
    upgrade: () => {
      for (const statement of MIGRATIONS.slice(BEFORE_SPLIT)) db.exec(statement);
    },
    close: () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function watchOnce(db: Database.Database, head: string, journal: string) {
  return runMainWatch({
    db,
    github: {
      pull: async () => {
        throw new Error("unused");
      },
      recentPulls: async () => ({ pulls: [], complete: true }),
      mainHead: async () => head,
    },
    readJournal: async () => ({ status: "ok", text: journal, truncated: false }),
    enabled: () => true,
    policy: () => repoPolicy([{ repo: REPO, accounts: { mac: [], linux: [] } }], []),
    questions: new QuestionStore(db),
    now: 2_000,
    signal: new AbortController().signal,
  });
}

function answerBaseline(db: Database.Database) {
  const questions = new QuestionStore(db);
  const question = questions.waiting().find((candidate) => candidate.kind === "main_bypass");
  if (question === undefined) throw new Error("no baseline question");
  questions.markOpen(question.id, "thr_bot", "tok", 2_000);
  return questions.answer(
    question.id,
    "tok",
    "ok",
    new Map([["main_bypass", bypassKind(db)]]),
    2_000,
  );
}

describe("main watch rows written before the confirmed head was kept apart", () => {
  it.each(["needs_reconcile", "bypass"])(
    "confirms nothing by itself after a %s row migrates, and asks the owner to set the baseline",
    async (state) => {
      const old = legacy([{ lastHead: B, state }]);
      try {
        old.upgrade();
        await watchOnce(
          old.db,
          B,
          [
            line({ outcome: "push-intent", base: X, final_sha: B }),
            line({ outcome: "merged", final_sha: B }),
          ].join("\n"),
        );
        expect(mainWatchRows(old.db)[0]).toMatchObject({
          anchor: null,
          observedHead: B,
          state: "needs_reconcile",
        });
        const asked = new QuestionStore(old.db).waiting();
        expect(asked.map((question) => question.subject)).toEqual([`baseline:${REPO}@${B}`]);
        expect(answerBaseline(old.db)).toBe("applied");
        expect(mainWatchRows(old.db)[0]).toMatchObject({ anchor: B, observedHead: B, state: "ok" });
      } finally {
        old.close();
      }
    },
  );

  it("asks for the baseline again when main moves before the owner answers, and refuses the old answer", async () => {
    const old = legacy([{ lastHead: B, state: "needs_reconcile" }]);
    try {
      old.upgrade();
      await watchOnce(old.db, B, "");
      const questions = new QuestionStore(old.db);
      expect(questions.waiting().map((question) => question.subject)).toEqual([
        `baseline:${REPO}@${B}`,
      ]);
      const first = questions.waiting()[0];
      if (first === undefined) throw new Error("not asked");
      questions.markOpen(first.id, "thr_bot", "tok", 2_000);
      await watchOnce(old.db, C, "");
      expect(
        questions.answer(
          first.id,
          "tok",
          "ok",
          new Map([["main_bypass", bypassKind(old.db)]]),
          2_000,
        ),
      ).toBe("unknown");
      expect(questions.waiting().map((question) => question.subject)).toEqual([
        `baseline:${REPO}@${C}`,
      ]);
      expect(mainWatchRows(old.db)[0]).toMatchObject({ anchor: null, state: "needs_reconcile" });
    } finally {
      old.close();
    }
  });

  it("asks for the baseline of a head again when main comes back to it, and the new card sets it", async () => {
    const old = legacy([{ lastHead: B, state: "needs_reconcile" }]);
    try {
      old.upgrade();
      const questions = new QuestionStore(old.db);
      await watchOnce(old.db, B, "");
      const [first] = questions.waiting();
      await watchOnce(old.db, C, "");
      const [second] = questions.waiting();
      await watchOnce(old.db, B, "");
      const asked = questions.waiting();
      expect(asked.map((question) => question.subject)).toEqual([`baseline:${REPO}@${B}`]);
      expect([first?.id, second?.id]).not.toContain(asked[0]?.id);
      expect([first, second].map((question) => questions.get(question?.id ?? "")?.state)).toEqual([
        "canceled",
        "canceled",
      ]);
      expect(answerBaseline(old.db)).toBe("applied");
      expect(mainWatchRows(old.db)[0]).toMatchObject({ anchor: B, observedHead: B, state: "ok" });
    } finally {
      old.close();
    }
  });

  it("asks for an unknown baseline once over several passes of an unchanged head", async () => {
    const old = legacy([{ lastHead: B, state: "needs_reconcile" }]);
    try {
      old.upgrade();
      const questions = new QuestionStore(old.db);
      await watchOnce(old.db, B, "");
      const first = questions.waiting().map((question) => question.id);
      await watchOnce(old.db, B, "");
      await watchOnce(old.db, B, "");
      expect(questions.waiting().map((question) => question.id)).toEqual(first);
      expect(first).toHaveLength(1);
    } finally {
      old.close();
    }
  });

  it("keeps an ok row as the confirmed head and judges the next train from it", async () => {
    const old = legacy([{ lastHead: A, state: "ok" }]);
    try {
      old.upgrade();
      await watchOnce(old.db, B, train(A, B));
      expect(mainWatchRows(old.db)[0]).toMatchObject({ anchor: B, observedHead: B, state: "ok" });
      expect(new QuestionStore(old.db).waiting()).toEqual([]);
    } finally {
      old.close();
    }
  });

  it("cancels a rollback card versioned by one head and asks it again only for a transition from a confirmed head", async () => {
    const old = legacy([{ lastHead: A, state: "needs_reconcile" }]);
    try {
      const card = {
        title: "rollback",
        observed: "observed",
        affected: "nothing",
        recommendation: "answer",
        options: [{ id: "yes", label: "Yes", recommended: false }],
      };
      old.db
        .prepare(
          `INSERT INTO questions (id, key, kind, subject, expected_version, card, priority, state, created_at)
           VALUES ('q_old', ?, 'main_rollback', ?, ?, ?, 50, 'queued', 1000)`,
        )
        .run(`main_rollback:${REPO}:${C}`, `${REPO}@${C}`, A, JSON.stringify(card));
      old.upgrade();
      expect(new QuestionStore(old.db).get("q_old")?.state).toBe("canceled");
      const journal = [train(C, A), line({ outcome: "rolled-back", final_sha: A })].join("\n");
      await watchOnce(old.db, C, journal);
      const questions = new QuestionStore(old.db);
      expect(questions.waiting().map((question) => question.kind)).toEqual(["main_bypass"]);
      expect(answerBaseline(old.db)).toBe("applied");
      expect(mainWatchRows(old.db)[0]).toMatchObject({ anchor: C, state: "ok" });
      await watchOnce(old.db, A, journal);
      expect(mainWatchRows(old.db)[0]).toMatchObject({ anchor: A, state: "ok" });
      await watchOnce(old.db, C, journal);
      expect(
        questions.waiting().map((question) => [question.kind, question.expectedVersion]),
      ).toEqual([["main_rollback", `${A}>${C}`]]);
    } finally {
      old.close();
    }
  });
});
