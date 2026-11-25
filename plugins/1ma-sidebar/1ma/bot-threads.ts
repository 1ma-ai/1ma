import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { branchOf, type BotBranch } from "./bots/branch.js";
import type { BotMember, BotSummary } from "./bots/contract.js";

type ThreadLink = Pick<PluginSidebarThread, "id" | "parentThreadId">;
type TreeRow = ThreadLink & Pick<PluginSidebarThread, "isArchived" | "isHidden">;

// Each conversation's place in its bot, null for a conversation of no bot. One
// that is not here has not been read yet.
export type Members = Readonly<Record<string, BotMember | null>>;

export function botBranches(
  members: Members,
  threads: readonly TreeRow[],
): ReadonlyMap<string, BotBranch> {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const isShown = (threadId: string) => {
    const row = byId.get(threadId);
    return row !== undefined && !row.isArchived && !row.isHidden;
  };
  const branches = new Map<string, BotBranch>();
  for (const thread of threads) {
    const chain: string[] = [];
    for (let id: string | null = thread.id; id !== null && !chain.includes(id);) {
      chain.push(id);
      id = byId.get(id)?.parentThreadId ?? null;
    }
    const branch = branchOf(chain, (id) => members[id]?.botId ?? null, isShown);
    if (branch !== null) branches.set(thread.id, branch);
  }
  return branches;
}

// Conversations shown under a visible bot leave the project groups together
// with their child conversations; a hidden bot's conversations stay there.
export function threadsShownUnderBots(
  bots: readonly Pick<BotSummary, "id" | "hidden">[],
  members: Members,
  threads: readonly TreeRow[],
): ReadonlySet<string> {
  const visible = new Set(bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
  return new Set(
    [...botBranches(members, threads)].flatMap(([threadId, { botId }]) =>
      visible.has(botId) ? [threadId] : [],
    ),
  );
}

export function withoutThreads<T extends ThreadLink>(
  threads: readonly T[],
  removed: ReadonlySet<string>,
): readonly T[] {
  return removed.size === 0 ? threads : threads.filter((thread) => !removed.has(thread.id));
}
