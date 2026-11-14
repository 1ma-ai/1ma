import type { GitHubReader } from "./github/reader.js";
import type { Completeness, Executor, ServerId } from "./observation.js";
import type { PassScope } from "./pass-runner.js";
import { runPrPass } from "./pr-pass.js";
import type { PrStore } from "./pr-store.js";
import type { RepoPolicy } from "./repos.js";
import type { Store } from "./store.js";

export interface GitHubPassState {
  readonly at: number;
  readonly problems: readonly string[];
}

export interface PassDeps {
  readonly store: Store;
  readonly prStore: PrStore;
  readonly executors: () => readonly Executor[];
  readonly github: () => GitHubReader | null;
  readonly policy: () => RepoPolicy;
  readonly mainBotThreadId: () => string | null;
  readonly recordGitHub: (state: GitHubPassState) => Promise<void>;
  readonly now: () => number;
  readonly signal: AbortSignal;
}

export async function runPass(deps: PassDeps, scope: PassScope): Promise<void> {
  const all = deps.executors();
  const executors = all.filter(
    (executor) =>
      scope.full || [...scope.threadKeys].some((key) => key.startsWith(`${executor.serverId}:`)),
  );
  const results = await Promise.all(
    executors.map(async (executor) => ({
      executor,
      result: await executor.snapshot(deps.signal),
    })),
  );
  const observed = new Map<ServerId, Completeness>();
  for (const { executor, result } of results) {
    observed.set(executor.serverId, result.completeness);
    deps.store.recordServerObservation(executor.serverId, result);
    if (result.completeness === "failed") continue;
    deps.store.applySnapshot(executor.serverId, result.items, result, deps.mainBotThreadId());
  }
  if (!scope.full) return;
  const now = deps.now();
  const { problems } = await runPrPass({
    store: deps.store,
    prStore: deps.prStore,
    github: deps.github(),
    policy: deps.policy(),
    executors: new Map(all.map((executor) => [executor.serverId, executor])),
    observed,
    now,
    signal: deps.signal,
  });
  await deps.recordGitHub({ at: now, problems: problems.slice(0, 20) });
}
