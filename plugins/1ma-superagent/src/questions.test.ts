import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { QuestionDispatcher } from "./dispatcher.js";
import {
  type AnswerOutcome,
  type Card,
  type QuestionKind,
  QuestionStore,
  questionPayloadSchema,
} from "./questions.js";
import { MIGRATIONS } from "./schema.js";

const CHAT = "thr_bot";

function settleTimers() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function card(title: string): Card {
  return {
    title,
    observed: "observed",
    affected: "nothing",
    recommendation: "wait",
    options: [
      { id: "yes", label: "Yes", recommended: true },
      { id: "no", label: "No", recommended: false },
    ],
  };
}

function setup() {
  const db = new Database(":memory:");
  for (const statement of MIGRATIONS) db.exec(statement);
  const store = new QuestionStore(db);
  const versions = new Map<string, string>();
  const answers: Array<{ subject: string; optionId: string }> = [];
  const kind: QuestionKind = {
    currentVersion: (subject) => versions.get(subject) ?? null,
    onAnswer: (question, optionId) => answers.push({ subject: question.subject, optionId }),
  };
  const kinds = new Map([["test", kind]]);
  const { bb, harness } = createFakePluginHost({ pluginId: "1ma-superagent" });
  const outcomes: AnswerOutcome[] = [];
  const lifecycle = new AbortController();
  const makeDispatcher = () =>
    new QuestionDispatcher({
      bb,
      store,
      kinds,
      chat: () => CHAT,
      now: () => 1_000,
      onAnswered: (outcome) => outcomes.push(outcome),
      signal: lifecycle.signal,
    });
  const ask = (key: string, subject = key) => {
    versions.set(subject, "v1");
    return store.ask(
      { key, kind: "test", subject, expectedVersion: "v1", card: card(key), priority: 1 },
      1_000,
    );
  };
  const pending = () => harness.inspection.pendingInteractions;
  return {
    store,
    versions,
    answers,
    outcomes,
    makeDispatcher,
    ask,
    pending,
    harness,
    settle: settleTimers,
  };
}

function payloadOf(request: { payload: unknown }) {
  return questionPayloadSchema.parse(request.payload);
}

describe("question dispatcher", () => {
  it("keeps one card open in the chat and shows how many more wait", async () => {
    const { makeDispatcher, ask, pending } = setup();
    ask("first");
    ask("second");
    const dispatcher = makeDispatcher();
    dispatcher.dispatch();
    dispatcher.dispatch();
    expect(pending()).toHaveLength(1);
    expect(pending()[0]?.threadId).toBe(CHAT);
    expect(payloadOf(pending()[0] ?? { payload: null })).toMatchObject({
      title: "first",
      waiting: 1,
    });
  });

  it("does not queue the same question twice", () => {
    const { store, ask } = setup();
    expect(ask("same")).not.toBeNull();
    expect(ask("same")).toBeNull();
    expect(store.waiting()).toHaveLength(1);
  });

  it("applies an answer once and opens the next card", async () => {
    const { makeDispatcher, ask, pending, harness, answers, outcomes, settle } = setup();
    ask("first");
    ask("second");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "yes",
    });
    await settle();
    expect(answers).toEqual([{ subject: "first", optionId: "yes" }]);
    expect(outcomes).toEqual(["applied"]);
    expect(pending().map((request) => payloadOf(request).title)).toEqual(["second"]);
  });

  it("does not apply an answer to a card whose work changed meanwhile", async () => {
    const { makeDispatcher, ask, pending, harness, answers, outcomes, versions, store, settle } =
      setup();
    ask("first");
    makeDispatcher().dispatch();
    versions.set("first", "v2");
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "yes",
    });
    await settle();
    expect(answers).toEqual([]);
    expect(outcomes).toEqual(["stale"]);
    expect(store.latest("first")?.state).toBe("stale");
  });

  it("reopens a card after a reload and refuses an answer meant for the old card", async () => {
    const { makeDispatcher, ask, store, answers } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    makeDispatcher().dispatch();
    const oldToken = store.get(id)?.token;
    makeDispatcher().dispatch();
    const newToken = store.get(id)?.token;
    expect(newToken).not.toBe(oldToken);
    expect(store.answer(id, oldToken ?? "", "yes", new Map(), 2_000)).toBe("unknown");
    expect(answers).toEqual([]);
  });

  it("refuses an answer with a forged option and keeps the question waiting", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, settle } = setup();
    ask("first");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "launch-everything",
    });
    await settle();
    expect(answers).toEqual([]);
    expect(store.waiting()).toHaveLength(1);
  });

  it("closes a card the owner dismissed", async () => {
    const { makeDispatcher, ask, pending, harness, store, settle } = setup();
    ask("first");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    harness.behavior.cancelInteraction(first.id);
    await settle();
    expect(store.latest("first")?.state).toBe("canceled");
  });
});
