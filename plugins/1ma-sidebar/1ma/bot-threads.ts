import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import type { SidebarBot } from "./bots-rpc.js";

type ThreadLink = Pick<PluginSidebarThread, "id" | "parentThreadId">;

// Conversations shown under a visible bot leave the project groups together
// with their child conversations; a hidden bot's conversations stay there.
export function threadsShownUnderBots(
  bots: readonly SidebarBot[],
  threads: readonly ThreadLink[],
): ReadonlySet<string> {
  const roots = new Set(
    bots
      .filter((bot) => !bot.hidden)
      .flatMap((bot) => bot.threads.map((thread) => thread.threadId)),
  );
  if (roots.size === 0) return roots;
  const parentOf = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  const shown = new Set<string>();
  for (const thread of threads) {
    const seen = new Set<string>();
    for (
      let id: string | null = thread.id;
      id !== null && !seen.has(id);
      id = parentOf.get(id) ?? null
    ) {
      seen.add(id);
      if (roots.has(id)) {
        shown.add(thread.id);
        break;
      }
    }
  }
  return shown;
}

export function withoutThreads<T extends ThreadLink>(
  threads: readonly T[],
  removed: ReadonlySet<string>,
): readonly T[] {
  return removed.size === 0 ? threads : threads.filter((thread) => !removed.has(thread.id));
}
