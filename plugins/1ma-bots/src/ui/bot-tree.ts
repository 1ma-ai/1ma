import { useMemo } from "react";
import {
  experimental_useRpcKeyedQuery as useRpcKeyedQuery,
  experimental_useSidebarThreads as useSidebarThreads,
} from "@get-bb/plugin-sdk/app";
import { botsRpc } from "../contract.js";
import type { Members, TreeRows } from "./seen.js";

// The bots of these conversations, once they are read.
export function useMembers(threadIds: readonly string[]): Members {
  const { data } = useRpcKeyedQuery({
    contract: botsRpc,
    method: "bots.v2.forThreads",
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
