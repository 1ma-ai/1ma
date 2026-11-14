import { definePluginApp, experimental_THREAD_INFO_ROW_GROUPS } from "@get-bb/plugin-sdk/app";
import { strings } from "./strings.js";
import { BotsPanel, PANEL_PATH } from "./src/ui/bot-pages.js";
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
});
