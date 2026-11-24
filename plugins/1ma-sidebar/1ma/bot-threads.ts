import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { SidebarBot } from "./bots-rpc.js";

type ThreadLink = Pick<PluginSidebarThread, "id" | "parentThreadId">;

export interface BotBranch {
  botId: string;
  // The conversation and the ones above it, up to the top of its bot's tree.
  threadIds: readonly string[];
}

// A sub-thread without its own place in a bot belongs to the bot of the nearest
// conversation above it; another bot's conversation ends the branch.
export function botBranches(
  bots: readonly SidebarBot[],
  threads: readonly ThreadLink[],
): ReadonlyMap<string, BotBranch> {
  const botOf = new Map(
    bots.flatMap((bot) => bot.threads.map((member) => [member.threadId, bot.id] as const)),
  );
  const parentOf = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  const branches = new Map<string, BotBranch>();
  for (const thread of threads) {
    const seen = new Set<string>();
    let branch: BotBranch | undefined;
    for (
      let id: string | null = thread.id;
      id !== null && !seen.has(id);
      id = parentOf.get(id) ?? null
    ) {
      seen.add(id);
      const botId = botOf.get(id);
      if (botId === undefined) continue;
      if (branch !== undefined && branch.botId !== botId) break;
      branch = { botId, threadIds: [...seen] };
    }
    if (branch !== undefined) branches.set(thread.id, branch);
  }
  return branches;
}

// Conversations shown under a visible bot leave the project groups together
// with their child conversations; a hidden bot's conversations stay there.
export function threadsShownUnderBots(
  bots: readonly SidebarBot[],
  threads: readonly ThreadLink[],
): ReadonlySet<string> {
  const visible = new Set(bots.filter((bot) => !bot.hidden).map((bot) => bot.id));
  return new Set(
    [...botBranches(bots, threads)].flatMap(([threadId, { botId }]) =>
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
