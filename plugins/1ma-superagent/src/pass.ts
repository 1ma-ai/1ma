import { type Guard, type PluginSettings, guardOf } from "./admission.js";
import type { GitHubReader } from "./github/reader.js";
import {
  type Completeness,
  type Executor,
  type QueuedWait,
  type ServerId,
  type ThreadSummary,
  waitingReasonOf,
} from "./observation.js";
import type { PassScope } from "./pass-runner.js";
import { runPrPass } from "./pr-pass.js";
import type { PrStore } from "./pr-store.js";
import { type Store, isOwnerChat } from "./store.js";

export interface GitHubPassState {
  readonly at: number;
  readonly problems: readonly string[];
}

export interface PassDeps {
  readonly store: Store;
  readonly prStore: PrStore;
  readonly settings: () => PluginSettings;
  readonly github: () => GitHubReader | null;
  readonly mainBotThreadId: () => string | null;
  readonly recordGitHub: (state: GitHubPassState) => Promise<void>;
  readonly afterFullPass: (
    now: number,
    read: PluginSettings,
    observed: ReadonlyMap<ServerId, Completeness>,
    admit: Guard,
  ) => Promise<void>;
  readonly now: () => number;
  readonly signal: AbortSignal;
}

export type PassOutcome = "done" | "inactive" | "superseded";

async function recordWaitingReasons(
  deps: PassDeps,
  admit: Guard,
  executor: Executor,
  threads: readonly ThreadSummary[],
  now: number,
): Promise<void> {
  const mainBot = deps.mainBotThreadId();
  await Promise.all(
    threads
      .filter((thread) => isOwnerChat(thread, mainBot))
      .map(async (thread) => {
        let waits: QueuedWait[] = [];
        if (thread.queuedWork === "waiting") {
          try {
            waits = await executor.queuedWaits(thread.threadId, deps.signal);
          } catch {
            return;
          }
        }
        if (!admit()) return;
        deps.store.setWaitingReason(
          executor.serverId,
          thread.threadId,
          waitingReasonOf(thread, waits),
          now,
        );
      }),
  );
}

export async function runPass(deps: PassDeps, scope: PassScope): Promise<PassOutcome> {
  const read = deps.settings();
  if (!read.active) return "inactive";
  const admit = guardOf(read, deps.settings);
  const executors = [...read.executors.values()].filter(
    (executor) =>
      scope.full || [...scope.threadKeys].some((key) => key.startsWith(`${executor.serverId}:`)),
  );
  const results = await Promise.all(
    executors.map(async (executor) => ({
      executor,
      result: await executor.snapshot(deps.signal),
    })),
  );
  if (!admit()) return "superseded";
  const observed = new Map<ServerId, Completeness>();
  for (const { executor, result } of results) {
    observed.set(executor.serverId, result.completeness);
    deps.store.recordServerObservation(executor.serverId, result);
    if (result.completeness === "failed") continue;
    deps.store.applySnapshot(executor.serverId, result.items, result, deps.mainBotThreadId());
  }
  await Promise.all(
    results
      .filter(({ result }) => result.completeness !== "failed")
      .map(({ executor, result }) =>
        recordWaitingReasons(deps, admit, executor, result.items.threads, result.observedAt),
      ),
  );
  if (!admit()) return "superseded";
  if (!scope.full) return "done";
  const now = deps.now();
  const { problems } = await runPrPass({
    store: deps.store,
    prStore: deps.prStore,
    github: deps.github(),
    policy: read.policy,
    executors: read.executors,
    observed,
    now,
    signal: deps.signal,
    admitted: admit,
  });
  if (!admit()) return "superseded";
  await deps.recordGitHub({ at: now, problems: problems.slice(0, 20) });
  if (!admit()) return "superseded";
  await deps.afterFullPass(now, read, observed, admit);
  return admit() ? "done" : "superseded";
}
