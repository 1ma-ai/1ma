import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS,
  experimental_useRpcMutation as useRpcMutation,
} from "@get-bb/plugin-sdk/app";
import { strings } from "./strings.js";
import { BotsPanel, PANEL_PATH } from "./src/ui/bot-pages.js";
import { assignToBotAction } from "./src/ui/assign-action.js";
import { botsRpc } from "./src/contract.js";
import { isDone, topMove, useBotTree } from "./src/ui/bot-tree.js";
import { ThreadBotRow } from "./src/ui/thread-bot-row.js";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "bots",
    title: strings.panelTitle,
    icon: "Bot",
    path: PANEL_PATH,
    component: BotsPanel,
  });
  app.slots.experimental_threadInfoRow({
    id: "thread-bot",
    group: experimental_THREAD_INFO_ROW_GROUPS.thread,
    component: ThreadBotRow,
  });
  app.slots.experimental_threadAction(assignToBotAction);
  app.slots.experimental_threadAction({
    id: "move-to-top",
    title: strings.threadBot.moveToTop,
    icon: "ArrowUp",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 61,
    useData({ threadIds }) {
      const move = useRpcMutation({ contract: botsRpc, method: "bots.v1.moveThreads" });
      return { ...useBotTree(threadIds), move };
    },
    item({ thread, data }) {
      const member = data.members.get(thread.id);
      if (!member || thread.archivedAt !== null) return null;
      const top = topMove(data.members, data.rows, thread.id);
      if (top === null) return null;
      return {
        label: strings.threadBot.moveToTop,
        icon: "ArrowUp",
        run: async () => {
          await data.move.mutate({
            botId: member.botId,
            ...top,
            levelShown: false,
          });
        },
      };
    },
  });
  app.slots.experimental_threadAction({
    id: "toggle-done",
    title: strings.threadBot.markDone,
    icon: "Check",
    group: experimental_THREAD_ACTION_GROUPS.organize,
    order: 62,
    useData({ threadIds }) {
      const setCompleted = useRpcMutation({ contract: botsRpc, method: "bots.v1.setCompleted" });
      return { ...useBotTree(threadIds), setCompleted };
    },
    item({ thread, data }) {
      if (!data.members.has(thread.id) || thread.archivedAt !== null) return null;
      const done = isDone(data.members, data.rows, thread.id);
      return {
        label: done ? strings.threadBot.markNotDone : strings.threadBot.markDone,
        icon: "Check",
        run: async () => {
          await data.setCompleted.mutate({ threadId: thread.id, completed: !done });
        },
      };
    },
  });
});
