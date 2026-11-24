import {
  definePluginApp,
  experimental_THREAD_ACTION_GROUPS,
  experimental_THREAD_INFO_ROW_GROUPS,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { strings } from "./strings.js";
import { BotsPanel, PANEL_PATH } from "./src/ui/bot-pages.js";
import { assignToBotAction } from "./src/ui/assign-action.js";
import { botsRpc } from "./src/contract.js";
import { findBot, isDone, ThreadBotRow } from "./src/ui/thread-bot-row.js";

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
    useData() {
      const list = useRpcQuery({ contract: botsRpc, method: "bots.v1.list", input: {} });
      const reorder = useRpcMutation({ contract: botsRpc, method: "bots.v1.reorderThreads" });
      return { bots: list.data?.bots ?? [], reorder };
    },
    item({ thread, data }) {
      const member = findBot(data.bots, thread.id);
      if (!member || thread.archivedAt !== null) return null;
      const ids = member.bot.threads.map((item) => item.threadId);
      return {
        label: strings.threadBot.moveToTop,
        icon: "ArrowUp",
        disabled: ids[0] === thread.id,
        run: async () => {
          await data.reorder.mutate({
            botId: member.bot.id,
            threadIds: [thread.id, ...ids.filter((id) => id !== thread.id)],
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
    useData() {
      const list = useRpcQuery({ contract: botsRpc, method: "bots.v1.list", input: {} });
      const setCompleted = useRpcMutation({ contract: botsRpc, method: "bots.v1.setCompleted" });
      const { threads } = useSidebarThreads();
      return { bots: list.data?.bots ?? [], setCompleted, threads };
    },
    item({ thread, data }) {
      if (!findBot(data.bots, thread.id) || thread.archivedAt !== null) return null;
      const done = isDone(data.bots, data.threads, thread.id);
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
