import type Database from "better-sqlite3";
import type { PullRequest } from "./github/reader.js";
import type { ServerId } from "./observation.js";

export interface PrLinkRow {
  repo: string;
  number: number;
  headRepo: string | null;
  headRef: string;
  headSha: string;
  author: string | null;
  prState: "open" | "closed" | "merged";
  prUpdatedAt: number;
  deliveryServerId: ServerId | null;
  deliveryThreadId: string | null;
  linkKind: "claim" | "manual" | null;
  claimProblem: string | null;
  branchHint: string | null;
  provenanceGap: boolean;
  unlinkedSince: number | null;
  observedAt: number;
}

interface RawLink {
  repo: string;
  number: number;
  head_repo: string | null;
  head_ref: string;
  head_sha: string;
  author: string | null;
  pr_state: string;
  pr_updated_at: number;
  delivery_server_id: string | null;
  delivery_thread_id: string | null;
  link_kind: string | null;
  claim_problem: string | null;
  branch_hint: string | null;
  provenance_gap: number;
  unlinked_since: number | null;
  observed_at: number;
}

export interface ProvenanceRow {
  providerId: string;
  model: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

function toLink(raw: RawLink): PrLinkRow {
  const state = raw.pr_state === "merged" || raw.pr_state === "closed" ? raw.pr_state : "open";
  const server =
    raw.delivery_server_id === "mac" || raw.delivery_server_id === "linux"
      ? raw.delivery_server_id
      : null;
  const kind = raw.link_kind === "claim" || raw.link_kind === "manual" ? raw.link_kind : null;
  return {
    repo: raw.repo,
    number: raw.number,
    headRepo: raw.head_repo,
    headRef: raw.head_ref,
    headSha: raw.head_sha,
    author: raw.author,
    prState: state,
    prUpdatedAt: raw.pr_updated_at,
    deliveryServerId: server,
    deliveryThreadId: raw.delivery_thread_id,
    linkKind: kind,
    claimProblem: raw.claim_problem,
    branchHint: raw.branch_hint,
    provenanceGap: raw.provenance_gap === 1,
    unlinkedSince: raw.unlinked_since,
    observedAt: raw.observed_at,
  };
}

export type LinkDecision =
  | { kind: "claim"; serverId: ServerId; threadId: string }
  | { kind: "none"; problem: string | null };

export class PrStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  cursor(repo: string): number | null {
    const row = this.#db
      .prepare(`SELECT pulls_seen_until FROM repo_cursors WHERE repo = ?`)
      .get(repo) as { pulls_seen_until: number } | undefined;
    return row?.pulls_seen_until ?? null;
  }

  setCursor(repo: string, value: number): void {
    this.#db
      .prepare(
        `INSERT INTO repo_cursors (repo, pulls_seen_until) VALUES (?, ?)
         ON CONFLICT (repo) DO UPDATE SET pulls_seen_until = excluded.pulls_seen_until`,
      )
      .run(repo, value);
  }

  toReread(repo: string, closedWithinMs: number, now: number): number[] {
    const rows = this.#db
      .prepare(
        `SELECT number FROM pr_links WHERE repo = ? AND (pr_state = 'open' OR pr_updated_at >= ?)`,
      )
      .all(repo, now - closedWithinMs) as Array<{ number: number }>;
    return rows.map((row) => row.number);
  }

  get(repo: string, number: number): PrLinkRow | null {
    const raw = this.#db
      .prepare(`SELECT * FROM pr_links WHERE repo = ? AND number = ?`)
      .get(repo, number) as RawLink | undefined;
    return raw === undefined ? null : toLink(raw);
  }

