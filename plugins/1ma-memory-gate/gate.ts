import type { MemoryReading } from "./contract.js";
import { strings } from "./strings.js";

export const SAMPLE_MAX_AGE_MS = 15_000;
export const READING_RETRY_MS = 2_000;
export const READING_GRACE_MS = 30_000;
export const MEMORY_RETRY_MS = 15_000;
export const START_WINDOW_MS = 10_000;
export const ADMISSION_WINDOW_MS = 45_000;
export const MAX_REASON_LENGTH = 200;

export interface GateSettings {
  enabled: boolean;
  reserveBytes: number;
  pressurePercent: number;
  minRunning: number;
}

export interface Sample {
  reading: MemoryReading;
  takenAt: number;
  /** When the last reading with a free-memory figure was taken, if ever. */
  usableAt: number | null;
}

export interface GateHost {
  id: string;
  name: string;
}

export interface DispatchQuestion {
  attempt: string;
  threadId: string;
  threadStatus: string;
  host: GateHost | null;
}

export interface GateInput {
  question: DispatchQuestion;
  settings: GateSettings;
  sample: Sample | undefined;
  /** Ids of the threads the server lists as running on the question's host. */
  runningOnHost: readonly string[];
}

export type Verdict =
  | {
      action: "proceed";
      why:
        | "not-a-new-turn"
        | "disabled"
        | "unsupported"
        | "reading-unavailable"
        | "few-running"
        | "enough-memory";
    }
  | {
      action: "wait";
      why: "no-reading" | "short-of-memory" | "pressure";
      reason: string;
      retryInMs: number;
    };

/**
 * A verdict, with a note on the one that starts or ends a time when the
 * machine's turns go ahead unchecked.
 */
export type Answer = Verdict & { readings?: "lost" | "back" };

export function isNewTurnOnHost(
  question: DispatchQuestion,
): question is DispatchQuestion & { host: GateHost } {
  return (
    question.attempt === "start-turn" &&
    question.threadStatus !== "active" &&
    question.threadStatus !== "starting" &&
    question.host !== null
  );
}

export function hostLabel(host: GateHost): string {
  return host.name.trim() === "" ? host.id : host.name.trim();
}

function bounded(reason: string): string {
  return reason.length <= MAX_REASON_LENGTH ? reason : `${reason.slice(0, MAX_REASON_LENGTH - 1)}…`;
}

export function freeBytes(reading: MemoryReading): number | null {
  if (!reading.supported) return null;
  const room = [
    reading.cgroup === null ? null : reading.cgroup.limitBytes - reading.cgroup.workingSetBytes,
    reading.machineAvailableBytes,
  ].filter((value): value is number => value !== null);
  return room.length === 0 ? null : Math.min(...room);
}

/** Free memory from a reading young enough to decide from, else null. */
export function freshFreeBytes(sample: Sample | undefined, at: number): number | null {
  return sample === undefined || at - sample.takenAt > SAMPLE_MAX_AGE_MS
    ? null
    : freeBytes(sample.reading);
}

