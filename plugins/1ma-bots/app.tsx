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
import { findBot, seenThread, topMove } from "./src/ui/seen.js";
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
    useData() {
      const list = useRpcQuery({ contract: botsRpc, method: "bots.v1.list", input: {} });
      const move = useRpcMutation({ contract: botsRpc, method: "bots.v2.moveToTop" });
      const { threads } = useSidebarThreads();
      return { bots: list.data?.bots ?? [], move, threads };
    },
    item({ thread, data }) {
      const member = findBot(data.bots, thread.id);
      if (!member || thread.archivedAt !== null) return null;
      const top = topMove(member.bot, data.bots, data.threads, thread.id);
      if (top === null) return null;
      return {
        label: strings.threadBot.moveToTop,
        icon: "ArrowUp",
        run: async () => {
          await data.move.mutate(top);
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
      const setCompleted = useRpcMutation({ contract: botsRpc, method: "bots.v2.setCompleted" });
      const { threads } = useSidebarThreads();
      return { bots: list.data?.bots ?? [], setCompleted, threads };
    },
    item({ thread, data }) {
      const member = findBot(data.bots, thread.id);
      const seen = seenThread(data.bots, data.threads, thread.id);
      if (!member || seen === null || thread.archivedAt !== null) return null;
      const done = seen.branch.some((mark) => mark.completed);
      return {
        label: done ? strings.threadBot.markNotDone : strings.threadBot.markDone,
        icon: "Check",
        run: async () => {
          await data.setCompleted.mutate({
            botId: member.bot.id,
            thread: seen,
            completed: !done,
          });
        },
      };
    },
  });
});
