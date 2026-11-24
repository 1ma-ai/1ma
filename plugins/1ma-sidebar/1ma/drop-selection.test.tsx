// @vitest-environment jsdom
// Codex review of f6aa64f: a drop on a bot moves exactly the conversations the
// drag preview counts, through the list's real drag start.
import { act, cleanup } from "@testing-library/react";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTestPluginRuntime, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeSidebarThread } from "../app/model/fixtures.js";
import {
  buildSectionThreadList,
  CHRONOLOGICAL_CONTAINER_ID,
} from "../app/model/project-thread-groups.js";
import { buildPinnedSidebarState } from "../app/model/pinned-sidebar-threads.js";
import {
  useThreadSelectionStore,
  type ThreadSelectionStore,
} from "../app/selection/threadSelection.js";
import type { SectionThreadDndState } from "../app/dnd/useSectionThreadDnd.js";
import { botDrop } from "./thread-drop.js";

installTestPluginRuntime();
const { useSectionThreadDnd } = await import("../app/dnd/useSectionThreadDnd.js");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  botDrop.cancel();
});

// The project list holds only its own conversations; a conversation shown
// under a bot is not in it, though the shared selection can hold it.
const ROOT_ITEMS = buildSectionThreadList(
  [
    makeSidebarThread({ id: "project-a", projectId: "p", createdAt: 2 }),
    makeSidebarThread({ id: "project-b", projectId: "p", createdAt: 1 }),
  ],
  undefined,
  [],
);

function renderList() {
  const result: { dnd: SectionThreadDndState | null; selection: ThreadSelectionStore | null } = {
    dnd: null,
    selection: null,
  };
  const pinned = buildPinnedSidebarState({ groupEnvironmentThreads: true, threads: [] });
  function Harness({
    report,
  }: {
    report: (dnd: SectionThreadDndState | null, selection: ThreadSelectionStore) => void;
  }) {
    const selection = useThreadSelectionStore();
    const dnd = useSectionThreadDnd({
      containerId: CHRONOLOGICAL_CONTAINER_ID,
      enabled: true,
      rootItems: ROOT_ITEMS,
      topLevelSectionOrder: ["pinned", "threads"],
      onTopLevelSectionOrderChange: vi.fn(),
      pinnedReorderPending: false,
      pinnedThreads: [],
      pinnedRootItems: pinned.rootItems,
      pinnedRootNodes: pinned.rootNodes,
      onReorderPinnedThread: vi.fn(),
    });
    report(dnd, selection);
    return null;
  }
  renderSlot(
    { component: Harness },
    {
      report: (dnd: SectionThreadDndState | null, selection: ThreadSelectionStore) => {
        result.dnd = dnd;
        result.selection = selection;
      },
    },
    {},
  );
  return result;
}

// Rows in the order the sidebar draws them, so a meta-click selects by id.
function select(store: ThreadSelectionStore, ids: readonly string[]) {
  const links = ids.map((id) => {
    const link = document.createElement("a");
    link.dataset.sidebarThreadId = id;
    document.body.append(link);
    return link;
  });
  for (const link of links) {
    store.handleClick(
      link.dataset.sidebarThreadId!,
      { shiftKey: true, metaKey: true, ctrlKey: false },
      link,
    );
  }
}

function botRow(botId: string) {
  const row = document.createElement("div");
  row.setAttribute("data-1ma-bot-drop", botId);
  const target = document.createElement("button");
  row.append(target);
  document.body.append(row);
  return target;
}

describe("a drag that starts in a project and is dropped on a bot", () => {
  it("moves exactly the conversations the preview counts", () => {
    const drops: (readonly string[])[] = [];
    const unregister = botDrop.register({
      accept: (threadIds) => threadIds,
      drop: (threadIds) => drops.push(threadIds),
    });
    const list = renderList();
    select(list.selection!, ["bot-conversation", "project-a"]);
    const props = () => list.dnd!.dndContextProps;
    act(() => props().onDragStart?.({ active: { id: "project-a" } } as DragStartEvent));
    const preview = list.dnd!.activeThread!.displayTitle;

    const target = botRow("bot_b");
    document.elementsFromPoint = () => [target];
    const collisions = props().collisionDetection!({
      pointerCoordinates: { x: 100, y: 10 },
    } as Parameters<NonNullable<ReturnType<typeof props>["collisionDetection"]>>[0]);
    expect(collisions).toEqual([]);
    act(() => props().onDragEnd?.({ active: { id: "project-a" }, over: null } as DragEndEvent));
    unregister();

    expect(drops).toHaveLength(1);
    const moved = drops[0]!;
    expect(preview).toBe(`${moved.length} threads`);
    expect(moved).toEqual(["project-a"]);
  });
});
