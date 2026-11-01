import { strings } from "./strings";

// Cards rendered per lane before "Show more": a server keeps hundreds of idle
// threads, and all of them would otherwise render at once.
export const LANE_PAGE = 50;

export type TasksView =
  | { kind: "error" }
  | { kind: "loading" }
  | { kind: "ready"; doneIds: ReadonlySet<string>; focusBoardMissing: boolean };

// Threads come from bb itself; only "done" comes from the Focus Board plugin.
// When Focus Board is off or answers something else, the lanes still show,
// with nothing marked done, and a notice says why.
export function tasksView(args: {
  threadsStatus: string;
  done: { isLoading: boolean; error: unknown; doneIds: readonly string[] | undefined };
}): TasksView {
  if (args.threadsStatus === "error") return { kind: "error" };
  if (args.threadsStatus !== "ready" || args.done.isLoading) return { kind: "loading" };
  const missing = Boolean(args.done.error) || args.done.doneIds === undefined;
  return {
    kind: "ready",
    doneIds: new Set(missing ? [] : args.done.doneIds),
    focusBoardMissing: missing,
  };
}

export function page<T>(items: readonly T[], shown: number): { items: T[]; hidden: number } {
  return { items: items.slice(0, shown), hidden: Math.max(0, items.length - shown) };
}

export function isoTime(milliseconds: number): string | undefined {
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function relativeTime(updatedAt: number, now: number): string {
  if (!Number.isFinite(updatedAt)) return "";
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return strings.justNow;
  if (minutes < 60) return strings.minutesAgo(minutes);
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? strings.hoursAgo(hours) : strings.daysAgo(Math.floor(hours / 24));
}
