import type { MemoryReading } from "./contract.js";
import { strings } from "./strings.js";

export const SAMPLE_MAX_AGE_MS = 15_000;
export const READING_GRACE_MS = 30_000;
export const PENDING_MAX_MS = 120_000;
export const ADMISSION_WINDOW_MS = 45_000;
export const FORGET_AFTER_MS = 10_000;
export const MAX_REASON_LENGTH = 200;

export interface GateSettings {
  enabled: boolean;
  reserveBytes: number;
  pressurePercent: number;
  minRunning: number;
}

export interface Sample {
  /** Null from the moment the machine connected again until it answers anew. */
  reading: MemoryReading | null;
  takenAt: number;
  /** When the last reading with a free-memory figure was taken, if ever. */
  usableAt: number | null;
}

/** What the sampler knows about each machine. */
export interface Readings {
  get(hostId: string): Sample | undefined;
  /** The machine left the machine list. */
  gone(hostId: string): boolean;
}

export interface GateHost {
  id: string;
  name: string;
}

export interface RunningThread {
  id: string;
  hostId: string | null;
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
  /** The threads the server lists as running, on every machine. */
  running: readonly RunningThread[];
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
    };

/**
 * A verdict, with a note on the one that starts or ends a time when the
 * machine's turns go ahead unchecked.
 */
export type Answer = Verdict & { readings?: "lost" | "back" };

/** Waiting turns that are to be asked about again. */
export type Due = ReadonlyMap<string, Waiting>;

interface Admitted {
  hostId: string;
  at: number;
  /** Another plugin or core held the attempt; the gate is asked again when it is re-tried. */
  queued: boolean;
  runningAt: number | null;
}

interface Waiting {
  hostId: string;
  since: number;
  /** Set when a re-attempt was asked for without the hook being asked again. */
  recheckedAt: number | null;
}

const ADMITTING: ReadonlySet<Verdict["why"]> = new Set([
  "few-running",
  "enough-memory",
  "reading-unavailable",
]);

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

