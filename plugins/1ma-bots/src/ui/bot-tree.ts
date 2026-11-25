import { useMemo } from "react";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { branchOf, keepsOpen } from "../branch.js";
import { botsRpc, type BotMember, type MoveThreadsInput } from "../contract.js";

export type Members = ReadonlyMap<string, BotMember>;
export type TreeRow = Pick<
  PluginSidebarThread,
  | "id"
  | "parentThreadId"
  | "isArchived"
  | "isHidden"
  | "status"
  | "hasPendingInteraction"
  | "queuedWork"
>;
export type TreeRows = ReadonlyMap<string, TreeRow>;

// The bots of these conversations, once they are read.
export function useMembers(threadIds: readonly string[]): Members {
  const { data } = useRpcKeyedQuery({
    contract: botsRpc,
    method: "bots.v1.forThreads",
    keys: threadIds,
  });
  return useMemo(
    () =>
      new Map(
        Object.entries(data ?? {}).flatMap(([threadId, member]) =>
          member ? [[threadId, member]] : [],
        ),
      ),
    [data],
  );
}

// The sidebar's conversations and the bots of them and of the others asked for.
export function useBotTree(threadIds: readonly string[]): { members: Members; rows: TreeRows } {
  const { threads } = useSidebarThreads();
  const rows = useMemo(() => new Map(threads.map((row) => [row.id, row])), [threads]);
  return { members: useMembers([...new Set([...threadIds, ...rows.keys()])]), rows };
}

function isShown(rows: TreeRows, threadId: string): boolean {
  const row = rows.get(threadId);
  return row !== undefined && !row.isArchived && !row.isHidden;
}

// The conversation and the ones it is drawn under in its bot's tree.
function branchIn(members: Members, rows: TreeRows, threadId: string): readonly string[] {
  const chain: string[] = [];
  for (let id: string | null = threadId; id !== null && !chain.includes(id);) {
    chain.push(id);
    id = rows.get(id)?.parentThreadId ?? null;
  }
  const branch = branchOf(
    chain,
    (id) => members.get(id)?.botId ?? null,
    (id) => isShown(rows, id),
  );
  return branch?.threadIds ?? [];
}

// Done covers the branch, so a sub-thread is done with the conversations above
// it in its bot's tree.
export function isDone(members: Members, rows: TreeRows, threadId: string): boolean {
  return branchIn(members, rows, threadId).some((id) => members.get(id)?.completed);
}

// The move that puts the conversation first under its own parent; null when
// that changes nothing in its group (open or done) of the bot's tree.
export function topMove(
  members: Members,
  rows: TreeRows,
  threadId: string,
): Pick<MoveThreadsInput, "sources" | "target"> | null {
  const botId = members.get(threadId)?.botId;
  const parentOf = (id: string) => branchIn(members, rows, id)[1] ?? null;
  const keptOpen = new Set(
    [...rows.values()].filter(keepsOpen).flatMap((row) => branchIn(members, rows, row.id)),
  );
  const shownDone = (id: string) =>
    branchIn(members, rows, id).some(
      (above) => !keptOpen.has(above) && members.get(above)?.completed,
    );
  const parentThreadId = parentOf(threadId);
  const siblings = [...rows.keys()]
    .flatMap((id) => {
      const member = members.get(id);
      return member?.botId === botId && isShown(rows, id) && parentOf(id) === parentThreadId
        ? [{ id, position: member!.position }]
        : [];
    })
    .sort((a, b) => a.position - b.position)
    .map(({ id }) => id);
  const [first] = siblings;
  const done = shownDone(threadId);
  if (first === undefined || siblings.find((id) => shownDone(id) === done) === threadId)
    return null;
  return {
    sources: [
      { threadId, parentThreadId, real: rows.get(threadId)?.parentThreadId === parentThreadId },
    ],
    target: { threadId: first, placement: "before", parentThreadId },
  };
}
