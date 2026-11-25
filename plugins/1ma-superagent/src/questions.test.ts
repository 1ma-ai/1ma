import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { inPlace } from "./background.js";
import { QuestionDispatcher } from "./dispatcher.js";
import {
  type Card,
  type QuestionKind,
  QUESTION_TIMEOUT_MS,
  QuestionStore,
  questionPayloadSchema,
} from "./questions.js";
import { MIGRATIONS } from "./schema.js";
import { strings } from "../strings.js";

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
    onAnswer: (question, optionId) => {
      answers.push({ subject: question.subject, optionId });
    },
  };
  const kinds = new Map([["test", kind]]);
  const { bb, harness } = createFakePluginHost({ pluginId: "1ma-superagent" });
  let clock = 1_000;
  const advance = (ms: number) => {
    clock += ms;
  };
  const makeDispatcher = (signal = new AbortController().signal, closeGraceMs?: number) =>
    new QuestionDispatcher({
      requestInput: (request, requestOptions) => bb.ui.requestInput(request, requestOptions),
      warn: () => {},
      background: inPlace,
      store,
      chat: () => CHAT,
      now: () => clock,
      signal,
      ...(closeGraceMs === undefined ? {} : { closeGraceMs }),
    });
  const decide = (request: { payload: unknown }, optionId: string) => {
    const { questionId, token } = payloadOf(request);
    return store.answer(questionId, token, optionId, kinds, 1_500);
  };
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
    decide,
    makeDispatcher,
    ask,
    pending,
    harness,
    advance,
    settle: settleTimers,
  };
}

