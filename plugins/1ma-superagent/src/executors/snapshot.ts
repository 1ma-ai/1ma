import type {
  EnvironmentSummary,
  ObservationResult,
  ProjectSummary,
  ServerSnapshot,
  ThreadSummary,
} from "../observation.js";
import type { Collected } from "./paging.js";
import { worst } from "./paging.js";

export function combineSnapshot(
  observedAt: number,
  threads: Collected<ThreadSummary>,
  environments: Collected<EnvironmentSummary>,
  projects: Collected<ProjectSummary>,
): ObservationResult<ServerSnapshot> {
  const errors = [
    threads.error === undefined ? null : `threads: ${threads.error}`,
    environments.error === undefined ? null : `environments: ${environments.error}`,
    projects.error === undefined ? null : `projects: ${projects.error}`,
  ].filter((value): value is string => value !== null);
  const completeness =
    threads.completeness === "failed"
      ? "failed"
      : worst(
          threads.completeness,
          environments.completeness === "failed" ? "partial" : environments.completeness,
          projects.completeness === "failed" ? "partial" : projects.completeness,
        );
  return {
    observedAt,
    completeness,
    items: {
      threads: threads.items,
      environments: environments.items,
      projects: projects.items,
    },
    ...(errors.length === 0 ? {} : { error: errors.join("; ") }),
  };
}

export interface ThreadFields {
  readonly id: string;
  readonly projectId: string;
  readonly environmentId: string | null;
  readonly title: string | null;
  readonly titleFallback: string | null;
  readonly providerId: string;
  readonly status: string;
  readonly visibility: "visible" | "hidden";
  readonly parentThreadId: string | null;
  readonly originPluginId: string | null;
  readonly updatedAt: number;
}

export function toThreadSummary(thread: ThreadFields): ThreadSummary {
  return {
    threadId: thread.id,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    title: thread.title ?? thread.titleFallback,
    providerId: thread.providerId,
    status: thread.status,
    hidden: thread.visibility === "hidden",
    parentThreadId: thread.parentThreadId,
    originPluginId: thread.originPluginId,
    updatedAt: thread.updatedAt,
  };
}
