import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { branchOf, keepsOpen } from "../branch.js";
import type { Assignment, BotSummary, BotThread, MoveToTopInput, SeenThread } from "../contract.js";

export function findBot(
  bots: readonly BotSummary[],
  threadId: string,
): { bot: BotSummary; thread: BotThread } | null {
  for (const bot of bots) {
    const thread = bot.threads.find((item) => item.threadId === threadId);
    if (thread) return { bot, thread };
  }
  return null;
}

export function assignmentOf(bots: readonly BotSummary[], threadId: string): Assignment | null {
  const member = findBot(bots, threadId);
  return member && { botId: member.bot.id, assignment: member.thread.assignment };
}

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

function isShown(threads: readonly TreeRow[], threadId: string): boolean {
  const row = threads.find((thread) => thread.id === threadId);
  return row !== undefined && !row.isArchived && !row.isHidden;
}

// The conversation and the ones it is drawn under in its bot's tree.
function branchIn(bots: readonly BotSummary[], threads: readonly TreeRow[], threadId: string) {
  const chain: string[] = [];
  for (let id: string | null = threadId; id !== null && !chain.includes(id);) {
    chain.push(id);
    id = threads.find((thread) => thread.id === id)?.parentThreadId ?? null;
  }
  const branch = branchOf(
    chain,
    (id) => findBot(bots, id)?.bot.id ?? null,
    (id) => isShown(threads, id),
  );
  return branch?.threadIds ?? [];
}

// What this window shows of a conversation in its bot's tree; null when it knows
// no row or no bot of it. Done covers the branch, so a sub-thread is done with
// the conversations above it.
export function seenThread(
  bots: readonly BotSummary[],
  threads: readonly TreeRow[],
  threadId: string,
): SeenThread | null {
  const row = threads.find((thread) => thread.id === threadId);
  const branch = branchIn(bots, threads, threadId).map((id) => {
    const place = findBot(bots, id)?.thread;
    return {
      threadId: id,
      assignment: place?.assignment ?? null,
      completed: place?.completed ?? false,
    };
  });
  if (row === undefined || branch.length === 0) return null;
  return { threadId, parentThreadId: row.parentThreadId, branch };
}

// Moves the conversation first under its own parent; null when that changes
// nothing in its group (open or done) of the bot's tree.
export function topMove(
  bot: BotSummary,
  bots: readonly BotSummary[],
  threads: readonly TreeRow[],
  threadId: string,
): MoveToTopInput | null {
  const parentOf = (id: string) => branchIn(bots, threads, id)[1] ?? null;
  const keptOpen = new Set(
    threads
      .filter((row) => !row.isArchived && !row.isHidden && keepsOpen(row))
      .flatMap((row) => branchIn(bots, threads, row.id)),
  );
  const seenRow = (id: string) => {
    const seen = seenThread(bots, threads, id);
    return (
      seen && {
        ...seen,
        shownDone: seen.branch.some((mark) => mark.completed && !keptOpen.has(mark.threadId)),
      }
    );
  };
  const source = seenRow(threadId);
  if (source === null) return null;
  const parentThreadId = parentOf(threadId);
  const first = bot.threads
    .filter((member) => isShown(threads, member.threadId))
    .filter((member) => parentOf(member.threadId) === parentThreadId)
    .flatMap((member) => seenRow(member.threadId) ?? [])
    .find((row) => row.shownDone === source.shownDone);
  if (first === undefined || first.threadId === threadId) return null;
  return { botId: bot.id, thread: source };
}
