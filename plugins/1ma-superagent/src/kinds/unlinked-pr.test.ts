import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PrStore } from "../pr-store.js";
import { QuestionStore } from "../questions.js";
import { repoPolicy } from "../repos.js";
import { MIGRATIONS } from "../schema.js";
import { UNLINKED_GRACE_MS, askAboutUnlinked, unlinkedKind } from "./unlinked-pr.js";

const policy = repoPolicy([{ repo: "example/app", accounts: { mac: ["mac-bot"], linux: [] } }], []);

function setup(author = "mac-bot", hint: string | null = "mac:thr_a") {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const prStore = new PrStore(db);
  const questions = new QuestionStore(db);
  prStore.record(
    {
      repo: "example/app",
      number: 7,
      state: "open",
      author,
      headRepo: "example/app",
      headRef: "feature/x",
      headSha: "abc",
      updatedAt: 1,
    },
    { kind: "none", problem: null },
    hint,
    1_000,
  );
  return { prStore, questions };
}

describe("unlinked PR questions", () => {
  it("asks only after the grace period, recommends the one chat on the PR's branch first", () => {
    const { prStore, questions } = setup();
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS - 1);
    expect(questions.waiting()).toEqual([]);
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS);
    const [question] = questions.waiting();
    expect(question?.card.options[0]).toMatchObject({ id: "link0", recommended: true });
    expect(question?.card.options.filter((option) => option.recommended)).toHaveLength(1);
  });

  it("does not ask about a PR by someone else's account", () => {
    const { prStore, questions } = setup("stranger");
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS);
    expect(questions.waiting()).toEqual([]);
  });

  it("links the PR by hand when the owner picks the chat", () => {
    const { prStore, questions } = setup();
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS);
    const [question] = questions.waiting();
    if (question === undefined) throw new Error("no question");
    questions.markOpen(question.id, "thr_bot", "t", 2_000);
    const outcome = questions.answer(
      question.id,
      "t",
      "link0",
      new Map([["unlinked_pr", unlinkedKind(prStore)]]),
      2_000,
    );
    expect(outcome).toBe("applied");
    expect(prStore.get("example/app", 7)).toMatchObject({
      linkKind: "manual",
      deliveryServerId: "mac",
      deliveryThreadId: "thr_a",
    });
    askAboutUnlinked(prStore, questions, policy, 3_000 + UNLINKED_GRACE_MS);
    expect(questions.waiting()).toEqual([]);
  });

  it("recommends leaving the PR unlinked when no chat or several chats share its branch", () => {
    const { prStore, questions } = setup("mac-bot", "mac:thr_a,mac:thr_b");
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS);
    expect(questions.waiting()[0]?.card.options[0]).toMatchObject({
      id: "leave",
      recommended: true,
    });
  });
});
