import { describe, expect, it } from "vitest";
import { threadsShownUnderBots } from "./bot-threads.js";

const bot = (threadIds: string[], hidden = false) => ({
  id: "bot_1",
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
});