  forThread(serverId: ServerId, threadId: string): PrLinkRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM pr_links WHERE delivery_server_id = ? AND delivery_thread_id = ? ORDER BY repo, number`,
      )
      .all(serverId, threadId) as RawLink[];
    return rows.map(toLink);
  }

  all(): PrLinkRow[] {
    return (
      this.#db.prepare(`SELECT * FROM pr_links ORDER BY pr_updated_at DESC`).all() as RawLink[]
    ).map(toLink);
  }

  record(pull: PullRequest, decision: LinkDecision, branchHint: string | null, now: number): void {
    const current = this.get(pull.repo, pull.number);
    const manual = current?.linkKind === "manual";
    const delivery =
      manual || decision.kind !== "claim"
        ? {
            server: manual ? current.deliveryServerId : null,
            thread: manual ? current.deliveryThreadId : null,
          }
        : { server: decision.serverId, thread: decision.threadId };
    this.#db
      .prepare(
        `INSERT INTO pr_links (repo, number, head_repo, head_ref, head_sha, author, pr_state, pr_updated_at,
           delivery_server_id, delivery_thread_id, link_kind, claim_problem, claim_checked_at, branch_hint,
           observed_at, unlinked_since)
         VALUES (@repo, @number, @headRepo, @headRef, @headSha, @author, @state, @updatedAt, @server, @thread,
           @kind, @problem, @now, @hint, @now, CASE WHEN @thread IS NULL THEN @now ELSE NULL END)
         ON CONFLICT (repo, number) DO UPDATE SET
           head_repo = @headRepo, head_ref = @headRef, head_sha = @headSha, author = @author,
           pr_state = @state, pr_updated_at = @updatedAt, delivery_server_id = @server,
           delivery_thread_id = @thread, link_kind = @kind, claim_problem = @problem,
           claim_checked_at = @now, branch_hint = @hint, observed_at = @now,
           unlinked_since = CASE WHEN @thread IS NULL THEN COALESCE(pr_links.unlinked_since, @now) ELSE NULL END`,
      )
      .run({
        repo: pull.repo,
        number: pull.number,
        headRepo: pull.headRepo,
        headRef: pull.headRef,
        headSha: pull.headSha,
        author: pull.author,
        state: pull.state,
        updatedAt: pull.updatedAt,
        server: delivery.server,
        thread: delivery.thread,
        kind: manual ? "manual" : decision.kind === "claim" ? "claim" : null,
        problem: decision.kind === "none" ? decision.problem : null,
        hint: branchHint,
        now,
      });
  }

  setManualLink(repo: string, number: number, serverId: ServerId, threadId: string): boolean {
    const changes = this.#db
      .prepare(
        `UPDATE pr_links SET link_kind = 'manual', delivery_server_id = ?, delivery_thread_id = ?,
           claim_problem = NULL, unlinked_since = NULL WHERE repo = ? AND number = ?`,
      )
      .run(serverId, threadId, repo, number).changes;
    if (changes === 1) {
      this.#db.prepare(`DELETE FROM pr_provenance WHERE repo = ? AND number = ?`).run(repo, number);
    }
    return changes === 1;
  }

  observeProvenance(
    repo: string,
    number: number,
    providerId: string,
    model: string,
    now: number,
  ): void {
    this.#db
      .prepare(
        `INSERT INTO pr_provenance (repo, number, provider_id, model, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, number, provider_id, model) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      )
      .run(repo, number, providerId, model, now, now);
  }

  markProvenanceGap(repo: string, number: number): void {
    this.#db
      .prepare(`UPDATE pr_links SET provenance_gap = 1 WHERE repo = ? AND number = ?`)
      .run(repo, number);
  }

  provenance(repo: string, number: number): ProvenanceRow[] {
    const rows = this.#db
      .prepare(
        `SELECT provider_id, model, first_seen_at, last_seen_at FROM pr_provenance
         WHERE repo = ? AND number = ? ORDER BY first_seen_at`,
      )
      .all(repo, number) as Array<{
      provider_id: string;
      model: string;
      first_seen_at: number;
      last_seen_at: number;
    }>;
    return rows.map((row) => ({
      providerId: row.provider_id,
      model: row.model,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
  }
}
