import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  appearanceSchema,
  chatDefaultsSchema,
  type Appearance,
  type BotDetail,
  type BotSummary,
  type Actor,
  type BotEvent,
  type BotThread,
  type ChatDefaults,
  type CreateBotInput,
  type UpdateBotInput,
} from "./contract.js";
import { randomAppearance } from "./appearance.js";
import { avatarDataUrl } from "./avatar.js";
import { BotsError } from "./errors.js";

export const MIGRATIONS = [
  `CREATE TABLE bots (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    appearance TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    memory TEXT NOT NULL DEFAULT '',
    capabilities TEXT NOT NULL DEFAULT '[]',
    defaults TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    reach TEXT,
    position REAL NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    legacy_id TEXT UNIQUE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE bot_threads (
    thread_id TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    position REAL NOT NULL,
    started_from_bot INTEGER NOT NULL,
    completed_at INTEGER,
    bound_at INTEGER NOT NULL
  );
  CREATE INDEX bot_threads_by_bot ON bot_threads(bot_id, position);
  CREATE TABLE chains (
    id TEXT PRIMARY KEY,
    letters INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE thread_chains (
    thread_id TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL REFERENCES chains(id)
  );
  CREATE TABLE letters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id TEXT NOT NULL REFERENCES chains(id),
    from_bot TEXT NOT NULL,
    from_thread TEXT NOT NULL,
    to_bot TEXT NOT NULL,
    to_thread TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  );
  CREATE INDEX letters_by_sender ON letters(from_bot, sent_at);
  CREATE TABLE bot_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    bot_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    actor_id TEXT,
    detail TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX bot_events_by_bot ON bot_events(bot_id, id);
  CREATE TABLE pending_starts (
    token TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
];

interface BotRow {
  id: string;
  name: string;
  role: string;
  appearance: string;
  instructions: string;
  memory: string;
  capabilities: string;
  defaults: string | null;
  hidden: number;
  reach: string | null;
  position: number;
  revision: number;
}

interface ThreadRow {
  thread_id: string;
  bot_id: string;
  position: number;
  started_from_bot: number;
  completed_at: number | null;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toThread(row: ThreadRow): BotThread {
  return {
    threadId: row.thread_id,
    startedFromBot: row.started_from_bot === 1,
    completed: row.completed_at !== null,
  };
}

function parseDefaults(raw: string | null): ChatDefaults | null {
  if (raw === null) return null;
  const parsed = chatDefaultsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export class BotStore {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number = Date.now,
  ) {}

  private row(botId: string): BotRow | undefined {
    return this.db.prepare<[string], BotRow>("SELECT * FROM bots WHERE id = ?").get(botId);
  }

  private requireRow(botId: string): BotRow {
    const row = this.row(botId);
    if (!row) throw new BotsError("not_found", `No bot with id ${botId}`);
    return row;
  }

  private threadsOf(botId: string): BotThread[] {
    return this.db
      .prepare<[string], ThreadRow>(
        "SELECT * FROM bot_threads WHERE bot_id = ? ORDER BY position, bound_at",
      )
      .all(botId)
      .map(toThread);
  }

  private summary(row: BotRow): BotSummary {
    const appearance = appearanceSchema.parse(JSON.parse(row.appearance));
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      appearance,
      avatar: avatarDataUrl(appearance),
      capabilities: JSON.parse(row.capabilities) as string[],
      hidden: row.hidden === 1,
      reach: row.reach === null ? null : (JSON.parse(row.reach) as string[]),
      threads: this.threadsOf(row.id),
    };
  }

  private detail(row: BotRow): BotDetail {
    return {
      ...this.summary(row),
      instructions: row.instructions,
      memory: row.memory,
      memorySha256: sha256(row.memory),
      defaults: parseDefaults(row.defaults),
      revision: row.revision,
    };
  }

  list(): BotSummary[] {
    return this.db
      .prepare<[], BotRow>("SELECT * FROM bots ORDER BY position, created_at")
      .all()
      .map((row) => this.summary(row));
  }

  get(botId: string): BotDetail {
    return this.detail(this.requireRow(botId));
  }

  find(botId: string): BotDetail | null {
    const row = this.row(botId);
    return row ? this.detail(row) : null;
  }

  create(input: CreateBotInput, appearance: Appearance = randomAppearance()): BotDetail {
    const id = `bot_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = this.now();
    const last = this.db
      .prepare<[], { p: number | null }>("SELECT MAX(position) AS p FROM bots")
      .get();
    this.db
      .prepare(
        `INSERT INTO bots (id, name, role, appearance, instructions, capabilities, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.role ?? "",
        JSON.stringify(input.appearance ?? appearance),
        input.instructions ?? "",
        JSON.stringify(input.capabilities ?? []),
        (last?.p ?? -1) + 1,
        now,
        now,
      );
    return this.get(id);
  }

  update(input: UpdateBotInput): BotDetail {
    return this.db.transaction(() => {
      const row = this.requireRow(input.botId);
      if (row.revision !== input.expectedRevision) {
        throw new BotsError(
          "conflict",
          `The bot changed since revision ${input.expectedRevision}; read it again`,
        );
      }
      const next: BotRow = {
        ...row,
        name: input.name ?? row.name,
        role: input.role ?? row.role,
        appearance: input.appearance ? JSON.stringify(input.appearance) : row.appearance,
        capabilities: input.capabilities
          ? JSON.stringify([...new Set(input.capabilities)])
          : row.capabilities,
        instructions: input.instructions ?? row.instructions,
        memory: input.memory ?? row.memory,
        hidden: input.hidden === undefined ? row.hidden : Number(input.hidden),
        reach:
          input.reach === undefined
            ? row.reach
            : input.reach === null
              ? null
              : JSON.stringify([...new Set(input.reach)].filter((id) => id !== row.id)),
        defaults: input.clearDefaults ? null : row.defaults,
      };
      this.db
        .prepare(
          `UPDATE bots SET name = ?, role = ?, appearance = ?, capabilities = ?, instructions = ?,
             memory = ?, hidden = ?, reach = ?, defaults = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.name,
          next.role,
          next.appearance,
          next.capabilities,
          next.instructions,
          next.memory,
          next.hidden,
          next.reach,
          next.defaults,
          this.now(),
          row.id,
        );
      return this.get(row.id);
    })();
  }

  writeMemory(botId: string, content: string, expectedSha256: string): BotDetail {
    return this.db.transaction(() => {
      const row = this.requireRow(botId);
      if (sha256(row.memory) !== expectedSha256) {
        throw new BotsError(
          "conflict",
          "Memory changed since it was read; read it again and merge",
        );
      }
      this.db
        .prepare("UPDATE bots SET memory = ?, revision = revision + 1, updated_at = ? WHERE id = ?")
        .run(content, this.now(), botId);
      return this.get(botId);
    })();
  }

  saveDefaults(botId: string, defaults: ChatDefaults): void {
    this.db
      .prepare("UPDATE bots SET defaults = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(defaults), this.now(), botId);
  }

  remove(botId: string): void {
    this.requireRow(botId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM bot_threads WHERE bot_id = ?").run(botId);
      this.db.prepare("DELETE FROM bots WHERE id = ?").run(botId);
    })();
  }

  reorderBots(botIds: readonly string[]): void {
    this.db.transaction(() => {
      botIds.forEach((id, index) => {
        this.requireRow(id);
        this.db.prepare("UPDATE bots SET position = ? WHERE id = ?").run(index, id);
      });
    })();
  }

  botOfThread(threadId: string): string | null {
    const row = this.db
      .prepare<[string], { bot_id: string }>("SELECT bot_id FROM bot_threads WHERE thread_id = ?")
      .get(threadId);
    return row?.bot_id ?? null;
  }

  threadInfo(threadId: string): BotThread | null {
    const row = this.db
      .prepare<[string], ThreadRow>("SELECT * FROM bot_threads WHERE thread_id = ?")
      .get(threadId);
    return row ? toThread(row) : null;
  }

  firstThread(botId: string): string | null {
    return this.threadsOf(botId)[0]?.threadId ?? null;
  }

  bind(
    threadId: string,
    botId: string,
    options: { startedFromBot: boolean; place: "first" | "after-first" | "last" },
  ): void {
    this.db.transaction(() => {
      this.requireRow(botId);
      this.db.prepare("DELETE FROM bot_threads WHERE thread_id = ?").run(threadId);
      const positions = this.db
        .prepare<[string], { position: number }>(
          "SELECT position FROM bot_threads WHERE bot_id = ? ORDER BY position, bound_at",
        )
        .all(botId)
        .map((row) => row.position);
      const position = placeAt(positions, options.place);
      this.db
        .prepare(
          `INSERT INTO bot_threads (thread_id, bot_id, position, started_from_bot, completed_at, bound_at)
           VALUES (?, ?, ?, ?, NULL, ?)`,
        )
        .run(threadId, botId, position, Number(options.startedFromBot), this.now());
    })();
  }

  unbind(threadId: string): void {
    this.db.prepare("DELETE FROM bot_threads WHERE thread_id = ?").run(threadId);
  }

  reorderThreads(botId: string, threadIds: readonly string[]): void {
    this.db.transaction(() => {
      this.requireRow(botId);
      threadIds.forEach((threadId, index) => {
        if (this.botOfThread(threadId) !== botId) {
          throw new BotsError("invalid", `Thread ${threadId} does not belong to this bot`);
        }
        this.db
          .prepare("UPDATE bot_threads SET position = ? WHERE thread_id = ?")
          .run(index, threadId);
      });
    })();
  }

  setCompleted(threadId: string, completed: boolean): boolean {
    const result = this.db
      .prepare(
        completed
          ? "UPDATE bot_threads SET completed_at = ? WHERE thread_id = ? AND completed_at IS NULL"
          : "UPDATE bot_threads SET completed_at = NULL WHERE thread_id = ? AND completed_at IS NOT NULL",
      )
      .run(...(completed ? [this.now(), threadId] : [threadId]));
    return result.changes > 0;
  }

  idleCandidates(): Array<{ threadId: string; botId: string; isFirst: boolean }> {
    const rows = this.db
      .prepare<[], ThreadRow>(
        "SELECT * FROM bot_threads WHERE completed_at IS NULL ORDER BY bot_id, position, bound_at",
      )
      .all();
    const seen = new Set<string>();
    return rows.map((row) => {
      const isFirst = !seen.has(row.bot_id) && this.firstThread(row.bot_id) === row.thread_id;
      seen.add(row.bot_id);
      return { threadId: row.thread_id, botId: row.bot_id, isFirst };
    });
  }

  canReach(fromBotId: string, toBotId: string): boolean {
    const reach = this.requireRow(fromBotId).reach;
    return reach === null || (JSON.parse(reach) as string[]).includes(toBotId);
  }

  record(event: {
    botId: string;
    kind: string;
    actor: Actor;
    detail?: Record<string, unknown>;
  }): void {
    this.db
      .prepare(
        "INSERT INTO bot_events (at, bot_id, kind, actor_kind, actor_id, detail) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.now(),
        event.botId,
        event.kind,
        event.actor.kind,
        event.actor.id,
        JSON.stringify(event.detail ?? {}),
      );
  }

  events(botId: string, limit: number): BotEvent[] {
    return this.db
      .prepare<
        [string, number],
        {
          id: number;
          at: number;
          kind: string;
          actor_kind: Actor["kind"];
          actor_id: string | null;
          detail: string;
        }
      >(
        "SELECT id, at, kind, actor_kind, actor_id, detail FROM bot_events WHERE bot_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(botId, limit)
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        actor: { kind: row.actor_kind, id: row.actor_id },
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      }));
  }

  addPendingStart(botId: string): string {
    this.requireRow(botId);
    const token = randomUUID();
    this.db
      .prepare("INSERT INTO pending_starts (token, bot_id, created_at) VALUES (?, ?, ?)")
      .run(token, botId, this.now());
    return token;
  }

  dropPendingStart(token: string): void {
    this.db.prepare("DELETE FROM pending_starts WHERE token = ?").run(token);
  }

  // Binds a thread created by startThread or continueInBot the first time it is seen.
  claimPendingStart(threadId: string, token: string): string | null {
    return this.transaction(() => {
      const pending = this.db
        .prepare<[string], { bot_id: string }>("SELECT bot_id FROM pending_starts WHERE token = ?")
        .get(token);
      if (!pending || !this.row(pending.bot_id)) return null;
      this.dropPendingStart(token);
      if (this.botOfThread(threadId) === null) {
        this.bind(threadId, pending.bot_id, { startedFromBot: true, place: "after-first" });
      }
      return this.botOfThread(threadId);
    });
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  get database(): Database.Database {
    return this.db;
  }
}

function placeAt(positions: readonly number[], place: "first" | "after-first" | "last"): number {
  if (positions.length === 0) return 0;
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;
  if (place === "first") return first - 1;
  if (place === "last") return last + 1;
  const second = positions[1];
  return second === undefined ? first + 1 : (first + second) / 2;
}
