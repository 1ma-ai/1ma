import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { PrStore } from "../pr-store.js";
import { QuestionStore } from "../questions.js";
import { repoPolicy } from "../repos.js";
import { MIGRATIONS } from "../schema.js";
import { Store } from "../store.js";
import { threadSummary } from "../test-helpers.js";
import { FRESH_MS, UNLINKED_GRACE_MS, askAboutUnlinked, unlinkedKind } from "./unlinked-pr.js";

const policy = repoPolicy([{ repo: "example/app", accounts: { mac: ["mac-bot"], linux: [] } }], []);

function setup(author = "mac-bot", hint: string | null = "mac:thr_a") {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const prStore = new PrStore(db);
  const questions = new QuestionStore(db);
  const store = new Store(db);
  const seeChats = (threadIds: string[], observedAt: number) =>
    store.applySnapshot(
      "mac",
      {
        threads: threadIds.map((threadId) => threadSummary({ threadId, environmentId: "env_x" })),
        environments: [{ environmentId: "env_x", projectId: "proj_app", branch: "feature/x" }],
        projects: [{ projectId: "proj_app", gitRemoteUrl: "https://github.com/example/app.git" }],
      },
      { observedAt, completeness: "complete" },
      null,
    );
  seeChats(["thr_a", "thr_b"], 1_000);
  const recordPull = (state: "open" | "closed", at: number) =>
    prStore.record(
      {
        repo: "example/app",
        number: 7,
        state,
        author,
        headRepo: "example/app",
        headRef: "feature/x",
        headSha: "abc",
        createdAt: 0,
        updatedAt: 1,
      },
      { kind: "none", problem: null },
      hint,
      at,
    );
  const kinds = new Map([["unlinked_pr", unlinkedKind(prStore, store)]]);
  const openCard = () => {
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS);
    const [question] = questions.waiting();
    if (question === undefined) throw new Error("no question");
    questions.markOpen(question.id, "thr_bot", "t", 2_000);
    return question.id;
  };
  prStore.record(
    {
      repo: "example/app",
      number: 7,
      state: "open",
      author,
      headRepo: "example/app",
      headRef: "feature/x",
      headSha: "abc",
      createdAt: 0,
      updatedAt: 1,
    },
    { kind: "none", problem: null },
    hint,
    1_000,
  );
  return { prStore, questions, seeChats, recordPull, kinds, openCard };
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
    const { prStore, questions, kinds } = setup();
    askAboutUnlinked(prStore, questions, policy, 1_000 + UNLINKED_GRACE_MS);
    const [question] = questions.waiting();
    if (question === undefined) throw new Error("no question");
    questions.markOpen(question.id, "thr_bot", "t", 2_000);
    const outcome = questions.answer(question.id, "t", "link0", kinds, 2_000);
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

  it("does not link a PR that closed while its card was open", () => {
    const { prStore, questions, recordPull, kinds, openCard } = setup();
    const id = openCard();
    recordPull("closed", 1_500);
    expect(questions.answer(id, "t", "link0", kinds, 2_000)).toBe("stale");
    expect(prStore.get("example/app", 7)?.linkKind).toBeNull();
  });

  it("does not link to a chat archived while the card was open", () => {
    const { prStore, questions, seeChats, kinds, openCard } = setup();
    const id = openCard();
    seeChats(["thr_b"], 1_500);
    expect(questions.answer(id, "t", "link0", kinds, 2_000)).toBe("stale");
    expect(prStore.get("example/app", 7)?.linkKind).toBeNull();
  });

  it("does not link when the PR or the chat was not observed recently", () => {
    const { prStore, questions, kinds, openCard } = setup();
    const id = openCard();
    expect(questions.answer(id, "t", "link0", kinds, 1_000 + FRESH_MS + 1)).toBe("stale");
    expect(prStore.get("example/app", 7)?.linkKind).toBeNull();
  });
});
