import type { MemoryReading } from "./contract.js";
import { strings } from "./strings.js";

export const SAMPLE_MAX_AGE_MS = 15_000;
export const READING_RETRY_MS = 2_000;
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
  /** Ids of the threads running on the question's host. */
  runningOnHost: readonly string[];
}

export type Verdict =
  | {
      action: "proceed";
      why: "not-a-new-turn" | "disabled" | "unsupported" | "few-running" | "enough-memory";
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
  // Threads this gate let start, per host: their memory does not show in a
  // reading until they have loaded, so each one holds a reserve meanwhile.
  const admissions = new Map<string, Map<string, number>>();

  function admittedOthers(hostId: string, threadId: string, at: number): string[] {
    const onHost = admissions.get(hostId);
    if (onHost === undefined) return [];
    for (const [id, admittedAt] of onHost)
      if (at - admittedAt >= ADMISSION_WINDOW_MS) onHost.delete(id);
    if (onHost.size === 0) admissions.delete(hostId);
    return [...onHost.keys()].filter((id) => id !== threadId);
  }

  function decide(input: GateInput, at: number): Verdict {
    const { question, settings, sample } = input;
    if (!isNewTurnOnHost(question)) return { action: "proceed", why: "not-a-new-turn" };
    if (!settings.enabled) return { action: "proceed", why: "disabled" };
    if (sample?.reading.supported === false) return { action: "proceed", why: "unsupported" };
    const host = hostLabel(question.host);
    const free = sample === undefined ? null : freeBytes(sample.reading);
    if (sample === undefined || at - sample.takenAt > SAMPLE_MAX_AGE_MS || free === null)
      return {
        action: "wait",
        why: "no-reading",
        reason: bounded(strings.waitingForReading(host)),
        retryInMs: READING_RETRY_MS,
      };
    const admitted = admittedOthers(question.host.id, question.threadId, at);
    const running = new Set(
      [...input.runningOnHost, ...admitted].filter((id) => id !== question.threadId),
    );
    if (running.size < settings.minRunning) return { action: "proceed", why: "few-running" };
    const needed = settings.reserveBytes * (admitted.length + 1);
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
    /** The answer for this attempt; a turn let through on a host holds a reserve there. */
    answer(input: GateInput): Verdict {
      const at = now();
      const verdict = decide(input, at);
      const { host, threadId } = input.question;
      if (
        host !== null &&
        verdict.action === "proceed" &&
        (verdict.why === "few-running" || verdict.why === "enough-memory")
      ) {
        const onHost = admissions.get(host.id) ?? new Map<string, number>();
        if (!onHost.has(threadId)) onHost.set(threadId, at);
        admissions.set(host.id, onHost);
      }
      return verdict;
    },
  };
}
