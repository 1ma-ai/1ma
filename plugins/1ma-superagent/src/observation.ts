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
  readonly queuedWork: string;
  readonly hasPendingInteraction: boolean;
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

export interface ThreadMetadataRow {
  readonly threadId: string;
  readonly metadata: unknown;
}

export interface SpawnedThread extends ThreadMetadataRow {
  readonly projectId: string;
  readonly createdAt: number;
}

export interface Executor {
  readonly serverId: ServerId;
  snapshot(signal: AbortSignal): Promise<ObservationResult<ServerSnapshot>>;
  readMetadata(threadIds: readonly string[], signal: AbortSignal): Promise<ThreadMetadataRow[]>;
  threadModel(threadId: string, signal: AbortSignal): Promise<string | null>;
  projectRemote(projectId: string, signal: AbortSignal): Promise<string | null>;
  spawn(request: SpawnRequest, signal: AbortSignal): Promise<{ threadId: string }>;
  findSpawned(signal: AbortSignal): Promise<SpawnedThread[]>;
  clearQueueAndStop(threadId: string, signal: AbortSignal): Promise<void>;
  taskOutcome(threadId: string, signal: AbortSignal): Promise<TaskOutcome | null>;
  queuedWaits(threadId: string, signal: AbortSignal): Promise<QueuedWait[]>;
}

export interface QueuedWait {
  readonly retry: boolean;
  readonly waitingOn: { readonly kind: string; readonly pluginId?: string } | null;
}

export type WaitingReason = "owner" | "limit" | "machine";

export function waitingReasonOf(
  thread: { hasPendingInteraction: boolean },
  waits: readonly QueuedWait[],
): WaitingReason | null {
  if (thread.hasPendingInteraction) return "owner";
  if (waits.some((wait) => wait.retry)) return "limit";
  if (
    waits.some(
      (wait) =>
        wait.waitingOn?.kind === "host-offline" ||
        (wait.waitingOn?.kind === "plugin" && wait.waitingOn.pluginId === "concurrency-limit"),
    )
  ) {
    return "machine";
  }
  return null;
}

export type TaskOutcomeKind = "done" | "question" | "failed" | "stopped";

export interface TaskOutcome {
  readonly kind: TaskOutcomeKind;
  readonly key: string;
  readonly text: string | null;
}

export const RESULT_TEXT_LIMIT = 600;

export function outcomeFromTurn(status: unknown): TaskOutcomeKind | null {
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "stopped";
  return null;
}

export interface SpawnRequest {
  readonly projectId: string;
  readonly providerId: string;
  readonly model: string;
  readonly prompt: string;
  readonly title: string;
  readonly label: { readonly nonce: string };
}

export class DefiniteSpawnFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DefiniteSpawnFailure";
  }
}
