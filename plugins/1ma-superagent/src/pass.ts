import type { Executor } from "./observation.js";
import type { PassScope } from "./pass-runner.js";
import type { Store } from "./store.js";

export interface PassDeps {
  readonly store: Store;
  readonly executors: () => readonly Executor[];
  readonly mainBotThreadId: () => string | null;
  readonly signal: AbortSignal;
}

export async function runPass(deps: PassDeps, scope: PassScope): Promise<void> {
  const executors = deps
    .executors()
    .filter(
      (executor) =>
        scope.full || [...scope.threadKeys].some((key) => key.startsWith(`${executor.serverId}:`)),
    );
  const results = await Promise.all(
    executors.map(async (executor) => ({
      executor,
      result: await executor.snapshot(deps.signal),
    })),
  );
  for (const { executor, result } of results) {
    deps.store.recordServerObservation(executor.serverId, result);
    if (result.completeness === "failed") continue;
    deps.store.applySnapshot(executor.serverId, result.items, result, deps.mainBotThreadId());
  }
}
