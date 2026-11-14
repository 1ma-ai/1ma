import { z } from "zod";
import type {
  EnvironmentSummary,
  Executor,
  ObservationResult,
  ProjectSummary,
  ServerId,
  ServerSnapshot,
  ThreadSummary,
} from "../observation.js";
import { type PagingLimits, DEFAULT_LIMITS, collectOnce, collectPages } from "./paging.js";
import { combineSnapshot, toThreadSummary } from "./snapshot.js";

const threadSchema = z.object({
  id: z.string().regex(/^thr_/),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  title: z.string().nullable(),
  titleFallback: z.string().nullable(),
  providerId: z.string(),
  status: z.string(),
  visibility: z.enum(["visible", "hidden"]),
  parentThreadId: z.string().nullable(),
  originPluginId: z.string().nullable(),
  updatedAt: z.number(),
});

const environmentSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  branchName: z.string().nullable(),
});

const projectSchema = z.object({
  id: z.string(),
  gitRemoteUrl: z.string().nullable(),
});

export class RemoteHttpError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "RemoteHttpError";
    this.status = status;
  }
}

export type Fetch = (
  input: string,
  init: { signal: AbortSignal; headers: Record<string, string> },
) => Promise<Response>;

export interface RemoteHttpOptions {
  readonly serverId: ServerId;
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  readonly limits?: PagingLimits;
  readonly now?: () => number;
}

export function createRemoteHttpExecutor(options: RemoteHttpOptions): Executor {
  const fetchImpl: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const limits = options.limits ?? DEFAULT_LIMITS;
  const now = options.now ?? Date.now;
  const base = options.baseUrl.replace(/\/$/, "");

  async function getJson<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const response = await fetchImpl(`${base}/api/v1${path}`, {
      signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      throw new RemoteHttpError(`GET ${path} answered ${response.status}`, response.status);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RemoteHttpError(
        `GET ${path} returned an unexpected shape at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`,
        response.status,
      );
    }
    return parsed.data;
  }

  return {
    serverId: options.serverId,
    async snapshot(signal): Promise<ObservationResult<ServerSnapshot>> {
      const observedAt = now();
      const [threads, environments, projects] = await Promise.all([
        collectPages<ThreadSummary>(
          async (offset, limit, pageSignal) =>
            (
              await getJson(
                `/threads?archived=false&includeHidden=true&limit=${limit}&offset=${offset}`,
                z.array(threadSchema),
                pageSignal,
              )
            ).map(toThreadSummary),
          limits,
          signal,
        ),
        collectPages<EnvironmentSummary>(
          async (offset, limit, pageSignal) =>
            (
              await getJson(
                `/environments?limit=${limit}&offset=${offset}`,
                z.array(environmentSchema),
                pageSignal,
              )
            ).map((env) => ({
              environmentId: env.id,
              projectId: env.projectId,
              branch: env.branchName,
            })),
          limits,
          signal,
        ),
        collectOnce<ProjectSummary>(
          async (pageSignal) =>
            (await getJson("/projects", z.array(projectSchema), pageSignal)).map((project) => ({
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
