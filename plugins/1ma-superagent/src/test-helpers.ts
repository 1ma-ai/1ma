import type {
  Executor,
  ObservationResult,
  ServerId,
  ServerSnapshot,
  ThreadSummary,
} from "./observation.js";

export function threadSummary(
  overrides: Partial<ThreadSummary> & { threadId: string },
): ThreadSummary {
  return {
    projectId: "proj_app",
    environmentId: "env_app",
    title: `Chat ${overrides.threadId}`,
    providerId: "claude-code",
    status: "idle",
    hidden: false,
    parentThreadId: null,
    originPluginId: null,
    updatedAt: 1_000,
    ...overrides,
  };
}

export function snapshot(
  threads: readonly ThreadSummary[],
  completeness: ObservationResult<ServerSnapshot>["completeness"] = "complete",
  observedAt = 10_000,
): ObservationResult<ServerSnapshot> {
  return {
    observedAt,
    completeness,
    items: {
      threads,
      environments: [{ environmentId: "env_app", projectId: "proj_app", branch: "main" }],
      projects: [{ projectId: "proj_app", gitRemoteUrl: "https://github.com/example/app.git" }],
    },
  };
}

export function fakeExecutor(
  serverId: ServerId,
  overrides: Partial<Omit<Executor, "serverId">> = {},
): Executor {
  const unused = (name: string) => async () => {
    throw new Error(`fake ${serverId} executor: ${name} not stubbed`);
  };
  return {
    serverId,
    snapshot: unused("snapshot"),
    readMetadata: async () => [],
    threadModel: async () => null,
    projectRemote: unused("projectRemote"),
    spawn: unused("spawn"),
    findSpawned: async () => [],
    clearQueueAndStop: unused("clearQueueAndStop"),
    ...overrides,
  };
}
