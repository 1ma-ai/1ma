import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createBackground } from "./background.js";
import { QuestionDispatcher } from "./dispatcher.js";
import { FULL_SCOPE, PassRunner } from "./pass-runner.js";
import { QuestionStore } from "./questions.js";
import { MIGRATIONS } from "./schema.js";

const toolCall = new AsyncLocalStorage<string>();

describe("background work started from a tool call", () => {
  it("runs the pass outside the tool call's async context", async () => {
    const background = createBackground();
    let seen: string | undefined = "unset";
    const runner = new PassRunner(
      async () => {
        seen = toolCall.getStore();
      },
      () => {},
      background,
    );
    await toolCall.run("tool-call-1", () => runner.request(FULL_SCOPE));
    expect(seen).toBeUndefined();
  });

  it("opens a card outside the tool call's async context, so bb does not detach the tool call", () => {
    const background = createBackground();
    const db = new Database(":memory:");
    for (const statement of MIGRATIONS) db.exec(statement);
    const store = new QuestionStore(db);
    store.ask(
      {
        key: "k",
        kind: "test",
        subject: "s",
        expectedVersion: "1",
        card: {
          title: "t",
          observed: "",
          affected: "",
          recommendation: "",
          options: [{ id: "ok", label: "OK", recommended: true }],
        },
        priority: 1,
      },
      1,
    );
    let seen: string | undefined = "unset";
    const dispatcher = new QuestionDispatcher({
      requestInput: () => {
        seen = toolCall.getStore();
        return new Promise(() => {});
      },
      warn: () => {},
      store,
      kinds: new Map(),
      chat: () => "thr_bot",
      now: () => 1,
      onAnswered: () => {},
      signal: new AbortController().signal,
      background,
    });
    toolCall.run("tool-call-1", () => dispatcher.dispatch());
    expect(seen).toBeUndefined();
  });
});
