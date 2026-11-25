import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { branchOf, keepsOpen } from "../branch.js";
import type { Assignment, BotMember, MoveThreadsInput, SeenThread } from "../contract.js";

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
  const branch = branchIn(members, rows, threadId);
  const member = branch.map((id) => members.get(id)).find((found) => found !== undefined);
  if (row === undefined || member === undefined) return null;
  return {
    threadId,
    assignment: member.assignment,
    parentThreadId: row.parentThreadId,
    branch: branch.map((id) => ({
      threadId: id,
      completed: members.get(id)?.completed ?? false,
    })),
  };
}

// The move that puts the conversation first under its own parent; null when
// that changes nothing in its group (open or done) of the bot's tree.
export function topMove(
  members: Members,
  rows: TreeRows,
  threadId: string,
): MoveThreadsInput | null {
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
  const siblings = [...members]
    .filter(([id, member]) => member.botId === botId && isShown(rows, id))
    .filter(([id]) => parentOf(id) === parentThreadId)
    .sort(([, a], [, b]) => a.position - b.position)
    .flatMap(([id]) => seenRow(id) ?? []);
  const [first] = siblings;
  if (
    first === undefined ||
    siblings.find((row) => row.shownDone === source.shownDone)?.threadId === threadId
  )
    return null;
  return {
    botId,
    sources: [source],
    target: { ...first, placement: "before" },
    levelShown: null,
  };
}
