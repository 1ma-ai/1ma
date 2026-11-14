export type Completeness = "complete" | "partial" | "failed";

export interface ObservationResult<T> {
  readonly observedAt: number;
  readonly completeness: Completeness;
  readonly items: T;
  readonly error?: string;
}

export type ServerId = "mac" | "linux";

export interface ThreadSummary {
  readonly threadId: string;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly title: string | null;
  readonly providerId: string;
  readonly status: string;
  readonly hidden: boolean;
  readonly parentThreadId: string | null;
  readonly originPluginId: string | null;
  readonly updatedAt: number;
}

export interface EnvironmentSummary {
  readonly environmentId: string;
  readonly projectId: string;
  readonly branch: string | null;
}

export interface ProjectSummary {
  readonly projectId: string;
  readonly gitRemoteUrl: string | null;
}

export interface ServerSnapshot {
  readonly threads: readonly ThreadSummary[];
  readonly environments: readonly EnvironmentSummary[];
  readonly projects: readonly ProjectSummary[];
}

export interface Executor {
  readonly serverId: ServerId;
  snapshot(signal: AbortSignal): Promise<ObservationResult<ServerSnapshot>>;
}
