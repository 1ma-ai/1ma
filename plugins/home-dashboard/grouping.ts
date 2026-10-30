export type Lane = "needs-you" | "running" | "done";

export interface DashboardThread {
  id: string;
  projectId: string | null;
  status: string;
  activity: {
    backgroundAgents: number;
    backgroundCommands: number;
    workflows: number;
    goals: number;
    planMode: number;
  };
  queuedWork: string;
  hasPendingInteraction: boolean;
  indicator: string;
  isUnread: boolean;
  isArchived: boolean;
  isHidden: boolean;
  updatedAt: number;
}

export function laneFor(thread: DashboardThread, doneIds: ReadonlySet<string>): Lane {
  if (
    thread.hasPendingInteraction ||
    thread.status === "error" ||
    thread.queuedWork === "failed" ||
    thread.indicator === "unread-error" ||
    thread.indicator === "queued-failed"
  )
    return "needs-you";
  if (["active", "starting", "stopping", "pending"].includes(thread.status)) return "running";
  if (
    thread.activity.backgroundAgents > 0 ||
    thread.activity.backgroundCommands > 0 ||
    thread.activity.workflows > 0 ||
    thread.activity.goals > 0 ||
    thread.activity.planMode > 0
  )
    return "running";
  if (doneIds.has(thread.id)) return "done";
  return "needs-you";
}

export function groupThreads<T extends DashboardThread>(
  threads: readonly T[],
  projectId: string | null,
  doneIds: ReadonlySet<string>,
): Record<Lane, T[]> {
  const lanes: Record<Lane, T[]> = { "needs-you": [], running: [], done: [] };
  for (const thread of threads) {
    if (
      thread.isArchived ||
      thread.isHidden ||
      (projectId !== null && thread.projectId !== projectId)
    )
      continue;
    lanes[laneFor(thread, doneIds)].push(thread);
  }
  for (const lane of Object.values(lanes)) {
    lane.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return lanes;
}
