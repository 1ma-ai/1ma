// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { useSectionThreadDnd } from "../app/dnd/useSectionThreadDnd.js";
import { makeSidebarThread } from "../app/model/fixtures.js";
import type { ProjectThreadItem } from "../app/model/project-thread-groups.js";

type DndArgs = Parameters<typeof useSectionThreadDnd>[0];

const captured = vi.hoisted(() => ({
  dnd: undefined as unknown,
  items: undefined as unknown,
  error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { error: captured.error } }));
vi.mock("../app/dnd/useSectionThreadDnd.js", () => ({
  useSectionThreadDnd: (args: unknown) => {
    captured.dnd = args;
    return null;
  },
}));
vi.mock("../app/list/ProjectRow.js", () => ({
  SectionThreadTreeItems: ({ items }: { items: unknown }) => {
    captured.items = items;
    return null;
  },
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
  makeSidebarThread({ id: "archived", isArchived: true }),
  makeSidebarThread({ id: "restored", parentThreadId: "archived" }),
  makeSidebarThread({ id: "guest", parentThreadId: "elsewhere" }),
  makeSidebarThread({ id: "parent" }),
  makeSidebarThread({ id: "first", parentThreadId: "parent" }),
  makeSidebarThread({ id: "second", parentThreadId: "parent" }),
  makeSidebarThread({ id: "spawned", parentThreadId: "parent" }),
];

// Each conversation's parent in the bot's tree: "guest" and "restored" start
// their own branches; the parent of "done" is open, so it is not drawn with it.
const PARENTS: Record<string, string> = {
  first: "parent",
  second: "parent",
  spawned: "parent",
  done: "elsewhere",
};

function renderTree(answer: () => { ok: true } = () => ({ ok: true }), threads = THREADS) {
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
        threads: ["main", "archived", "guest", "parent", "first", "second", "restored", "done"].map(
          (threadId) => ({
            threadId,
            startedFromBot: true,
            completed: false,
          }),
        ),
      },
      threads,
      compareThreads: () => 0,
      parentOf: (threadId: string) => PARENTS[threadId] ?? null,
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
  const { accepts, drop, nest } = (captured.dnd as DndArgs).botReorder!;
  return { accepts, drop, nest, moves, inspection };
}

const source = (threadId: string, real = true) => ({
  threadId,
  parentThreadId: PARENTS[threadId] ?? null,
  real,
});

describe("a drop on the edge of a bot's conversation", () => {
  it("takes only conversations with a place in the bot's order", () => {
    const { accepts } = renderTree();
    expect(accepts(["second", "main"], "first")).toBe(true);
    expect(accepts(["second", "spawned"], "first")).toBe(false);
    expect(accepts(["second"], "spawned")).toBe(false);
    expect(accepts(["second"], "archived")).toBe(false);
    expect(accepts(["archived"], "main")).toBe(false);
  });

  it("stands where the bot's tree puts it, not under a parent the tree ends at", () => {
    renderTree();
    const roots = (captured.items as ProjectThreadItem[]).flatMap((item) =>
      item.kind === "thread" ? [item.node.thread.id] : [],
    );
    expect(roots).toEqual(["main", "archived", "restored", "guest", "parent"]);
  });

  it.each([
    [["second"], { threadId: "first", placement: "before" }, "parent"],
    [["second", "first"], { threadId: "main", placement: "after" }, null],
    [["main"], { threadId: "guest", placement: "after" }, null],
    [["guest", "restored"], { threadId: "main", placement: "after" }, null],
  ] as const)(
    "sends %o to %o as it was dropped, in one call",
    async (threadIds, target, parentThreadId) => {
      const { drop, moves, inspection } = renderTree();
      drop(threadIds, target);
      await waitFor(() =>
        expect(moves).toEqual([
          {
            botId: "bot_m",
            sources: threadIds.map((id) => source(id, !["guest", "restored"].includes(id))),
            target: { ...target, parentThreadId },
            levelShown: true,
          },
        ]),
      );
      expect(inspection.sdkCalls).toEqual([]);
      expect(captured.error).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["main", "done", "elsewhere"],
    ["done", "main", null],
  ])(
    "says that the level was not shown when %s goes to %s in Done",
    async (threadId, target, parentThreadId) => {
      const shown = ["main", "done"].map((id) =>
        makeSidebarThread({ id, parentThreadId: PARENTS[id] ?? null }),
      );
      const { drop, moves } = renderTree(undefined, shown);
      drop([threadId], { threadId: target, placement: "before" });
      await waitFor(() =>
        expect(moves).toEqual([
          {
            botId: "bot_m",
            sources: [source(threadId)],
            target: { threadId: target, placement: "before", parentThreadId },
            levelShown: false,
          },
        ]),
      );
    },
  );

  it.each(["drop", "nest"])("says why the move failed (%s)", async (gesture) => {
    const { drop, nest, inspection } = renderTree(() => {
      throw new Error("The parent is archived");
    });
    if (gesture === "drop") drop(["second"], { threadId: "main", placement: "after" });
    else await nest(["second"], "main");
    await waitFor(() => expect(captured.error).toHaveBeenCalledWith("The parent is archived"));
    expect(inspection.sdkCalls).toEqual([]);
  });
});

describe("a drop on the middle of a bot's conversation", () => {
  it("goes to the bot's server like the edge, also for a sub-thread without a place", async () => {
    const { nest, moves, inspection } = renderTree();
    await nest(["spawned", "guest"], "first");
    expect(moves).toEqual([
      {
        botId: "bot_m",
        sources: [source("spawned"), source("guest", false)],
        target: { threadId: "first", placement: "inside", parentThreadId: "parent" },
        levelShown: true,
      },
    ]);
    expect(inspection.sdkCalls).toEqual([]);
  });
});