export function freeBytes(reading: MemoryReading | null): number | null {
  if (reading === null || !reading.supported) return null;
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
  // The turns this gate let through. A thread's memory does not show in a
  // reading until it has loaded, so it holds a share meanwhile.
  const admitted = new Map<string, Admitted>();
  // The turns whose latest answer from this gate was to wait.
  const waiting = new Map<string, Waiting>();
  // Since when each machine's turns have gone ahead without a reading.
  const unchecked = new Map<string, number>();

  function holdsShare(entry: Admitted, listed: boolean, at: number): boolean {
    if (entry.runningAt !== null) return listed && at - entry.runningAt < ADMISSION_WINDOW_MS;
    // bb reports nothing when a cleared turn fails while core prepares it, so a
    // turn that never shows as running stops holding its share at some point.
    return listed || (!entry.queued && at - entry.at < PENDING_MAX_MS);
  }

  function forgetSpent(listed: ReadonlySet<string>, at: number): void {
    for (const [id, entry] of admitted) {
      const spent =
        entry.runningAt === null
          ? !listed.has(id) && (entry.queued || at - entry.at >= PENDING_MAX_MS)
          : at - entry.runningAt >= ADMISSION_WINDOW_MS;
      if (spent) admitted.delete(id);
    }
  }

  function waitingSince(hostId: string): number | null {
    let since: number | null = null;
    for (const entry of waiting.values())
      if (entry.hostId === hostId && (since === null || entry.since < since)) since = entry.since;
    return since;
  }

  /** The other chats on a host, and how many of them hold a share. */
  function chatsOnHost(
    hostId: string,
    threadId: string,
    running: readonly RunningThread[],
    at: number,
  ) {
    const listed = new Set(running.map((thread) => thread.id));
    const chats = new Set(
      running
        .filter((thread) => thread.hostId === hostId && thread.id !== threadId)
        .map((thread) => thread.id),
    );
    let shares = 0;
    for (const [id, entry] of admitted) {
      if (id === threadId || entry.hostId !== hostId) continue;
      if (!holdsShare(entry, listed.has(id), at)) continue;
      shares += 1;
      if (entry.runningAt === null) chats.add(id);
    }
    return { count: chats.size, shares };
  }

  function decide(input: GateInput, at: number): Verdict {
    const { question, settings, sample } = input;
    if (!isNewTurnOnHost(question)) return { action: "proceed", why: "not-a-new-turn" };
    if (!settings.enabled) return { action: "proceed", why: "disabled" };
    if (sample?.reading?.supported === false) return { action: "proceed", why: "unsupported" };
    const others = chatsOnHost(question.host.id, question.threadId, input.running, at);
    if (others.count < settings.minRunning) return { action: "proceed", why: "few-running" };
    const host = hostLabel(question.host);
    const free = freshFreeBytes(sample, at);
    if (free === null) {
      // A reading that stays away must not hold chats forever: the thread-count
      // limit still guards a machine this gate cannot see.
      const usableAt = sample?.usableAt ?? null;
      const since = waitingSince(question.host.id);
      const waited = since === null ? 0 : at - since;
      const unreadable = usableAt === null ? waited : at - (usableAt + SAMPLE_MAX_AGE_MS);
      if (waited >= READING_GRACE_MS && unreadable >= READING_GRACE_MS)
        return { action: "proceed", why: "reading-unavailable" };
      return {
        action: "wait",
        why: "no-reading",
        reason: bounded(strings.waitingForReading(host)),
      };
    }
    if (free < settings.reserveBytes * (others.shares + 1))
      return {
        action: "wait",
        why: "short-of-memory",
        reason: bounded(strings.waitingForMemory(host)),
      };
    const pressure = sample?.reading?.supported ? sample.reading.pressureFullAvg10 : null;
    if (pressure != null && pressure >= settings.pressurePercent)
      return {
        action: "wait",
        why: "pressure",
        reason: bounded(strings.waitingForPressure(host)),
      };
    return { action: "proceed", why: "enough-memory" };
  }

  /** Ends the machine's unchecked time once it gave a usable reading since. */
  function endUnchecked(hostId: string, sample: Sample | undefined): boolean {
    const since = unchecked.get(hostId);
    const usableAt = sample?.usableAt ?? null;
    if (since === undefined || usableAt === null || usableAt <= since) return false;
    unchecked.delete(hostId);
    return true;
  }

  return {
    /** The answer for this attempt, without recording anything. */
    preview(input: GateInput): Verdict {
      return decide(input, now());
    },
    /** The memory a new chat on the host needs now. */
    neededBytes(hostId: string, settings: GateSettings, running: readonly RunningThread[]): number {
      return settings.reserveBytes * (chatsOnHost(hostId, "", running, now()).shares + 1);
    },
    /** The answer for this attempt; a turn let through holds a share while it loads. */
    answer(input: GateInput): Answer {
      const at = now();
      forgetSpent(new Set(input.running.map((thread) => thread.id)), at);
      const verdict = decide(input, at);
      const { host, threadId } = input.question;
      if (host === null) {
        waiting.delete(threadId);
        return verdict;
      }
      let readings: Answer["readings"] = endUnchecked(host.id, input.sample) ? "back" : undefined;
      if (verdict.action === "wait") {
        const since = waiting.get(threadId)?.since ?? at;
        waiting.set(threadId, { hostId: host.id, since, recheckedAt: null });
      } else {
        waiting.delete(threadId);
        if (ADMITTING.has(verdict.why))
          admitted.set(threadId, { hostId: host.id, at, queued: false, runningAt: null });
      }
      if (verdict.why === "reading-unavailable" && !unchecked.has(host.id)) {
        unchecked.set(host.id, at);
        readings = "lost";
      }
      return readings === undefined ? verdict : { ...verdict, readings };
    },
    /** The hook let the turn through without asking the gate. */
    passed(threadId: string): void {
      waiting.delete(threadId);
    },
    /** An attempt of the thread was stored as a waiting row. */
    queued(threadId: string): void {
      const entry = admitted.get(threadId);
      if (entry !== undefined && entry.runningAt === null) entry.queued = true;
    },
    /** A queued row of the thread dispatched. */
    dispatched(threadId: string): void {
      waiting.delete(threadId);
    },
    /** The thread's turn started running. */
    active(threadId: string): void {
      const entry = admitted.get(threadId);
      if (entry !== undefined) entry.runningAt ??= now();
      waiting.delete(threadId);
    },
    /** The thread's turn ended. */
    ended(threadId: string): void {
      admitted.delete(threadId);
    },
    /** The thread is gone with all its rows. */
    removed(threadId: string): void {
      admitted.delete(threadId);
      waiting.delete(threadId);
    },
    /** A user removed one row of the thread; others may remain. */
    cancelled(threadId: string): void {
      const entry = waiting.get(threadId);
      if (entry !== undefined) entry.recheckedAt ??= now();
    },
    hasWaiting(): boolean {
      return waiting.size > 0;
    },
    waitingOn(hostId: string): number {
      let count = 0;
      for (const entry of waiting.values()) if (entry.hostId === hostId) count += 1;
      return count;
    },
    /** The machines whose unchecked time ended, each reported once. */
    readingsBack(readings: Readings): string[] {
      const back: string[] = [];
      for (const hostId of unchecked.keys()) {
        if (readings.gone(hostId)) unchecked.delete(hostId);
        else if (endUnchecked(hostId, readings.get(hostId))) back.push(hostId);
      }
      return back;
    },
    /** Every waiting turn. */
    allWaiting(): Due {
      return new Map(waiting);
    },
    /** The waiting turns that would go ahead now, or whose rows are in doubt. */
    due(settings: GateSettings, readings: Readings, running: readonly RunningThread[]): Due {
      const at = now();
      const due = new Map<string, Waiting>();
      for (const [threadId, entry] of waiting) {
        const verdict = decide(
          {
            question: {
              attempt: "start-turn",
              threadId,
              threadStatus: "idle",
              host: { id: entry.hostId, name: entry.hostId },
            },
            settings,
            sample: readings.get(entry.hostId),
            running,
          },
          at,
        );
        if (verdict.action === "proceed" || entry.recheckedAt !== null) due.set(threadId, entry);
      }
      return due;
    },
    /**
     * Core was asked to re-attempt the due turns. One re-attempted for 10 s
     * is forgotten, its last chance spent: that is bb's time limit for a hook
     * pass, so a row whose attempt had begun before the first re-attempt is
     * stored by then, and a turn that is gone is not asked about again. If its
     * row still exists, the hook is asked and the turn comes back.
     */
    rechecked(due: Due): void {
      const at = now();
      for (const [threadId, entry] of due) {
        if (waiting.get(threadId) !== entry) continue;
        if (entry.recheckedAt !== null && at - entry.recheckedAt >= FORGET_AFTER_MS)
          waiting.delete(threadId);
        else entry.recheckedAt ??= at;
      }
    },
  };
}
