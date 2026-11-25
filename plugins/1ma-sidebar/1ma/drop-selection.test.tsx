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
import { getBotDropId, type BotDrop } from "./thread-drop.js";

installTestPluginRuntime();
const { useBotDrop } = await import("./BotDrops.js");
const { useSectionThreadDnd } = await import("../app/dnd/useSectionThreadDnd.js");

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
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
  interface Reported {
    dnd: SectionThreadDndState | null;
    selection: ThreadSelectionStore;
    botDrop: BotDrop;
  }
  const result: { current: Reported | null } = { current: null };
  const pinned = buildPinnedSidebarState({ groupEnvironmentThreads: true, threads: [] });
  function Harness({ report }: { report: (reported: Reported) => void }) {
    const selection = useThreadSelectionStore();
    const botDrop = useBotDrop();
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
    report({ dnd, selection, botDrop });
    return null;
  }
  renderSlot(
    { component: Harness },
    {
      report: (reported: Reported) => {
        result.current = reported;
      },
    },
    {},
  );
  return () => result.current!;
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

describe("a drag that starts in a project and is dropped on a bot", () => {
  it("moves exactly the conversations the preview counts", () => {
    const drops: (readonly string[])[] = [];
    const list = renderList();
    list().botDrop.register({
      accept: (threadIds) => threadIds,
      drop: (threadIds) => drops.push(threadIds),
    });
    select(list().selection, ["bot-conversation", "project-a"]);
    const props = () => list().dnd!.dndContextProps;
    act(() => props().onDragStart?.({ active: { id: "project-a" } } as DragStartEvent));
    const preview = list().dnd!.activeThread!.displayTitle;

    const over = { id: getBotDropId({ botId: "bot_b", place: "last" }) };
    act(() => props().onDragEnd?.({ active: { id: "project-a" }, over } as DragEndEvent));

    expect(drops).toHaveLength(1);
    const moved = drops[0]!;
    expect(preview).toBe(`${moved.length} threads`);
    expect(moved).toEqual(["project-a"]);
  });
});
