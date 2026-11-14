import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { GitHubReader } from "./github/reader.js";
import { judgeMainHead, parseJournal } from "./journal.js";
import { mainWatchRows, runMainWatch } from "./main-watch.js";
import { QuestionStore } from "./questions.js";
import { repoPolicy } from "./repos.js";
import { MIGRATIONS } from "./schema.js";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function line(record: Record<string, unknown>) {
  return JSON.stringify({ author: "release-train", repo: "example/app", attempt: "t1", ...record });
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
      line({ event: "merged", final_sha: A }),
    ].join("\n");
    expect(parseJournal(text)).toEqual([
      { repo: "example/app", attempt: "t1", event: "merged", finalSha: A },
    ]);
  });

  it("explains a merged head, needs a reconcile for an unconfirmed push or a move after rollback", () => {
    const merged = parseJournal(line({ event: "merged", final_sha: A }));
    expect(judgeMainHead(merged, "example/app", A)).toEqual({ kind: "explained" });
    const intent = parseJournal(
      [line({ event: "started" }), line({ event: "push-intent", final_sha: B })].join("\n"),
    );
    expect(judgeMainHead(intent, "example/app", B).kind).toBe("needs_reconcile");
    const rolledBack = parseJournal(
      [line({ event: "merged", final_sha: A }), line({ event: "rolled-back", final_sha: A })].join(
        "\n",
      ),
    );
    expect(judgeMainHead(rolledBack, "example/app", C).kind).toBe("needs_reconcile");
    expect(judgeMainHead(merged, "example/app", C)).toEqual({ kind: "unexplained" });
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
  const run = (path: string | null = "/train/journal.jsonl") =>
    runMainWatch({
      db,
      github,
      readJournal: async () => ({ status: "ok", text: journal, truncated: false }),
      journalPath: path,
      policy: repoPolicy([{ repo: "example/app", accounts: { mac: [], linux: [] } }], []),
      questions,
      now: 1_000,
      signal: new AbortController().signal,
    });
  return { db, questions, run, setHead: (value: string) => (head = value) };
}

describe("main watch", () => {
  it("takes the first head as a baseline and asks once about a head the train did not write", async () => {
    const t = setup(line({ event: "merged", final_sha: B }));
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

  it("is off without a journal path", async () => {
    const t = setup("");
    await t.run(null);
    expect(mainWatchRows(t.db)).toEqual([]);
  });
});