function kindsOf(answers: Array<{ subject: string; optionId: string }>) {
  const kind: QuestionKind = {
    currentVersion: () => "v1",
    onAnswer: (question, optionId) => {
      answers.push({ subject: question.subject, optionId });
    },
  };
  return new Map([["test", kind]]);
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

  it("applies a decision once and opens the next card when the card closes", async () => {
    const { makeDispatcher, ask, pending, harness, answers, decide, settle } = setup();
    ask("first");
    ask("second");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    expect(decide(first, "yes")).toBe("applied");
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "yes",
    });
    await settle();
    expect(answers).toEqual([{ subject: "first", optionId: "yes" }]);
    expect(pending().map((request) => payloadOf(request).title)).toEqual(["second"]);
  });

  it("does not apply a decision to a card whose work changed meanwhile", () => {
    const { makeDispatcher, ask, pending, answers, versions, store, decide } = setup();
    ask("first");
    makeDispatcher().dispatch();
    versions.set("first", "v2");
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    expect(decide(first, "yes")).toBe("stale");
    expect(answers).toEqual([]);
    expect(store.latest("first")?.state).toBe("stale");
  });

  it("does not take an answer that closed the card without a recorded decision, and asks again with a note", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, advance, settle } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    const dispatcher = makeDispatcher();
    dispatcher.dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    expect(payloadOf(first).unrecorded).toBe(false);
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "yes",
    });
    await settle();
    expect(answers).toEqual([]);
    advance(30_000);
    dispatcher.dispatch();
    expect(store.get(id)?.state).toBe("open");
    const again = pending().at(-1);
    if (again === undefined || again.id === first.id) throw new Error("not asked again");
    expect(payloadOf(again)).toMatchObject({ questionId: id, unrecorded: true });
  });

  it("lets the other waiting questions through while a card is answered past decide, and shows it a bounded number of times", async () => {
    const { makeDispatcher, ask, pending, harness, answers, settle } = setup();
    const firstId = ask("first");
    const secondId = ask("second");
    makeDispatcher().dispatch();
    const shown: string[] = [];
    for (let n = 0; n < 5; n += 1) {
      const request = pending()[0];
      if (request === undefined) break;
      const payload = payloadOf(request);
      shown.push(payload.questionId);
      harness.behavior.submitInteraction(request.id, { token: payload.token, optionId: "yes" });
      await settle();
    }
    expect(answers).toEqual([]);
    expect(shown).toEqual([firstId, secondId]);
  });

  it("asks again after an answer past decide only after 30 seconds, then 2 minutes, then every 10 minutes, until the original deadline", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, advance, settle } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    const deadline = store.get(id)?.expiresAt;
    const dispatcher = makeDispatcher();
    dispatcher.dispatch();
    const bypass = async () => {
      const request = pending()[0];
      if (request === undefined) throw new Error("no card");
      harness.behavior.submitInteraction(request.id, {
        token: payloadOf(request).token,
        optionId: "yes",
      });
      await settle();
    };
    const shownAfter = (ms: number) => {
      advance(ms);
      dispatcher.dispatch();
      return pending().length === 1;
    };
    await bypass();
    expect(shownAfter(29_999)).toBe(false);
    expect(shownAfter(1)).toBe(true);
    await bypass();
    expect(shownAfter(119_999)).toBe(false);
    expect(shownAfter(1)).toBe(true);
    await bypass();
    expect(shownAfter(599_999)).toBe(false);
    expect(shownAfter(1)).toBe(true);
    await bypass();
    expect(shownAfter(599_999)).toBe(false);
    expect(shownAfter(1)).toBe(true);
    expect(store.get(id)?.expiresAt).toBe(deadline);
    await bypass();
    advance(QUESTION_TIMEOUT_MS);
    dispatcher.dispatch();
    expect(pending()).toHaveLength(0);
    expect(store.get(id)?.state).toBe("expired");
    expect(answers).toEqual([]);
  });

  it("does not name an option in the closed card's title when no decision was recorded", () => {
    const { makeDispatcher, ask, pending } = setup();
    ask("first");
    makeDispatcher().dispatch();
    const request = pending()[0];
    if (request?.describeSubmission === undefined) throw new Error("no card");
    const described = request.describeSubmission({
      token: payloadOf(request).token,
      optionId: "yes",
    });
    expect(described).toEqual({ title: strings.cardClosedUnrecorded("first") });
    expect(JSON.stringify(described)).not.toContain("Yes");
  });

  it("titles the closed card with the recorded decision, not with the option the closing answer carries", () => {
    const { makeDispatcher, ask, pending, decide } = setup();
    ask("first");
    makeDispatcher().dispatch();
    const request = pending()[0];
    if (request?.describeSubmission === undefined) throw new Error("no card");
    expect(decide(request, "yes")).toBe("applied");
    const described = request.describeSubmission({
      token: payloadOf(request).token,
      optionId: "no",
    });
    expect(described).toEqual({ title: strings.cardClosedDecided("first", "Yes") });
  });

  it("keeps the recorded decision when the closing answer carries another option", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, decide, settle } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    expect(decide(first, "yes")).toBe("applied");
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "no",
    });
    await settle();
    expect(answers).toEqual([{ subject: "first", optionId: "yes" }]);
    expect(store.get(id)).toMatchObject({ state: "answered", answer: "yes" });
    expect(pending()).toHaveLength(0);
  });

  it("keeps the question open with nothing done when the plugin stops right after an answer that bypassed the card", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, settle } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    const lifecycle = new AbortController();
    makeDispatcher(lifecycle.signal).dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    harness.behavior.submitInteraction(first.id, {
      token: payloadOf(first).token,
      optionId: "yes",
    });
    lifecycle.abort();
    await settle();
    expect(store.get(id)?.state).toBe("open");
    makeDispatcher().dispatch();
    expect(store.get(id)?.state).toBe("open");
    expect(pending().filter((request) => payloadOf(request).questionId === id)).toHaveLength(1);
    expect(answers).toEqual([]);
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

  it("refuses a decision with a forged option and keeps the question waiting", () => {
    const { makeDispatcher, ask, pending, answers, store, decide } = setup();
    ask("first");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    expect(decide(first, "launch-everything")).toBe("rejected");
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
    expect(store.latest("first")?.state).toBe("dismissed");
  });

  it("records a decision before the card closes and does not apply it again when the card's answer arrives", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, settle } = setup();
    const id = ask("first");
    ask("second");
    if (id === null) throw new Error("not asked");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    const { questionId, token } = payloadOf(first);
    expect(questionId).toBe(id);
    expect(store.answer(questionId, token, "yes", kindsOf(answers), 1_500)).toBe("applied");
    expect(store.cardState(questionId, token)).toMatchObject({ open: false, decided: "yes" });
    harness.behavior.submitInteraction(first.id, { token, optionId: "yes" });
    await settle();
    expect(answers).toEqual([{ subject: "first", optionId: "yes" }]);
    expect(store.latest("first")?.state).toBe("answered");
    expect(pending().map((request) => payloadOf(request).title)).toEqual(["second"]);
  });

  it("closes a card whose decision is recorded when the client never closes it, and shows the next question", async () => {
    const { makeDispatcher, ask, pending, decide, store } = setup();
    ask("first");
    ask("second");
    const dispatcher = makeDispatcher(undefined, 5);
    dispatcher.dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    expect(decide(first, "yes")).toBe("applied");
    dispatcher.dispatch();
    expect(pending().map((request) => payloadOf(request).title)).toEqual(["first"]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pending().map((request) => payloadOf(request).title)).toEqual(["second"]);
    expect(store.latest("first")).toMatchObject({ state: "answered", answer: "yes" });
  });

  it("closes a card that went stale while open when the client never closes it", async () => {
    const { makeDispatcher, ask, pending, versions, decide, store } = setup();
    ask("first");
    ask("second");
    const dispatcher = makeDispatcher(undefined, 5);
    dispatcher.dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    versions.set("first", "v2");
    expect(decide(first, "yes")).toBe("stale");
    expect(store.cardState(payloadOf(first).questionId, payloadOf(first).token)).toMatchObject({
      open: false,
      decided: null,
      outdated: "stale",
    });
    dispatcher.dispatch();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(pending().map((request) => payloadOf(request).title)).toEqual(["second"]);
    expect(store.latest("first")?.state).toBe("stale");
  });

  it("does not ask again after a restart that came between recording a decision and closing the card", () => {
    const { makeDispatcher, ask, pending, answers, store } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    makeDispatcher().dispatch();
    const token = payloadOf(pending()[0] ?? { payload: null }).token;
    store.answer(id, token, "yes", kindsOf(answers), 1_500);
    makeDispatcher().dispatch();
    expect(pending()).toHaveLength(1);
    expect(store.answer(id, token, "no", kindsOf(answers), 1_600)).toBe("rejected");
    expect(answers).toEqual([{ subject: "first", optionId: "yes" }]);
  });

  it("neither accepts nor reopens a card after its deadline", async () => {
    const { makeDispatcher, ask, pending, harness, answers, store, settle } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    makeDispatcher().dispatch();
    const first = pending()[0];
    if (first === undefined) throw new Error("no card");
    const late = 1_000 + QUESTION_TIMEOUT_MS;
    expect(store.answer(id, payloadOf(first).token, "yes", kindsOf(answers), late)).toBe("stale");
    expect(store.latest("first")?.state).toBe("expired");
    expect(store.next(late)).toBeNull();
    harness.behavior.cancelInteraction(first.id);
    await settle();
    expect(answers).toEqual([]);
  });

  it("closes a card that timed out instead of opening it again", async () => {
    const { ask, store, settle } = setup();
    ask("first");
    const opened: number[] = [];
    const dispatcher = new QuestionDispatcher({
      requestInput: async (request) => {
        opened.push(request.timeoutMs ?? 0);
        return { outcome: "cancelled", reason: "timeout" };
      },
      warn: () => {},
      background: inPlace,
      store,
      chat: () => CHAT,
      now: () => 1_000,
      signal: new AbortController().signal,
    });
    dispatcher.dispatch();
    await settle();
    expect(opened).toEqual([QUESTION_TIMEOUT_MS]);
    expect(store.latest("first")?.state).toBe("expired");
  });

  it("writes nothing for a card whose answer arrives after the plugin was turned off", async () => {
    const { ask, store, settle } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    const lifecycle = new AbortController();
    let answer: (value: { outcome: "cancelled"; reason: "plugin-disposed" }) => void = () => {};
    const dispatcher = new QuestionDispatcher({
      requestInput: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      warn: () => {},
      background: inPlace,
      store,
      chat: () => CHAT,
      now: () => 1_000,
      signal: lifecycle.signal,
    });
    dispatcher.dispatch();
    const token = store.get(id)?.token;
    lifecycle.abort();
    answer({ outcome: "cancelled", reason: "plugin-disposed" });
    await settle();
    expect(store.get(id)).toMatchObject({ state: "open", token });
  });

  it("counts the questions still waiting behind an open card as the queue changes", () => {
    const { makeDispatcher, ask, pending, store } = setup();
    const id = ask("first");
    if (id === null) throw new Error("not asked");
    makeDispatcher().dispatch();
    const { token, waiting } = payloadOf(pending()[0] ?? { payload: null });
    expect(waiting).toBe(0);
    ask("second");
    ask("third");
    expect(store.cardState(id, token).waiting).toBe(2);
  });
});
