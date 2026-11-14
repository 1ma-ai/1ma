import { z } from "zod";
import {
  DefiniteSpawnFailure,
  type EnvironmentSummary,
  type Executor,
  type ObservationResult,
  type ProjectSummary,
  type ServerId,
  type ServerSnapshot,
  type ThreadSummary,
  RESULT_TEXT_LIMIT,
  outcomeFromTurn,
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

const spawnedSchema = z.object({ id: z.string().regex(/^thr_/) });
const queuedSchema = z.array(z.object({ id: z.string() }));
const okSchema = z.unknown();

const interactionsSchema = z.array(z.object({ id: z.string(), status: z.string() }));
const turnEventsSchema = z.array(
  z.object({ id: z.string(), data: z.object({ status: z.unknown() }) }),
);
const outputSchema = z.object({ output: z.string().nullable() });

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
  init: { signal: AbortSignal; headers: Record<string, string>; method: string; body?: string },
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
    methodOverride?: string,
  ): Promise<T> {
    const method = methodOverride ?? (body === undefined ? "GET" : "POST");
    const response = await fetchImpl(`${base}/api/v1${path}`, {
      signal,
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
    async projectRemote(projectId, signal) {
      const project = await getJson(
        `/projects/${encodeURIComponent(projectId)}`,
        projectSchema,
        signal,
      );
      return project.gitRemoteUrl;
    },
    async spawn(request, signal) {
      try {
        const thread = await getJson("/threads", spawnedSchema, signal, {
          projectId: request.projectId,
          providerId: request.providerId,
          model: request.model,
          title: request.title,
          origin: "plugin",
          originPluginId: PLUGIN_ID,
          pluginMetadata: { spawn: { ...request.label } },
          environment: { type: "project-default" },
          input: [{ type: "text", text: request.prompt }],
        });
        return { threadId: thread.id };
      } catch (error) {
        if (
          error instanceof RemoteHttpError &&
          error.status !== null &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 408
        ) {
          throw new DefiniteSpawnFailure(error.message);
        }
        throw error;
      }
    },
    async findSpawned(signal) {
      const listed = await collectPages(
        async (offset, limit, pageSignal) =>
          getJson(
            `/threads?originPluginId=${PLUGIN_ID}&includeHidden=true&limit=${limit}&offset=${offset}`,
            z.array(threadSchema),
            pageSignal,
          ),
        limits,
        signal,
      );
      if (listed.completeness !== "complete")
        throw new Error(`spawned chats: ${listed.error ?? listed.completeness}`);
      return this.readMetadata(
        listed.items.map((thread) => thread.id),
        signal,
      );
    },
    async clearQueueAndStop(threadId, signal) {
      const id = encodeURIComponent(threadId);
      const queued = await getJson(`/threads/${id}/queued-messages`, queuedSchema, signal);
      await Promise.all(
        queued.map((message) =>
          getJson(
            `/threads/${id}/queued-messages/${encodeURIComponent(message.id)}`,
            okSchema,
            signal,
            undefined,
            "DELETE",
          ),
        ),
      );
      await getJson(`/threads/${id}/stop`, okSchema, signal, {});
    },
    async taskOutcome(threadId, signal) {
      const id = encodeURIComponent(threadId);
      const question = (
        await getJson(`/threads/${id}/interactions`, interactionsSchema, signal)
      ).find((interaction) => interaction.status === "pending");
      if (question !== undefined) return { kind: "question", key: question.id, text: null };
      const [turn] = await getJson(
        `/threads/${id}/events?types=turn/completed&order=desc&limit=1`,
        turnEventsSchema,
        signal,
      );
      if (turn === undefined) return null;
      const kind = outcomeFromTurn(turn.data.status);
      if (kind === null) return null;
      const output =
        kind === "done"
          ? (await getJson(`/threads/${id}/output`, outputSchema, signal)).output
          : null;
      return {
        kind,
        key: turn.id,
        text: output === null ? null : output.slice(0, RESULT_TEXT_LIMIT),
      };
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
