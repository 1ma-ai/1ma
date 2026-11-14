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
import { METADATA_BATCH, chunks, combineSnapshot, toThreadSummary } from "./snapshot.js";

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

const metadataListSchema = z.object({
  threads: z.array(z.object({ threadId: z.string(), metadata: z.unknown() })),
});

const executionOptionsSchema = z.object({ model: z.string() }).nullable();

const projectSchema = z.object({
  id: z.string(),
  gitRemoteUrl: z.string().nullable(),
});

export const PLUGIN_ID = "1ma-superagent";

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

  async function getJson<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T> {
    const method = body === undefined ? "GET" : "POST";
    const response = await fetchImpl(`${base}/api/v1${path}`, {
      signal,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { method, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      throw new RemoteHttpError(`${method} ${path} answered ${response.status}`, response.status);
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new RemoteHttpError(
        `${method} ${path} returned an unexpected shape at ${issue?.path.join(".") ?? "?"}: ${issue?.message ?? ""}`,
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
    async readMetadata(threadIds, signal) {
      const rows = await Promise.all(
        chunks(threadIds, METADATA_BATCH).map(
          async (batch) =>
            (
              await getJson(
                "/threads/plugin-metadata",
                metadataListSchema,
                AbortSignal.any([signal, AbortSignal.timeout(limits.pageTimeoutMs)]),
                { pluginId: PLUGIN_ID, threadIds: batch },
              )
            ).threads,
        ),
      );
      return rows.flat();
    },
    async threadModel(threadId, signal) {
      const execution = await getJson(
        `/threads/${encodeURIComponent(threadId)}/default-execution-options`,
        executionOptionsSchema,
        AbortSignal.any([signal, AbortSignal.timeout(limits.pageTimeoutMs)]),
      );
      return execution?.model ?? null;
    },
  };
}
