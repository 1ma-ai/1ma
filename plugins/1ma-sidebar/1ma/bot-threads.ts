import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { SidebarBot } from "./bots-rpc.js";

type ThreadLink = Pick<PluginSidebarThread, "id" | "parentThreadId">;
type TreeRow = ThreadLink & Pick<PluginSidebarThread, "isArchived" | "isHidden">;

export interface BotBranch {
  botId: string;
  // The conversation and the ones it is drawn under, up to the top of its bot's tree.
  threadIds: readonly string[];
}

// The rule 1ma-bots uses (its src/branch.ts): a sub-thread without its own place
// in a bot belongs to the bot of the nearest conversation above it. Another bot's
// conversation ends the branch, and so does one the bot's tree does not show
// (archived, deleted, hidden).
export function botBranches(
  bots: readonly SidebarBot[],
  threads: readonly TreeRow[],
): ReadonlyMap<string, BotBranch> {
  const botOf = new Map(
    bots.flatMap((bot) => bot.threads.map((member) => [member.threadId, bot.id] as const)),
  );
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const branches = new Map<string, BotBranch>();
  for (const thread of threads) {
    const drawn = new Set<string>();
    let branch: BotBranch | undefined;
    for (let id: string | null = thread.id; id !== null && !drawn.has(id);) {
      const botId = botOf.get(id);
      if (branch !== undefined && botId !== undefined && botId !== branch.botId) break;
      const row = byId.get(id);
      const ends = id !== thread.id && (row === undefined || row.isArchived || row.isHidden);
      if (!ends) drawn.add(id);
      if (botId !== undefined) branch = { botId, threadIds: [...drawn] };
      if (ends) break;
      id = row?.parentThreadId ?? null;
    }
    if (branch !== undefined) branches.set(thread.id, branch);
  }
  return branches;
}

// Conversations shown under a visible bot leave the project groups together
// with their child conversations; a hidden bot's conversations stay there.
export function threadsShownUnderBots(
  bots: readonly SidebarBot[],
  threads: readonly TreeRow[],
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
