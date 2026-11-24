import type { MemoryReading } from "./contract.js";
import type { GateHost, Sample } from "./gate.js";

export const SAMPLE_INTERVAL_MS = 5_000;
export const READ_TIMEOUT_MS = 4_000;
export const MAX_BACKOFF_MS = 60_000;

export interface SamplerDeps {
  now(): number;
  connectedHosts(signal: AbortSignal): Promise<GateHost[]>;
  read(hostId: string, signal: AbortSignal): Promise<MemoryReading>;
  warn(message: string): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSampler(deps: SamplerDeps) {
  const samples = new Map<string, Sample>();
  const failing = new Map<string, { failures: number; retryAt: number }>();
  let requested = false;
  let wake: (() => void) | null = null;

  async function sampleHost(host: GateHost, signal: AbortSignal): Promise<void> {
    const backoff = failing.get(host.id);
    if (backoff !== undefined && deps.now() < backoff.retryAt) return;
    try {
      const reading = await deps.read(host.id, signal);
      samples.set(host.id, { reading, takenAt: deps.now() });
      failing.delete(host.id);
    } catch (error) {
      if (signal.aborted) return;
      const failures = (backoff?.failures ?? 0) + 1;
      const delay = Math.min(SAMPLE_INTERVAL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);
      failing.set(host.id, { failures, retryAt: deps.now() + delay });
      deps.warn(
        `could not read memory on ${host.name || host.id}: ${errorMessage(error)}; next try in ${String(delay / 1000)} s`,
      );
    }
  }

  async function sampleAll(signal: AbortSignal): Promise<void> {
    let hosts: GateHost[];
    try {
      hosts = await deps.connectedHosts(signal);
    } catch (error) {
      if (!signal.aborted) deps.warn(`could not list machines: ${errorMessage(error)}`);
      return;
    }
    const connected = new Set(hosts.map((host) => host.id));
    for (const id of failing.keys()) if (!connected.has(id)) failing.delete(id);
    await Promise.all(hosts.map((host) => sampleHost(host, signal)));
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
      return samples.get(hostId);
    },
    /** Sample again now instead of at the next interval. */
    requestRefresh(): void {
      requested = true;
      wake?.();
    },
    async run(signal: AbortSignal): Promise<void> {
      try {
        while (!signal.aborted) {
          requested = false;
          await sampleAll(signal);
          if (!signal.aborted && !requested) await pause(signal);
        }
      } finally {
        wake = null;
      }
    },
  };
}
