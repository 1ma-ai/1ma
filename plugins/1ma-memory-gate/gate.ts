import type { MemoryReading } from "./contract.js";
import { strings } from "./strings.js";

export const SAMPLE_MAX_AGE_MS = 15_000;
export const READING_RETRY_MS = 2_000;
export const READING_GRACE_MS = 30_000;
export const MEMORY_RETRY_MS = 15_000;
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

export function createGate(now: () => number) {
  // When this gate let each thread start. A thread's memory does not show in a
  // reading until it has loaded, so while it runs it holds a share meanwhile.
  const admittedAt = new Map<string, number>();
  // Since when turns on a host have been asking without a reading to decide from.
  const unread = new Map<string, { since: number; last: number }>();

  function unreadSince(hostId: string, at: number): number {
    const asked = unread.get(hostId);
    return asked !== undefined && at - asked.last <= READING_GRACE_MS ? asked.since : at;
  }

  function forgetExpired(at: number): void {
    for (const [id, admitted] of admittedAt)
      if (at - admitted >= ADMISSION_WINDOW_MS) admittedAt.delete(id);
    for (const [hostId, asked] of unread)
      if (at - asked.last > READING_GRACE_MS) unread.delete(hostId);
  }

  function decide(input: GateInput, at: number): Verdict {
    const { question, settings, sample } = input;
    if (!isNewTurnOnHost(question)) return { action: "proceed", why: "not-a-new-turn" };
    if (!settings.enabled) return { action: "proceed", why: "disabled" };
    if (sample?.reading.supported === false) return { action: "proceed", why: "unsupported" };
    const host = hostLabel(question.host);
    const free = sample === undefined ? null : freeBytes(sample.reading);
    if (sample === undefined || at - sample.takenAt > SAMPLE_MAX_AGE_MS || free === null) {
      // A reading that stays away must not hold chats forever: the thread-count
      // limit still guards a machine this gate cannot see.
      if (at - unreadSince(question.host.id, at) >= READING_GRACE_MS)
        return { action: "proceed", why: "reading-unavailable" };
      return {
        action: "wait",
        why: "no-reading",
        reason: bounded(strings.waitingForReading(host)),
        retryInMs: READING_RETRY_MS,
      };
    }
    const running = input.runningOnHost.filter((id) => id !== question.threadId);
    if (new Set(running).size < settings.minRunning)
      return { action: "proceed", why: "few-running" };
    // Core commits a cleared turn's status before the next attempt is asked, so
    // a thread let through here and held by another plugin is not in the list.
    const loading = new Set(
      running.filter((id) => {
        const admitted = admittedAt.get(id);
        return admitted !== undefined && at - admitted < ADMISSION_WINDOW_MS;
      }),
    );
    const needed = settings.reserveBytes * (loading.size + 1);
    if (free < needed)
      return {
        action: "wait",
        why: "short-of-memory",
        reason: bounded(strings.waitingForMemory(host, free, needed)),
        retryInMs: MEMORY_RETRY_MS,
      };
    const pressure = sample.reading.supported ? sample.reading.pressureFullAvg10 : null;
    if (pressure !== null && pressure >= settings.pressurePercent)
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
    answer(input: GateInput): Verdict {
      const at = now();
      forgetExpired(at);
      const verdict = decide(input, at);
      const { host, threadId } = input.question;
      if (host === null || verdict.why === "not-a-new-turn" || verdict.why === "disabled")
        return verdict;
      if (verdict.why === "no-reading" || verdict.why === "reading-unavailable")
        unread.set(host.id, { since: unreadSince(host.id, at), last: at });
      else unread.delete(host.id);
      if (verdict.action === "proceed" && verdict.why !== "unsupported")
        admittedAt.set(threadId, at);
      return verdict;
    },
  };
}
