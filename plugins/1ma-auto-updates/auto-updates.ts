export const QUIET_MS = 15 * 60_000;
export const SETTLE_MS = 5_000;
export const HELD_RETRY_MS = 30_000;
export const MAX_HOLD_MS = 10 * 60_000;

export interface ThreadState {
  status: string;
  backgroundAgents: number;
  workflows: number;
}

export interface ProviderTarget {
  hostId: string;
  hostName: string;
  providerId: string;
}

export interface UpdateWork {
  providers: ProviderTarget[];
  plugins: string[];
}

export interface UpdateChoices {
  providers: boolean;
  plugins: boolean;
}

export interface AutoUpdatesDeps {
  selfId: string;
  now(): number;
  sleep(ms: number): Promise<void>;
  choices(): Promise<UpdateChoices>;
  threads(): Promise<ThreadState[] | null>;
  findWork(choices: UpdateChoices): Promise<UpdateWork>;
  installProvider(target: ProviderTarget): Promise<boolean>;
  updatePlugin(pluginId: string): Promise<boolean>;
  releaseHeld(): void;
  warn(message: string): void;
}

export type PassOutcome =
  | { kind: "off" }
  | { kind: "in-progress" }
  | { kind: "recent-activity" }
  | { kind: "busy" }
  | { kind: "nothing-to-update" }
  | { kind: "updated"; installed: string[]; failed: string[] };

export type DispatchDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string; sendAt: number };

export function threadsAreBusy(threads: ThreadState[] | null): boolean {
  return (
    threads === null ||
    threads.some(
      (thread) =>
        thread.status === "starting" ||
        thread.status === "active" ||
        thread.backgroundAgents > 0 ||
        thread.workflows > 0,
    )
  );
}

export function createAutoUpdates(deps: AutoUpdatesDeps, holdReason: string) {
  let lastActivityAt = deps.now();
  let holdingSince: number | null = null;
  let current: Promise<PassOutcome> | null = null;

  async function attempt(label: string, run: () => Promise<boolean>) {
    try {
      if (await run()) return true;
      deps.warn(`${label}: the update did not complete`);
    } catch (error) {
      deps.warn(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }

  async function pass(): Promise<PassOutcome> {
    const choices = await deps.choices();
    if (!choices.providers && !choices.plugins) return { kind: "off" };
    if (deps.now() - lastActivityAt < QUIET_MS) return { kind: "recent-activity" };
    if (threadsAreBusy(await deps.threads())) return { kind: "busy" };
    const work = await deps.findWork(choices);
    if (work.providers.length === 0 && work.plugins.length === 0)
      return { kind: "nothing-to-update" };

    holdingSince = deps.now();
    try {
      await deps.sleep(SETTLE_MS);
      if (threadsAreBusy(await deps.threads())) return { kind: "busy" };
      const steps = [
        ...work.providers.map((target) => ({
          label: `${target.providerId} on ${target.hostName}`,
          run: () => deps.installProvider(target),
        })),
        ...[
          ...work.plugins.filter((id) => id !== deps.selfId),
          ...work.plugins.filter((id) => id === deps.selfId),
        ].map((pluginId) => ({
          label: `plugin ${pluginId}`,
          run: () => deps.updatePlugin(pluginId),
        })),
      ];
      const installed: string[] = [];
      const failed: string[] = [];
      await steps.reduce<Promise<void>>(
        (previous, step) =>
          previous.then(async () => {
            ((await attempt(step.label, step.run)) ? installed : failed).push(step.label);
          }),
        Promise.resolve(),
      );
      return { kind: "updated", installed, failed };
    } finally {
      holdingSince = null;
      deps.releaseHeld();
    }
  }

  return {
    noteThreadActivity(): void {
      lastActivityAt = deps.now();
    },
    decideDispatch(): DispatchDecision {
      return holdingSince !== null && deps.now() - holdingSince < MAX_HOLD_MS
        ? {
            action: "wait",
            reason: holdReason,
            sendAt: deps.now() + HELD_RETRY_MS,
          }
        : { action: "proceed" };
    },
    run(): Promise<PassOutcome> {
      if (current !== null) return Promise.resolve({ kind: "in-progress" });
      current = pass().finally(() => {
        current = null;
      });
      return current;
    },
  };
}
