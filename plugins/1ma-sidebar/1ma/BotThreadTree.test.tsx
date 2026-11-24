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

function renderTree(update: () => Promise<unknown> = async () => undefined) {
  const orders: unknown[] = [];
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
      sdk: { threads: { update: update as never } },
      rpc: {
        "bots.v1.reorderThreads": (input: unknown) => {
          orders.push((input as { threadIds: string[] }).threadIds);
          return { ok: true };
        },
      },
    },
  );
  const { accepts, drop } = (captured.dnd as DndArgs).botReorder!;
  return { accepts, drop, orders, inspection };
}

describe("a drop on the edge of a bot's conversation", () => {
  it("takes only conversations with a place in the bot's order", () => {
    const { accepts } = renderTree();
    expect(accepts(["second", "main"], "first")).toBe(true);
    expect(accepts(["second", "spawned"], "first")).toBe(false);
    expect(accepts(["second"], "spawned")).toBe(false);
  });

  it.each([
    ["before", ["main", "archived", "guest", "parent", "second", "first"]],
    ["after", ["main", "archived", "guest", "parent", "first", "second"]],
  ] as const)("%s a neighbour changes only the order", async (placement, order) => {
    const { drop, orders, inspection } = renderTree();
    drop(["second"], { threadId: "first", placement });
    await waitFor(() => expect(orders).toEqual([order]));
    expect(inspection.sdkCalls).toEqual([]);
  });

  it("next to a top-level conversation takes a sub-chat out of its parent", async () => {
    const { drop, orders, inspection } = renderTree();
    drop(["second", "first"], { threadId: "main", placement: "after" });
    await waitFor(() =>
      expect(orders).toEqual([["main", "first", "second", "archived", "guest", "parent"]]),
    );
    expect(inspection.sdkCalls).toEqual(
      ["first", "second"].map((threadId) => ({
        method: "threads.update",
        args: [{ threadId, parentThreadId: null }],
      })),
    );
  });

  it("next to a sub-chat moves a conversation under the same parent", async () => {
    const { drop, orders, inspection } = renderTree();
    drop(["main", "first"], { threadId: "second", placement: "before" });
    await waitFor(() =>
      expect(orders).toEqual([["archived", "guest", "parent", "main", "first", "second"]]),
    );
    expect(inspection.sdkCalls).toEqual([
      { method: "threads.update", args: [{ threadId: "main", parentThreadId: "parent" }] },
    ]);
  });

  it("never touches a parent outside this bot's tree", async () => {
    const { drop, orders, inspection } = renderTree();
    drop(["main"], { threadId: "guest", placement: "after" });
    await waitFor(() => expect(orders).toHaveLength(1));
    drop(["guest"], { threadId: "parent", placement: "after" });
    await waitFor(() => expect(orders).toHaveLength(2));
    expect(inspection.sdkCalls).toEqual([]);
  });

  it("says when the move failed and leaves the order alone", async () => {
    const { drop, orders } = renderTree(async () => {
      throw new Error("The parent is archived");
    });
    drop(["second"], { threadId: "main", placement: "after" });
    await waitFor(() => expect(captured.error).toHaveBeenCalledWith("The parent is archived"));
    expect(orders).toEqual([]);
  });
});
