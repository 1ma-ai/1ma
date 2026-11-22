import { useMemo } from "react";
import {
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarNavigation as useSidebarNavigation,
  useSettings,
  type PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import { BOTS_PLUGIN_ID, botsRpc, type SidebarBot } from "./bots-rpc.js";
import { threadsShownUnderBots, withoutThreads } from "./bot-threads.js";

export type SidebarBotsState =
  | { status: "off" | "loading" | "unavailable"; bots: readonly SidebarBot[] }
  | { status: "ready"; bots: readonly SidebarBot[] };

const NO_BOTS: readonly SidebarBot[] = [];

// The block and the project filter share this one decision, so conversations
// never leave the projects without a block that shows them.
export function useSidebarBots(): SidebarBotsState & { panelId: string | null } {
  const settings = useSettings();
  const navigation = useSidebarNavigation();
  const panelId =
    navigation.items.find(
      (item) => item.action.kind === "open-plugin-panel" && item.action.pluginId === BOTS_PLUGIN_ID,
    )?.id ?? null;
  const enabled = settings.values?.showBots !== false && panelId !== null;
  const query = useRpcQuery({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v1.list",
    input: {},
    enabled,
  });
  if (!enabled) return { status: "off", bots: NO_BOTS, panelId };
  if (query.error) return { status: "unavailable", bots: NO_BOTS, panelId };
  if (!query.data) return { status: "loading", bots: NO_BOTS, panelId };
  return { status: "ready", bots: query.data.bots, panelId };
}

// The project groups leave out what the bots block shows. Without bot data
// (no 1ma-bots, an error, still loading) they show every conversation.
export function useWithoutBotThreads(state: PluginSidebarThreadsState): PluginSidebarThreadsState {
  const { bots } = useSidebarBots();
  return useMemo(() => {
    const removed = threadsShownUnderBots(bots, state.threads);
    return removed.size === 0
      ? state
      : { ...state, threads: withoutThreads(state.threads, removed) };
  }, [bots, state]);
}
