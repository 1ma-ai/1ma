import type Database from "better-sqlite3";
import type { Completeness, ServerId, ServerSnapshot, ThreadSummary } from "./observation.js";

export type WorkState = "active" | "idle" | "error" | "closed";

export interface ServerRow {
  id: ServerId;
  lastSeenAt: number | null;
  lastCompleteAt: number | null;
  lastAttemptAt: number;
  completeness: Completeness;
  lastError: string | null;
}

export interface SeenThread {
  threadId: string;
  projectId: string;
  branch: string | null;
  remoteUrl: string | null;
  providerId: string;
}

export interface WorkRow {
  id: string;
  version: number;
  sourceKind: string;
  serverId: ServerId;
  threadId: string;
  state: WorkState;
  waitingReason: string | null;
  title: string | null;
  providerId: string | null;
  projectId: string | null;
  branch: string | null;
  repo: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawServer {
  id: string;
  last_seen_at: number | null;
  last_complete_at: number | null;
  last_attempt_at: number;
  completeness: string;
  last_error: string | null;
}

interface RawWork {
  id: string;
  version: number;
  source_kind: string;
  server_id: string;
  thread_id: string;
  state: string;
  waiting_reason: string | null;
  title: string | null;
  provider_id: string | null;
  project_id: string | null;
  branch: string | null;
  repo: string | null;
  created_at: number;
  updated_at: number;
}

const WORK_COLUMNS = `w.id, w.version, w.source_kind, w.server_id, w.thread_id, w.state,
  w.waiting_reason, w.created_at, w.updated_at,
  t.title, t.provider_id, t.project_id, t.branch, t.repo`;

function toServerId(value: string): ServerId {
  if (value === "mac" || value === "linux") return value;
  throw new Error(`unknown server id in the database: ${value}`);
}

function toCompleteness(value: string): Completeness {
  if (value === "complete" || value === "partial" || value === "failed") return value;
  throw new Error(`unknown completeness in the database: ${value}`);
}

function toWorkState(value: string): WorkState {
  if (value === "active" || value === "idle" || value === "error" || value === "closed") {
    return value;
  }
  throw new Error(`unknown work state in the database: ${value}`);
}

function toWork(raw: RawWork): WorkRow {
  return {
    id: raw.id,
    version: raw.version,
    sourceKind: raw.source_kind,
    serverId: toServerId(raw.server_id),
    threadId: raw.thread_id,
    state: toWorkState(raw.state),
    waitingReason: raw.waiting_reason,
    title: raw.title,
    providerId: raw.provider_id,
    projectId: raw.project_id,
    branch: raw.branch,
    repo: raw.repo,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export function workStateOf(status: string): WorkState {
  if (status === "starting" || status === "active" || status === "stopping") return "active";
  if (status === "error") return "error";
  return "idle";
}

export function isOwnerChat(thread: ThreadSummary, mainBotThreadId: string | null): boolean {
  return (
    !thread.hidden &&
    thread.parentThreadId === null &&
    thread.originPluginId === null &&
    thread.threadId !== mainBotThreadId
  );
}

export class Store {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  recordServerObservation(
    serverId: ServerId,
    observation: { observedAt: number; completeness: Completeness; error?: string },
  ): void {
    const seen = observation.completeness === "failed" ? null : observation.observedAt;
    const complete = observation.completeness === "complete" ? observation.observedAt : null;
    this.#db
      .prepare(
        `INSERT INTO servers (id, last_seen_at, last_complete_at, last_attempt_at, completeness, last_error)
         VALUES (@id, @seen, @complete, @attempt, @completeness, @error)
         ON CONFLICT (id) DO UPDATE SET
           last_seen_at = COALESCE(@seen, servers.last_seen_at),
           last_complete_at = COALESCE(@complete, servers.last_complete_at),
           last_attempt_at = @attempt,
           completeness = @completeness,
           last_error = @error`,
      )
      .run({
        id: serverId,
        seen,
        complete,
        attempt: observation.observedAt,
        completeness: observation.completeness,
        error: observation.error ?? null,
      });
  }

  applySnapshot(
    serverId: ServerId,
    snapshot: ServerSnapshot,
    observation: { observedAt: number; completeness: Completeness },
    mainBotThreadId: string | null,
  ): void {
    const environments = new Map(snapshot.environments.map((env) => [env.environmentId, env]));
    const projects = new Map(snapshot.projects.map((project) => [project.projectId, project]));
    const upsertSeen = this.#db.prepare(
      `INSERT INTO threads_seen (server_id, thread_id, project_id, environment_id, branch, repo,
         title, provider_id, status, updated_at, observed_at)
       VALUES (@server, @thread, @project, @environment, @branch, @repo, @title, @provider,
         @status, @updatedAt, @observedAt)
       ON CONFLICT (server_id, thread_id) DO UPDATE SET
         project_id = @project, environment_id = @environment, branch = @branch, repo = @repo,
         title = @title, provider_id = @provider, status = @status, updated_at = @updatedAt,
         observed_at = @observedAt`,
    );
    const selectWork = this.#db.prepare(
      `SELECT state FROM works WHERE server_id = ? AND thread_id = ?`,
    );
    const insertWork = this.#db.prepare(
      `INSERT INTO works (id, version, source_kind, source_ref, server_id, thread_id, state,
         waiting_reason, created_at, updated_at)
       VALUES (@id, 1, 'owner-chat', @sourceRef, @server, @thread, @state, NULL, @now, @now)`,
    );
    const updateWorkState = this.#db.prepare(
      `UPDATE works SET state = @state, version = version + 1, updated_at = @now
       WHERE server_id = @server AND thread_id = @thread AND state <> @state`,
    );
    const now = observation.observedAt;
    const apply = this.#db.transaction(() => {
      const listed = new Set<string>();
      for (const thread of snapshot.threads) {
        if (!isOwnerChat(thread, mainBotThreadId)) continue;
        listed.add(thread.threadId);
        const environment =
          thread.environmentId === null ? undefined : environments.get(thread.environmentId);
        const project = projects.get(thread.projectId);
        upsertSeen.run({
          server: serverId,
          thread: thread.threadId,
          project: thread.projectId,
          environment: thread.environmentId,
          branch: environment?.branch ?? null,
          repo: project?.gitRemoteUrl ?? null,
          title: thread.title,
          provider: thread.providerId,
          status: thread.status,
          updatedAt: thread.updatedAt,
          observedAt: now,
        });
        const state = workStateOf(thread.status);
        if (selectWork.get(serverId, thread.threadId) === undefined) {
          insertWork.run({
            id: `work_${serverId}_${thread.threadId}`,
            sourceRef: JSON.stringify({ serverId, threadId: thread.threadId }),
            server: serverId,
            thread: thread.threadId,
            state,
            now,
          });
        } else {
          updateWorkState.run({ state, now, server: serverId, thread: thread.threadId });
        }
      }
      if (observation.completeness !== "complete") return;
      const open = this.#db
        .prepare(`SELECT thread_id FROM works WHERE server_id = ? AND state <> 'closed'`)
        .all(serverId) as Array<{ thread_id: string }>;
      for (const row of open) {
        if (listed.has(row.thread_id)) continue;
        updateWorkState.run({ state: "closed", now, server: serverId, thread: row.thread_id });
      }
    });
    apply();
  }

  threadsSeen(serverId: ServerId): SeenThread[] {
    const rows = this.#db
      .prepare(
        `SELECT t.thread_id, t.project_id, t.branch, t.repo, t.provider_id FROM threads_seen t
         JOIN works w ON w.server_id = t.server_id AND w.thread_id = t.thread_id
         WHERE t.server_id = ? AND w.state <> 'closed'`,
      )
      .all(serverId) as Array<{
      thread_id: string;
      project_id: string;
      branch: string | null;
      repo: string | null;
      provider_id: string;
    }>;
    return rows.map((row) => ({
      threadId: row.thread_id,
      projectId: row.project_id,
      branch: row.branch,
      remoteUrl: row.repo,
      providerId: row.provider_id,
    }));
  }

  servers(): ServerRow[] {
    const rows = this.#db.prepare(`SELECT * FROM servers ORDER BY id`).all() as RawServer[];
    return rows.map((raw) => ({
      id: toServerId(raw.id),
      lastSeenAt: raw.last_seen_at,
      lastCompleteAt: raw.last_complete_at,
      lastAttemptAt: raw.last_attempt_at,
      completeness: toCompleteness(raw.completeness),
      lastError: raw.last_error,
    }));
  }

  listWorks(args: { limit: number; offset: number; includeClosed: boolean }): WorkRow[] {
    const rows = this.#db
      .prepare(
        `SELECT ${WORK_COLUMNS} FROM works w
         LEFT JOIN threads_seen t ON t.server_id = w.server_id AND t.thread_id = w.thread_id
         WHERE (@includeClosed = 1 OR w.state <> 'closed')
         ORDER BY w.updated_at DESC, w.id LIMIT @limit OFFSET @offset`,
      )
      .all({
        includeClosed: args.includeClosed ? 1 : 0,
        limit: args.limit,
        offset: args.offset,
      }) as RawWork[];
    return rows.map(toWork);
  }

  getWork(id: string): WorkRow | null {
    const raw = this.#db
      .prepare(
        `SELECT ${WORK_COLUMNS} FROM works w
         LEFT JOIN threads_seen t ON t.server_id = w.server_id AND t.thread_id = w.thread_id
         WHERE w.id = ?`,
      )
      .get(id) as RawWork | undefined;
    return raw === undefined ? null : toWork(raw);
  }

  waitingWorks(): WorkRow[] {
    const rows = this.#db
      .prepare(
        `SELECT ${WORK_COLUMNS} FROM works w
         LEFT JOIN threads_seen t ON t.server_id = w.server_id AND t.thread_id = w.thread_id
         WHERE w.waiting_reason IS NOT NULL AND w.state <> 'closed'
         ORDER BY w.updated_at DESC, w.id`,
      )
      .all() as RawWork[];
    return rows.map(toWork);
  }
}
