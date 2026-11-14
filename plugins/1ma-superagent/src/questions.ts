import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { type Card, cardSchema } from "./card.js";

export { answerSchema, cardSchema, questionPayloadSchema } from "./card.js";
export type { Card, QuestionPayload } from "./card.js";
export const QUESTION_RENDERER = "question";
export const QUESTION_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;

export type QuestionState = "queued" | "open" | "answered" | "stale" | "expired" | "canceled";

export interface QuestionRow {
  id: string;
  key: string;
  kind: string;
  chatThreadId: string | null;
  subject: string;
  expectedVersion: string;
  card: Card;
  priority: number;
  state: QuestionState;
  token: string | null;
  answer: string | null;
  remindAt: number | null;
  createdAt: number;
}

interface RawQuestion {
  id: string;
  key: string;
  kind: string;
  chat_thread_id: string | null;
  subject: string;
  expected_version: string;
  card: string;
  priority: number;
  state: string;
  token: string | null;
  answer: string | null;
  remind_at: number | null;
  created_at: number;
}

const STATES: readonly QuestionState[] = [
  "queued",
  "open",
  "answered",
  "stale",
  "expired",
  "canceled",
];

function toRow(raw: RawQuestion): QuestionRow {
  const state = STATES.find((value) => value === raw.state);
  if (state === undefined) throw new Error(`unknown question state ${raw.state}`);
  return {
    id: raw.id,
    key: raw.key,
    kind: raw.kind,
    chatThreadId: raw.chat_thread_id,
    subject: raw.subject,
    expectedVersion: raw.expected_version,
    card: cardSchema.parse(JSON.parse(raw.card)),
    priority: raw.priority,
    state,
    token: raw.token,
    answer: raw.answer,
    remindAt: raw.remind_at,
    createdAt: raw.created_at,
  };
}

export interface AskInput {
  readonly key: string;
  readonly kind: string;
  readonly subject: string;
  readonly expectedVersion: string;
  readonly card: Card;
  readonly priority: number;
}

export interface QuestionKind {
  currentVersion(subject: string): string | null;
  onAnswer(question: QuestionRow, optionId: string, now: number): void;
}

export type AnswerOutcome = "applied" | "stale" | "unknown" | "rejected";

export class QuestionStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  ask(input: AskInput, now: number): string | null {
    const card = cardSchema.parse(input.card);
    const id = `q_${randomUUID()}`;
    const result = this.#db
      .prepare(
        `INSERT INTO questions (id, key, kind, chat_thread_id, subject, expected_version, card, priority, state, created_at)
         VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 'queued', ?)
         ON CONFLICT DO NOTHING`,
      )
      .run(
        id,
        input.key,
        input.kind,
        input.subject,
        input.expectedVersion,
        JSON.stringify(card),
        input.priority,
        now,
      );
    return result.changes === 1 ? id : null;
  }

  live(key: string): QuestionRow | null {
    const raw = this.#db
      .prepare(`SELECT * FROM questions WHERE key = ? AND state IN ('queued', 'open')`)
      .get(key) as RawQuestion | undefined;
    return raw === undefined ? null : toRow(raw);
  }

  latest(key: string): QuestionRow | null {
    const raw = this.#db
      .prepare(`SELECT * FROM questions WHERE key = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(key) as RawQuestion | undefined;
    return raw === undefined ? null : toRow(raw);
  }

  get(id: string): QuestionRow | null {
    const raw = this.#db.prepare(`SELECT * FROM questions WHERE id = ?`).get(id) as
      | RawQuestion
      | undefined;
    return raw === undefined ? null : toRow(raw);
  }

  cancel(key: string): void {
    this.#db
      .prepare(
        `UPDATE questions SET state = 'canceled' WHERE key = ? AND state IN ('queued', 'open')`,
      )
      .run(key);
  }

  waiting(): QuestionRow[] {
    const rows = this.#db
      .prepare(
        `SELECT * FROM questions WHERE state IN ('queued', 'open') ORDER BY priority DESC, created_at, rowid`,
      )
      .all() as RawQuestion[];
    return rows.map(toRow);
  }

  next(now: number): QuestionRow | null {
    const raw = this.#db
      .prepare(
        `SELECT * FROM questions WHERE state IN ('queued', 'open') AND (remind_at IS NULL OR remind_at <= ?)
         ORDER BY CASE state WHEN 'open' THEN 0 ELSE 1 END, priority DESC, created_at, rowid LIMIT 1`,
      )
      .get(now) as RawQuestion | undefined;
    return raw === undefined ? null : toRow(raw);
  }

  markOpen(id: string, chatThreadId: string, token: string, now: number): boolean {
    return (
      this.#db
        .prepare(
          `UPDATE questions SET state = 'open', chat_thread_id = ?, token = ?, opened_at = ?
           WHERE id = ? AND state IN ('queued', 'open')`,
        )
        .run(chatThreadId, token, now, id).changes === 1
    );
  }

  requeue(id: string, token: string, remindAt: number | null): void {
    this.#db
      .prepare(
        `UPDATE questions SET state = 'queued', token = NULL, remind_at = ? WHERE id = ? AND token = ? AND state = 'open'`,
      )
      .run(remindAt, id, token);
  }

  closeAs(id: string, token: string, state: "canceled" | "expired"): void {
    this.#db
      .prepare(`UPDATE questions SET state = ? WHERE id = ? AND token = ? AND state = 'open'`)
      .run(state, id, token);
  }

  answer(
    id: string,
    token: string,
    optionId: string,
    kinds: ReadonlyMap<string, QuestionKind>,
    now: number,
  ): AnswerOutcome {
    const apply = this.#db.transaction((): AnswerOutcome => {
      const question = this.get(id);
      if (question === null || question.state !== "open" || question.token !== token)
        return "unknown";
      if (!question.card.options.some((option) => option.id === optionId)) return "rejected";
      const kind = kinds.get(question.kind);
      if (kind === undefined) return "rejected";
      if (kind.currentVersion(question.subject) !== question.expectedVersion) {
        this.#db
          .prepare(`UPDATE questions SET state = 'stale', answered_at = ? WHERE id = ?`)
          .run(now, id);
        return "stale";
      }
      this.#db
        .prepare(
          `UPDATE questions SET state = 'answered', answer = ?, answered_at = ? WHERE id = ?`,
        )
        .run(optionId, now, id);
      kind.onAnswer(question, optionId, now);
      return "applied";
    });
    return apply();
  }
}

export function newToken(): string {
  return randomUUID();
}
