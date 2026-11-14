import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { ServerId } from "./observation.js";

export const spawnParamsSchema = z
  .object({
    projectId: z.string().min(1).max(100),
    providerId: z.string().min(1).max(100),
    model: z.string().min(1).max(100),
    prompt: z.string().min(1).max(4000),
    title: z.string().min(1).max(120),
  })
  .strict();

export type SpawnParams = z.infer<typeof spawnParamsSchema>;

export type ActionState =
  | "proposed"
  | "confirmed"
  | "sending"
  | "unknown"
  | "bound"
  | "ambiguous"
  | "failed"
  | "canceled";

const STATES: readonly ActionState[] = [
  "proposed",
  "confirmed",
  "sending",
  "unknown",
  "bound",
  "ambiguous",
  "failed",
  "canceled",
];

export interface ActionRow {
  id: string;
  kind: "spawn_thread";
  params: SpawnParams;
  serverId: ServerId;
  attempt: number;
  state: ActionState;
  claimedBy: string | null;
  sentAt: number | null;
  threadId: string | null;
  result: string | null;
  remindAt: number | null;
  replacedBy: string | null;
  botThreadId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface RawAction {
  id: string;
  kind: string;
  params: string;
  server_id: string;
  attempt: number;
  state: string;
  claimed_by: string | null;
  sent_at: number | null;
  thread_id: string | null;
  result: string | null;
  remind_at: number | null;
  replaced_by: string | null;
  bot_thread_id: string | null;
  created_at: number;
  updated_at: number;
}

function toRow(raw: RawAction): ActionRow {
  const state = STATES.find((value) => value === raw.state);
  if (state === undefined || raw.kind !== "spawn_thread")
    throw new Error(`unknown action ${raw.kind}/${raw.state}`);
  const serverId = raw.server_id === "linux" ? "linux" : "mac";
  return {
    id: raw.id,
    kind: "spawn_thread",
    params: spawnParamsSchema.parse(JSON.parse(raw.params)),
    serverId,
    attempt: raw.attempt,
    state,
    claimedBy: raw.claimed_by,
    sentAt: raw.sent_at,
    threadId: raw.thread_id,
    result: raw.result,
    remindAt: raw.remind_at,
    replacedBy: raw.replaced_by,
    botThreadId: raw.bot_thread_id,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

export interface SpawnLabel {
  readonly actionId: string;
  readonly attempt: number;
}

export function labelOf(action: Pick<ActionRow, "id" | "attempt">): SpawnLabel {
  return { actionId: action.id, attempt: action.attempt };
}

export const labelSchema = z.object({
  spawn: z.object({ actionId: z.string(), attempt: z.number().int() }),
});

export class ActionStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  propose(
    serverId: ServerId,
    params: SpawnParams,
    botThreadId: string | null,
    now: number,
    attempt = 1,
  ): ActionRow {
    const id = `act_${randomUUID()}`;
    this.#db
      .prepare(
        `INSERT INTO actions (id, kind, params, server_id, attempt, state, bot_thread_id, created_at, updated_at)
         VALUES (?, 'spawn_thread', ?, ?, ?, 'proposed', ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(spawnParamsSchema.parse(params)),
        serverId,
        attempt,
        botThreadId,
        now,
        now,
      );
    const row = this.get(id);
    if (row === null) throw new Error("action vanished");
    return row;
  }

  get(id: string): ActionRow | null {
    const raw = this.#db.prepare(`SELECT * FROM actions WHERE id = ?`).get(id) as
      | RawAction
      | undefined;
    return raw === undefined ? null : toRow(raw);
  }

  inStates(states: readonly ActionState[]): ActionRow[] {
    const placeholders = states.map(() => "?").join(", ");
    const rows = this.#db
      .prepare(`SELECT * FROM actions WHERE state IN (${placeholders}) ORDER BY created_at, rowid`)
      .all(...states) as RawAction[];
    return rows.map(toRow);
  }

  recent(limit: number): ActionRow[] {
    const rows = this.#db
      .prepare(`SELECT * FROM actions ORDER BY updated_at DESC, rowid DESC LIMIT ?`)
      .all(limit) as RawAction[];
    return rows.map(toRow);
  }

  transition(
    id: string,
    from: readonly ActionState[],
    to: ActionState,
    now: number,
    fields: {
      threadId?: string;
      result?: string;
      remindAt?: number | null;
      replacedBy?: string;
    } = {},
  ): boolean {
    const placeholders = from.map(() => "?").join(", ");
    const sets = ["state = ?", "updated_at = ?"];
    const values: Array<string | number | null> = [to, now];
    if (fields.threadId !== undefined) {
      sets.push("thread_id = ?");
      values.push(fields.threadId);
    }
    if (fields.result !== undefined) {
      sets.push("result = ?");
      values.push(fields.result);
    }
    if (fields.remindAt !== undefined) {
      sets.push("remind_at = ?");
      values.push(fields.remindAt);
    }
    if (fields.replacedBy !== undefined) {
      sets.push("replaced_by = ?");
      values.push(fields.replacedBy);
    }
    return (
      this.#db
        .prepare(
          `UPDATE actions SET ${sets.join(", ")} WHERE id = ? AND state IN (${placeholders})`,
        )
        .run(...values, id, ...from).changes === 1
    );
  }

  claim(id: string, claimant: string, now: number): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE actions SET state = 'sending', claimed_by = ?, sent_at = ?, updated_at = ?
           WHERE id = ? AND state = 'confirmed'`,
        )
        .run(claimant, now, now, id).changes === 1
    );
  }

  setReminder(id: string, remindAt: number, now: number): void {
    this.#db
      .prepare(`UPDATE actions SET remind_at = ?, updated_at = ? WHERE id = ?`)
      .run(remindAt, now, id);
  }
}
