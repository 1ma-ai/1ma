import { useMemo } from "react";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useRpcQuery as useRpcQuery,
  experimental_useSidebarNavigation as useSidebarNavigation,
  useSettings,
  type PluginSidebarThread,
  type PluginSidebarThreadsState,
} from "@get-bb/plugin-sdk/app";
import { botsRpc, type BotSummary } from "./bots/contract.js";
import { threadsShownUnderBots, withoutThreads, type Members } from "./bot-threads.js";

export const BOTS_PLUGIN_ID = "1ma-bots";

export interface SidebarBotsState {
  status: "off" | "loading" | "unavailable" | "ready";
  bots: readonly BotSummary[];
  members: Members;
}

const NO_BOTS: readonly BotSummary[] = [];
const NO_MEMBERS: Members = {};

// The block and the project filter share this one decision, so conversations
// never leave the projects without a block that shows them.
export function useSidebarBots(
  threads: readonly PluginSidebarThread[],
): SidebarBotsState & { panelId: string | null } {
  const settings = useSettings();
  const navigation = useSidebarNavigation();
  const panelId =
    navigation.items.find(
      (item) => item.action.kind === "open-plugin-panel" && item.action.pluginId === BOTS_PLUGIN_ID,
    )?.id ?? null;
  const enabled = settings.values?.showBots !== false && panelId !== null;
  const list = useRpcQuery({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v2.list",
    input: {},
    enabled,
  });
  const members = useRpcKeyedQuery({
    contract: botsRpc,
    pluginId: BOTS_PLUGIN_ID,
    method: "bots.v2.forThreads",
    // A parent that is not in the list still says whose its sub-threads are.
    keys: threads.flatMap(({ id, parentThreadId }) =>
      parentThreadId === null ? [id] : [id, parentThreadId],
    ),
    enabled,
  });
  const nothing = { bots: NO_BOTS, members: NO_MEMBERS, panelId };
  if (!enabled) return { status: "off", ...nothing };
  if (list.error ?? members.error) return { status: "unavailable", ...nothing };
  // Only the first reading is a wait; a new conversation does not hide the rest.
  const read = members.data ?? NO_MEMBERS;
  const first = members.isLoading && Object.keys(read).length === 0;
  if (!list.data || first) return { status: "loading", ...nothing };
  return { status: "ready", bots: list.data.bots, members: read, panelId };
}

// The project groups leave out what the bots block shows. Without bot data
// (no 1ma-bots, an error, still loading) they show every conversation. After
// that a new conversation waits for its bot to be read, so it does not show in
// its project first and then jump to the bot.
export function useWithoutBotThreads(state: PluginSidebarThreadsState): PluginSidebarThreadsState {
  const { status, bots, members } = useSidebarBots(state.threads);
  return useMemo(() => {
    if (status !== "ready") return state;
    const shown = threadsShownUnderBots(bots, members, state.threads);
    const isRead = (id: string | null) => id === null || id in members;
    const unread = state.threads.filter(
      ({ id, parentThreadId }) => !isRead(id) || !isRead(parentThreadId),
    );
    const removed = new Set([...shown, ...unread.map(({ id }) => id)]);
    return removed.size === 0
      ? state
      : { ...state, threads: withoutThreads(state.threads, removed) };
  }, [status, bots, members, state]);
}
