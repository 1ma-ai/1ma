import {
  experimental_THREAD_ACTION_GROUPS,
  experimental_useRpcMutation as useRpcMutation,
  experimental_useRpcQuery as useRpcQuery,
  type PluginThreadActionRegistration,
} from "@get-bb/plugin-sdk/app";
import { strings } from "../../strings.js";
import { botsRpc, type Assignment, type BotSummary } from "../contract.js";
import { useMembers } from "./bot-tree.js";
import { assignmentOf, type Members } from "./seen.js";

const NO_BOT = "none";

interface AssignData {
  bots: readonly BotSummary[];
  members: Members;
  assign(threadId: string, botId: string | null, seen: Assignment | null): Promise<unknown>;
}

function useAssignData({ threadIds }: { threadIds: readonly string[] }): AssignData {
  const list = useRpcQuery({ contract: botsRpc, method: "bots.v2.list", input: {} });
  const assign = useRpcMutation({ contract: botsRpc, method: "bots.v2.assign" });
  return {
    bots: list.data?.bots ?? [],
    members: useMembers(threadIds),
    assign: (threadId, botId, seen) => assign.mutate({ threadId, botId, place: "last", seen }),
  };
}

// Works in any thread list's row menu, the stock one included.
export const assignToBotAction: PluginThreadActionRegistration<AssignData> = {
  id: "assign-to-bot",
  title: strings.threadBot.choose,
  icon: "Bot",
  group: experimental_THREAD_ACTION_GROUPS.organize,
  order: 60,
  useData: useAssignData,
  item: ({ thread, data }) => {
    if (data.bots.length === 0 || thread.parentThreadId !== null || thread.archivedAt !== null) {
      return null;
    }
    const seen = assignmentOf(data.members, thread.id);
    const current = seen?.botId ?? null;
    return {
      label: strings.threadBot.choose,
      icon: "Bot",
      choices: {
        items: [
          ...data.bots.map((bot) => ({
            id: bot.id,
            label: bot.name,
            selected: bot.id === current,
            disabled: bot.id === current,
          })),
          ...(current === null ? [] : [{ id: NO_BOT, label: strings.threadBot.none }]),
        ],
      },
      run: async ({ value }) => {
        if (value === undefined) return;
        await data.assign(thread.id, value === NO_BOT ? null : value, seen);
      },
    };
  },
};
