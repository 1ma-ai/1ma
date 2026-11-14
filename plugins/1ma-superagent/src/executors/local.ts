import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type {
  EnvironmentSummary,
  Executor,
  ObservationResult,
  ProjectSummary,
  ServerSnapshot,
  ThreadSummary,
} from "../observation.js";
import { type PagingLimits, DEFAULT_LIMITS, collectOnce, collectPages } from "./paging.js";
import { combineSnapshot, toThreadSummary } from "./snapshot.js";

export function createLocalExecutor(
  sdk: PluginBbSdk,
  limits: PagingLimits = DEFAULT_LIMITS,
  now: () => number = Date.now,
): Executor {
  return {
    serverId: "mac",
    async snapshot(signal): Promise<ObservationResult<ServerSnapshot>> {
      const observedAt = now();
      const [threads, environments, projects] = await Promise.all([
        collectPages<ThreadSummary>(
          async (offset, limit, pageSignal) =>
            (
              await sdk.threads.list({
                archived: false,
                includeHidden: true,
                limit,
                offset,
                signal: pageSignal,
              })
            ).map(toThreadSummary),
          limits,
          signal,
        ),
        collectPages<EnvironmentSummary>(
          async (offset, limit, pageSignal) =>
            (await sdk.environments.list({ limit, offset, signal: pageSignal })).map((env) => ({
              environmentId: env.id,
              projectId: env.projectId,
              branch: env.branchName,
            })),
          limits,
          signal,
        ),
        collectOnce<ProjectSummary>(
          async (pageSignal) =>
            (await sdk.projects.list({ signal: pageSignal })).map((project) => ({
              projectId: project.id,
              gitRemoteUrl: project.gitRemoteUrl,
            })),
          limits,
          signal,
        ),
      ]);
      return combineSnapshot(observedAt, threads, environments, projects);
    },
  };
}
