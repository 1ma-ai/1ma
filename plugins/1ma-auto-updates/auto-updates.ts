export const QUIET_MS = 15 * 60_000;
export const SETTLE_MS = 5_000;
export const HELD_RETRY_MS = 30_000;

export interface ThreadState {
  status: string;
  backgroundAgents: number;
  backgroundCommands: number;
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
  otherPlugins: boolean;
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
  | { kind: "attempted"; installed: string[]; failed: string[]; postponed: string[] };

export type DispatchDecision =
  | { action: "proceed" }
  | { action: "wait"; reason: string; sendAt: number };

interface Step {
  label: string;
  run(): Promise<boolean>;
}

interface Progress {
  installed: string[];
  failed: string[];
}

export function threadsAreBusy(threads: ThreadState[] | null): boolean {
  return (
    threads === null ||
    threads.some(
      (thread) =>
        thread.status === "starting" ||
        thread.status === "active" ||
        thread.backgroundAgents > 0 ||
        thread.backgroundCommands > 0 ||
        thread.workflows > 0,
    )
  );
}

export function createAutoUpdates(deps: AutoUpdatesDeps, holdReason: (update: string) => string) {
  let lastActivityAt = deps.now();
  let installing: string | null = null;
  let current: Promise<PassOutcome> | null = null;

  async function busy(): Promise<boolean> {
    return threadsAreBusy(await deps.threads());
  }

  async function attempt(step: Step): Promise<boolean> {
    try {
      if (await step.run()) return true;
      deps.warn(`${step.label}: the update did not complete`);
    } catch (error) {
      deps.warn(`${step.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return false;
  }

  async function install(step: Step): Promise<"installed" | "failed" | "busy"> {
    installing = step.label;
    try {
      await deps.sleep(SETTLE_MS);
      if (await busy()) return "busy";
      return (await attempt(step)) ? "installed" : "failed";
    } finally {
      installing = null;
      deps.releaseHeld();
    }
  }

  async function installEach(steps: Step[], progress: Progress): Promise<PassOutcome> {
    const [step, ...rest] = steps;
    if (step === undefined) return { kind: "attempted", ...progress, postponed: [] };
    const result = await install(step);
    if (result === "busy")
      return { kind: "attempted", ...progress, postponed: steps.map((each) => each.label) };
    return installEach(
      rest,
      result === "installed"
        ? { installed: [...progress.installed, step.label], failed: progress.failed }
        : { installed: progress.installed, failed: [...progress.failed, step.label] },
    );
  }

  async function pass(): Promise<PassOutcome> {
    const choices = await deps.choices();
    if (!choices.providers && !choices.plugins && !choices.otherPlugins) return { kind: "off" };
    if (deps.now() - lastActivityAt < QUIET_MS) return { kind: "recent-activity" };
    if (await busy()) return { kind: "busy" };
    const work = await deps.findWork(choices);
    const steps: Step[] = [
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
    if (steps.length === 0) return { kind: "nothing-to-update" };
    return installEach(steps, { installed: [], failed: [] });
  }

  return {
    noteThreadActivity(): void {
      lastActivityAt = deps.now();
    },
    decideDispatch(): DispatchDecision {
      return installing === null
        ? { action: "proceed" }
        : {
            action: "wait",
            reason: holdReason(installing),
            sendAt: deps.now() + HELD_RETRY_MS,
          };
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
