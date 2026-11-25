import { describe, expect, it } from "vitest";
import { botBranches, threadsShownUnderBots } from "./bot-threads.js";

const bot = (hidden = false, id = "bot_1") => ({ id, hidden });

const members = (threadIds: string[], botId = "bot_1") =>
  Object.fromEntries(
    threadIds.map((threadId, position) => [
      threadId,
      { botId, startedFromBot: true, completed: false, position },
    ]),
  );

const row = (id: string, parentThreadId: string | null, state = {}) => ({
  id,
  parentThreadId,
  isArchived: false,
  isHidden: false,
  ...state,
});

describe("conversations shown under bots", () => {
  it("takes a bot's conversations with all their descendants", () => {
    const threads = [row("a", null), row("a1", "a"), row("a11", "a1"), row("b", null)];
    expect([...threadsShownUnderBots([bot()], members(["a"]), threads)].sort()).toEqual([
      "a",
      "a1",
      "a11",
    ]);
  });

  it("leaves a hidden bot's conversations and survives a parent cycle", () => {
    const threads = [row("x", "y"), row("y", "x")];
    expect(threadsShownUnderBots([bot(true)], members(["x"]), threads).size).toBe(0);
    expect([...threadsShownUnderBots([bot()], members(["x"]), threads)].sort()).toEqual(["x", "y"]);
  });

  it("a hidden bot's conversation inside another bot's chat stays in its project", () => {
    const threads = [row("a", null), row("h", "a"), row("h1", "h")];
    const both = { ...members(["a"]), ...members(["h"], "bot_2") };
    expect([...threadsShownUnderBots([bot(), bot(true, "bot_2")], both, threads)]).toEqual(["a"]);
  });
});

describe("a conversation's branch in its bot", () => {
  it("runs up to the top of the bot's tree and stops at another bot's chat", () => {
    const threads = [
      row("plain", null),
      row("a", "plain"),
      row("spawned", "a"),
      row("a2", "spawned"),
      row("b", "a2"),
      row("b1", "b"),
    ];
    const branches = botBranches(
      { plain: null, ...members(["a", "a2"]), ...members(["b"], "bot_2") },
      threads,
    );
    expect(Object.fromEntries(branches)).toEqual({
      a: { botId: "bot_1", threadIds: ["a"] },
      spawned: { botId: "bot_1", threadIds: ["spawned", "a"] },
      a2: { botId: "bot_1", threadIds: ["a2", "spawned", "a"] },
      b: { botId: "bot_2", threadIds: ["b"] },
      b1: { botId: "bot_2", threadIds: ["b1", "b"] },
    });
  });

  it.each([{ isHidden: true }, { isArchived: true }, null])(
    "stops at a conversation the bot's tree does not show: %o",
    (state) => {
      const threads = [
        row("a", null),
        ...(state === null ? [] : [row("between", "a", state)]),
        row("a2", "between"),
        row("spawned", "a2"),
      ];
      const branches = botBranches(members(["a", "between", "a2"]), threads);
      expect(branches.get("a2")).toEqual({ botId: "bot_1", threadIds: ["a2"] });
      expect(branches.get("spawned")).toEqual({ botId: "bot_1", threadIds: ["spawned", "a2"] });
      expect(branches.get("between")).toEqual(
        state === null ? undefined : { botId: "bot_1", threadIds: ["between", "a"] },
      );
    },
  );
});
