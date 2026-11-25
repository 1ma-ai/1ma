import type { MemoryReading } from "./contract.js";
import { withDeadline } from "./deadline.js";
import { freeBytes, type GateHost, type Sample } from "./gate.js";

export const SAMPLE_INTERVAL_MS = 5_000;
export const READ_TIMEOUT_MS = 4_000;
export const READ_DEADLINE_MS = 8_000;
export const MAX_BACKOFF_MS = 60_000;

export interface SamplerDeps {
  /** Monotonic milliseconds. */
  now(): number;
  connectedHosts(signal: AbortSignal): Promise<GateHost[]>;
  read(hostId: string, signal: AbortSignal): Promise<MemoryReading>;
  warn(message: string): void;
}

interface Machine {
  name: string;
  /** Bumped when the machine connects again; a result of an older connection is dropped. */
  connection: number;
  /** The connection whose read has not settled yet. */
  pending: number | null;
  failures: number;
  retryAt: number;
  sample: Sample | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSampler(deps: SamplerDeps) {
  const machines = new Map<string, Machine>();
  let active: AbortSignal | null = null;
  let requested = false;
  let wake: (() => void) | null = null;
  let listFailing = false;

  function machineFor(id: string, name: string): Machine {
    const known = machines.get(id);
    if (known !== undefined) return known;
    const machine: Machine = {
      name,
      connection: 0,
      pending: null,
      failures: 0,
      retryAt: 0,
      sample: undefined,
    };
    machines.set(id, machine);
    return machine;
  }

  function startRead(id: string, machine: Machine, signal: AbortSignal): void {
    if (machine.pending === machine.connection || deps.now() < machine.retryAt) return;
    const connection = machine.connection;
    machine.pending = connection;
    const { call, answer } = withDeadline(
      (callSignal) => deps.read(id, callSignal),
      signal,
      READ_DEADLINE_MS,
    );
    const settled = () => {
      if (machine.pending === connection) machine.pending = null;
    };
    call.then(settled, settled);
    const current = () =>
      !signal.aborted && machines.get(id) === machine && machine.connection === connection;
    answer.then(
      (reading) => {
        if (!current()) return;
        const takenAt = deps.now();
        machine.sample = {
          reading,
          takenAt,
          usableAt: freeBytes(reading) === null ? (machine.sample?.usableAt ?? null) : takenAt,
        };
        machine.failures = 0;
        machine.retryAt = 0;
      },
      (error: unknown) => {
        if (!current()) return;
        machine.failures += 1;
        const delay = Math.min(SAMPLE_INTERVAL_MS * 2 ** (machine.failures - 1), MAX_BACKOFF_MS);
        machine.retryAt = deps.now() + delay;
        deps.warn(
          `could not read memory on ${machine.name || id}: ${errorMessage(error)}; next try in ${String(delay / 1000)} s`,
        );
      },
    );
  }

  async function sampleAll(signal: AbortSignal): Promise<void> {
    let hosts: GateHost[];
    try {
      hosts = await withDeadline(
        (callSignal) => deps.connectedHosts(callSignal),
        signal,
        READ_DEADLINE_MS,
      ).answer;
    } catch (error) {
      // The list is the plugin's own server, asked at the usual pace: a slower
      // pace would leave turns unchecked for longer once the server answers again.
      if (!signal.aborted && !listFailing)
        deps.warn(
          `could not list machines: ${errorMessage(error)}; readings age until the list is back`,
        );
      listFailing = !signal.aborted;
      return;
    }
    listFailing = false;
    const listed = new Set(hosts.map((host) => host.id));
    for (const id of machines.keys()) if (!listed.has(id)) machines.delete(id);
    for (const host of hosts) {
      const machine = machineFor(host.id, host.name);
      machine.name = host.name;
      startRead(host.id, machine, signal);
    }
  }

  function pause(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        wake = null;
        resolve();
      };
      const timer = setTimeout(finish, SAMPLE_INTERVAL_MS);
      signal.addEventListener("abort", finish, { once: true });
      wake = finish;
    });
  }

  return {
    get(hostId: string): Sample | undefined {
      return machines.get(hostId)?.sample;
    },
    /** Sample again now instead of at the next interval. */
    requestRefresh(): void {
      requested = true;
      wake?.();
    },
    /**
     * The machine connected again: what answers under its id may be another
     * daemon, so the reading it gave before no longer speaks for it. Forget
     * its backoff and read it now.
     */
    reconnected(hostId: string): void {
      if (active === null) return;
      const machine = machineFor(hostId, hostId);
      machine.connection += 1;
      if (machine.sample !== undefined) machine.sample = { ...machine.sample, reading: null };
      machine.failures = 0;
      machine.retryAt = 0;
      startRead(hostId, machine, active);
    },
    async run(signal: AbortSignal): Promise<void> {
      active = signal;
      try {
        while (!signal.aborted) {
          requested = false;
          await sampleAll(signal);
          if (!signal.aborted && !requested) await pause(signal);
        }
      } finally {
        active = null;
        wake = null;
      }
    },
  };
}
