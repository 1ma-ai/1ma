import { useMemo, type ComponentProps } from "react";
import { DndContext } from "@dnd-kit/core";
import { experimental_useRpcMutation as useRpcMutation } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { useSectionThreadDnd } from "../app/dnd/useSectionThreadDnd.js";
import { SectionThreadTreeItems, SectionThreadDragOverlayPortal } from "../app/list/ProjectRow.js";
import {
  buildProjectThreadGroups,
  type ThreadComparator,
} from "../app/model/project-thread-groups.js";
import type { SidebarThread } from "../app/model/sidebar-thread.js";
import { getMutationErrorMessage } from "../app/ui/mutation-errors.js";
import { BOTS_PLUGIN_ID, botsRpc, type SidebarBot } from "./bots-rpc.js";
import { strings } from "./strings.js";

const empty = [] as const;
const noReorder = () => {};

export function BotThreadTree({
  bot,
  threads,
  compareThreads,
  ...tree
}: Omit<
  ComponentProps<typeof SectionThreadTreeItems>,
  "sectionDnd" | "items" | "sortableParentKey"
> & {
  bot: SidebarBot;
  threads: SidebarThread[];
  compareThreads: ThreadComparator;
}) {
  const rootItems = useMemo(
    () => buildProjectThreadGroups(threads, compareThreads, false),
    [threads, compareThreads],
  );
  const reorder = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.reorderThreads",
  });
  const dnd = useSectionThreadDnd({
    containerId: bot.id,
    enabled: true,
    groups: true,
    rootItems,
    topLevelSectionOrder: empty,
    onTopLevelSectionOrderChange: noReorder,
    pinnedThreads: empty,
    pinnedReorderPending: false,
    onReorderPinnedThread: noReorder,
    onExpandThread(id) {
      if (tree.collapsedThreadIds.has(id)) tree.onToggleThreadCollapsed(id);
    },
    onBotReorder(ids, target) {
      const order = bot.threads.map((member) => member.threadId);
      const moved = order.filter((id) => ids.includes(id));
      const rest = order.filter((id) => !ids.includes(id));
      const index = rest.indexOf(target.threadId);
      if (moved.length !== ids.length || index < 0) return;
      rest.splice(index + Number(target.placement === "after"), 0, ...moved);
      void reorder
        .mutate({ botId: bot.id, threadIds: rest })
        .catch((error: unknown) =>
          toast.error(getMutationErrorMessage({ error, fallbackMessage: strings.reorderFailed })),
        );
    },
  });
  return (
    <DndContext {...dnd?.dndContextProps}>
      <SectionThreadTreeItems
        {...tree}
        sectionDnd={dnd}
        items={rootItems}
        sortableParentKey={bot.id}
      />
      <SectionThreadDragOverlayPortal activeThread={dnd?.activeThread ?? null} />
    </DndContext>
  );
}
