// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { useSectionThreadDnd } from "../app/dnd/useSectionThreadDnd.js";
import { makeSidebarThread } from "../app/model/fixtures.js";

type DndArgs = Parameters<typeof useSectionThreadDnd>[0];

const captured = vi.hoisted(() => ({ dnd: undefined as unknown, error: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: captured.error } }));
vi.mock("../app/dnd/useSectionThreadDnd.js", () => ({
  useSectionThreadDnd: (args: unknown) => {
    captured.dnd = args;
    return null;
  },
}));
vi.mock("../app/list/ProjectRow.js", () => ({
  SectionThreadTreeItems: () => null,
  SectionThreadDragOverlayPortal: () => null,
}));
installTestPluginRuntime();
const { BotThreadTree } = await import("./BotThreadTree.js");

afterEach(() => {
  cleanup();
  captured.error.mockClear();
});

// "guest" stands at the top of this bot's tree under another bot's chat;
// "spawned" is a sub-thread without its own place in the bot.
const THREADS = [
  makeSidebarThread({ id: "main" }),
  makeSidebarThread({ id: "guest", parentThreadId: "elsewhere" }),
  makeSidebarThread({ id: "parent" }),
  makeSidebarThread({ id: "first", parentThreadId: "parent" }),
  makeSidebarThread({ id: "second", parentThreadId: "parent" }),
  makeSidebarThread({ id: "spawned", parentThreadId: "parent" }),
];

function renderTree(answer: () => { ok: true } = () => ({ ok: true })) {
  const moves: unknown[] = [];
  const { inspection } = renderSlot(
    { component: BotThreadTree as never },
    {
      bot: {
        id: "bot_m",
        name: "Marketer",
        role: "",
        avatar: "",
        hidden: false,
        threads: ["main", "archived", "guest", "parent", "first", "second"].map((threadId) => ({
          threadId,
          startedFromBot: true,
          completed: false,
        })),
      },
      threads: THREADS,
      compareThreads: () => 0,
      collapsedThreadIds: new Set(),
    } as never,
    {
      rpc: {
        "bots.v1.moveThreads": (input: unknown) => {
          moves.push(input);
          return answer();
        },
      },
    },
  );
  const { accepts, drop } = (captured.dnd as DndArgs).botReorder!;
  return { accepts, drop, moves, inspection };
}

describe("a drop on the edge of a bot's conversation", () => {
  it("takes only conversations with a place in the bot's order", () => {
    const { accepts } = renderTree();
    expect(accepts(["second", "main"], "first")).toBe(true);
    expect(accepts(["second", "spawned"], "first")).toBe(false);
    expect(accepts(["second"], "spawned")).toBe(false);
  });

  it.each([
    [["second"], { threadId: "first", placement: "before" }],
    [["second", "first"], { threadId: "main", placement: "after" }],
    [["main"], { threadId: "guest", placement: "after" }],
  ] as const)("sends %o to %o as it was dropped, in one call", async (threadIds, target) => {
    const { drop, moves, inspection } = renderTree();
    drop(threadIds, target);
    await waitFor(() => expect(moves).toEqual([{ botId: "bot_m", threadIds, target }]));
    expect(inspection.sdkCalls).toEqual([]);
    expect(captured.error).not.toHaveBeenCalled();
  });

  it("says why the move failed", async () => {
    const { drop } = renderTree(() => {
      throw new Error("The parent is archived");
    });
    drop(["second"], { threadId: "main", placement: "after" });
    await waitFor(() => expect(captured.error).toHaveBeenCalledWith("The parent is archived"));
  });
});
