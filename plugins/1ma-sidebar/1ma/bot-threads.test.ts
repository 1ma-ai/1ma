import { describe, expect, it } from "vitest";
import { botBranches, threadsShownUnderBots } from "./bot-threads.js";

const bot = (threadIds: string[], hidden = false, id = "bot_1") => ({
  id,
  name: "Bot",
  role: "",
  avatar: "",
  hidden,
  threads: threadIds.map((threadId) => ({ threadId, startedFromBot: true, completed: false })),
});

describe("conversations shown under bots", () => {
  it("takes a bot's conversations with all their descendants", () => {
    const threads = [
      { id: "a", parentThreadId: null },
      { id: "a1", parentThreadId: "a" },
      { id: "a11", parentThreadId: "a1" },
      { id: "b", parentThreadId: null },
    ];
    expect([...threadsShownUnderBots([bot(["a"])], threads)].sort()).toEqual(["a", "a1", "a11"]);
  });

  it("leaves a hidden bot's conversations and survives a parent cycle", () => {
    const threads = [
      { id: "x", parentThreadId: "y" },
      { id: "y", parentThreadId: "x" },
    ];
    expect(threadsShownUnderBots([bot(["x"], true)], threads).size).toBe(0);
    expect([...threadsShownUnderBots([bot(["x"])], threads)].sort()).toEqual(["x", "y"]);
  });

  it("a hidden bot's conversation inside another bot's chat stays in its project", () => {
    const threads = [
      { id: "a", parentThreadId: null },
      { id: "h", parentThreadId: "a" },
      { id: "h1", parentThreadId: "h" },
    ];
    expect([...threadsShownUnderBots([bot(["a"]), bot(["h"], true, "bot_2")], threads)]).toEqual([
      "a",
    ]);
  });
});

describe("a conversation's branch in its bot", () => {
  it("runs up to the top of the bot's tree and stops at another bot's chat", () => {
    const threads = [
      { id: "plain", parentThreadId: null },
      { id: "a", parentThreadId: "plain" },
      { id: "spawned", parentThreadId: "a" },
      { id: "a2", parentThreadId: "spawned" },
      { id: "b", parentThreadId: "a2" },
      { id: "b1", parentThreadId: "b" },
    ];
    const branches = botBranches([bot(["a", "a2"]), bot(["b"], false, "bot_2")], threads);
    expect(Object.fromEntries(branches)).toEqual({
      a: { botId: "bot_1", threadIds: ["a"] },
      spawned: { botId: "bot_1", threadIds: ["spawned", "a"] },
      a2: { botId: "bot_1", threadIds: ["a2", "spawned", "a"] },
      b: { botId: "bot_2", threadIds: ["b"] },
      b1: { botId: "bot_2", threadIds: ["b1", "b"] },
    });
  });
});
