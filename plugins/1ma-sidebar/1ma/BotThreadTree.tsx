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
  parentOf,
  ...tree
}: Omit<
  ComponentProps<typeof SectionThreadTreeItems>,
  "sectionDnd" | "items" | "sortableParentKey"
> & {
  bot: SidebarBot;
  threads: SidebarThread[];
  compareThreads: ThreadComparator;
  // The conversation above this one in the bot's tree; it is drawn there when
  // these threads have it.
  parentOf: (threadId: string) => string | null;
}) {
  const rootItems = useMemo(
    () => buildProjectThreadGroups(threads, compareThreads, false, ({ id }) => parentOf(id)),
    [threads, compareThreads, parentOf],
  );
  const move = useRpcMutation({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.moveThreads",
  });
  const order = bot.threads.map((member) => member.threadId);
  const drawn = new Map(threads.map((thread) => [thread.id, thread]));
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
    botReorder: {
      // Only the bot's own conversations have a place in its order, and an
      // archived one keeps the place it has.
      accepts: (ids, targetId) =>
        [...ids, targetId].every((id) => order.includes(id) && !drawn.get(id)?.isArchived),
      async drop(ids, target) {
        try {
          await move.mutate({
            botId: bot.id,
            threadIds: [...ids],
            target: {
              threadId: target.threadId,
              placement: target.placement,
              parentThreadId: parentOf(target.threadId),
            },
            levelShown: [...ids, target.threadId]
              .map(parentOf)
              .every((parent) => parent === null || drawn.has(parent)),
          });
        } catch (error) {
          toast.error(getMutationErrorMessage({ error, fallbackMessage: strings.reorderFailed }));
        }
      },
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