/** `now` is monotonic milliseconds. */
export function createGate(now: () => number) {
  // When this gate let each thread start. A thread's memory does not show in a
  // reading until it has loaded, so it holds a share meanwhile: while the
  // server lists it as running, or briefly before core commits its start.
  const admittedAt = new Map<string, { at: number; hostId: string }>();
  // Since when turns on a host have been asking without a reading to decide from.
  // `unchecked` once one of them was let through for that reason.
  const unread = new Map<string, { since: number; last: number; unchecked: boolean }>();

  function unreadSince(hostId: string, at: number): number {
    const asked = unread.get(hostId);
    return asked !== undefined && at - asked.last <= READING_GRACE_MS ? asked.since : at;
  }

  function forgetExpired(at: number): void {
    for (const [id, admitted] of admittedAt)
      if (at - admitted.at >= ADMISSION_WINDOW_MS) admittedAt.delete(id);
    for (const [hostId, asked] of unread)
      if (at - asked.last > READING_GRACE_MS) unread.delete(hostId);
  }

  /** The other chats on the question's host, and how many of them still hold a share. */
  function chatsOnHost(
    question: DispatchQuestion & { host: GateHost },
    running: readonly string[],
    at: number,
  ) {
    const listed = new Set(running.filter((id) => id !== question.threadId));
    const chats = new Set(listed);
    let shares = 0;
    for (const [id, admitted] of admittedAt) {
      if (id === question.threadId) continue;
      const age = at - admitted.at;
      if (listed.has(id)) {
        if (age < ADMISSION_WINDOW_MS) shares += 1;
      } else if (admitted.hostId === question.host.id && age < START_WINDOW_MS) {
        chats.add(id);
        shares += 1;
      }
    }
    return { count: chats.size, shares };
  }

  function decide(input: GateInput, at: number): Verdict {
    const { question, settings, sample } = input;
    if (!isNewTurnOnHost(question)) return { action: "proceed", why: "not-a-new-turn" };
    if (!settings.enabled) return { action: "proceed", why: "disabled" };
    if (sample?.reading.supported === false) return { action: "proceed", why: "unsupported" };
    const others = chatsOnHost(question, input.runningOnHost, at);
    if (others.count < settings.minRunning) return { action: "proceed", why: "few-running" };
    const host = hostLabel(question.host);
    const free = freshFreeBytes(sample, at);
    if (free === null) {
      // A reading that stays away must not hold chats forever: the thread-count
      // limit still guards a machine this gate cannot see.
      const usableAt = sample?.usableAt ?? null;
      const asking = at - unreadSince(question.host.id, at);
      const unreadable = usableAt === null ? asking : at - (usableAt + SAMPLE_MAX_AGE_MS);
      if (asking >= READING_GRACE_MS && unreadable >= READING_GRACE_MS)
        return { action: "proceed", why: "reading-unavailable" };
      return {
        action: "wait",
        why: "no-reading",
        reason: bounded(strings.waitingForReading(host)),
        retryInMs: READING_RETRY_MS,
      };
    }
    const needed = settings.reserveBytes * (others.shares + 1);
    if (free < needed)
      return {
        action: "wait",
        why: "short-of-memory",
        reason: bounded(strings.waitingForMemory(host, free, needed)),
        retryInMs: MEMORY_RETRY_MS,
      };
    const pressure = sample?.reading.supported ? sample.reading.pressureFullAvg10 : null;
    if (pressure != null && pressure >= settings.pressurePercent)
      return {
        action: "wait",
        why: "pressure",
        reason: bounded(strings.waitingForPressure(host, pressure)),
        retryInMs: MEMORY_RETRY_MS,
      };
    return { action: "proceed", why: "enough-memory" };
  }

  return {
    /** The answer for this attempt, without recording anything. */
    preview(input: GateInput): Verdict {
      return decide(input, now());
    },
    /** The answer for this attempt; a turn let through holds a share while it loads. */
    answer(input: GateInput): Answer {
      const at = now();
      forgetExpired(at);
      const verdict = decide(input, at);
      const { host, threadId } = input.question;
      if (host === null || verdict.why === "not-a-new-turn" || verdict.why === "disabled")
        return verdict;
      const wasUnchecked = unread.get(host.id)?.unchecked ?? false;
      let readings: Answer["readings"];
      if (verdict.why === "no-reading" || verdict.why === "reading-unavailable") {
        const unchecked = wasUnchecked || verdict.why === "reading-unavailable";
        unread.set(host.id, { since: unreadSince(host.id, at), last: at, unchecked });
        if (unchecked && !wasUnchecked) readings = "lost";
      } else if (verdict.why !== "few-running") {
        unread.delete(host.id);
        if (wasUnchecked && verdict.why !== "unsupported") readings = "back";
      }
      if (verdict.action === "proceed" && verdict.why !== "unsupported")
        admittedAt.set(threadId, { at, hostId: host.id });
      return readings === undefined ? verdict : { ...verdict, readings };
    },
  };
}
