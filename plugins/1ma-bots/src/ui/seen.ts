import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { branchOf, keepsOpen } from "../branch.js";
import type { Assignment, BotMember, MoveToTopInput, SeenThread } from "../contract.js";

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

export function assignmentOf(members: Members, threadId: string): Assignment | null {
  const member = members.get(threadId);
  return member ? { botId: member.botId, assignment: member.assignment } : null;
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

// What this window shows of a conversation in its bot's tree; null when it knows
// no row or no bot of it. Done covers the branch, so a sub-thread is done with
// the conversations above it.
export function seenThread(members: Members, rows: TreeRows, threadId: string): SeenThread | null {
  const row = rows.get(threadId);
  const branch = branchIn(members, rows, threadId).map((id) => {
    const place = members.get(id);
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
  members: Members,
  rows: TreeRows,
  threadId: string,
): MoveToTopInput | null {
  const botId = members.get(threadId)?.botId;
  const parentOf = (id: string) => branchIn(members, rows, id)[1] ?? null;
  const keptOpen = new Set(
    [...rows.values()]
      .filter((row) => !row.isArchived && !row.isHidden && keepsOpen(row))
      .flatMap((row) => branchIn(members, rows, row.id)),
  );
  const seenRow = (id: string) => {
    const seen = seenThread(members, rows, id);
    return (
      seen && {
        ...seen,
        shownDone: seen.branch.some((mark) => mark.completed && !keptOpen.has(mark.threadId)),
      }
    );
  };
  const source = seenRow(threadId);
  if (botId === undefined || source === null) return null;
  const parentThreadId = parentOf(threadId);
  const first = [...members]
    .filter(([id, member]) => member.botId === botId && isShown(rows, id))
    .filter(([id]) => parentOf(id) === parentThreadId)
    .sort(([, a], [, b]) => a.position - b.position)
    .flatMap(([id]) => seenRow(id) ?? [])
    .find((row) => row.shownDone === source.shownDone);
  if (first === undefined || first.threadId === threadId) return null;
  return { botId, thread: source };
}
