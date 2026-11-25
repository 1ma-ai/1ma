import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  appearanceSchema,
  chatDefaultsSchema,
  tags,
  type Appearance,
  type BotDetail,
  type BotMember,
  type BotSummary,
  type Actor,
  type BotEvent,
  type BotThread,
  type ChatDefaults,
  type CreateBotInput,
  type UpdateBotInput,
} from "./contract.js";
import { randomAppearance } from "./appearance.js";
import { BotsError } from "./errors.js";
import { agentText } from "../strings.js";

// The only owner of an installation without sign-in; migration 5 gives it every
// row written before rows had an owner.
export const INSTALLATION_OWNER = "installation";

const OWNED_TABLES = [
  "bots",
  "bot_threads",
  "chains",
  "thread_chains",
  "letters",
  "bot_events",
  "pending_letters",
  "pending_starts",
  "thread_assignment_decisions",
];
const UNUSED_CHAIN = `NOT EXISTS (SELECT 1 FROM thread_chains WHERE chain_id = chains.id)
  AND NOT EXISTS (SELECT 1 FROM letters WHERE chain_id = chains.id)
  AND NOT EXISTS (SELECT 1 FROM pending_letters WHERE chain_id = chains.id)`;

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
  CREATE TABLE pending_letters (
    token TEXT PRIMARY KEY,
    chain_id TEXT NOT NULL REFERENCES chains(id),
    to_thread TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE pending_starts (
    token TEXT PRIMARY KEY,
    bot_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
  `ALTER TABLE thread_chains ADD COLUMN owner_turn INTEGER`,
  `CREATE TABLE thread_assignment_decisions (thread_id TEXT PRIMARY KEY);
   INSERT INTO thread_assignment_decisions SELECT thread_id FROM bot_threads;`,
  `ALTER TABLE pending_starts ADD COLUMN beside TEXT NOT NULL DEFAULT '[]'`,
  `${OWNED_TABLES.map(
    (table) =>
      `ALTER TABLE ${table} ADD COLUMN owner_id TEXT NOT NULL DEFAULT '${INSTALLATION_OWNER}';`,
  ).join("\n")}
  ALTER TABLE bots ADD COLUMN hidden_at INTEGER;
  UPDATE bots SET hidden_at = updated_at WHERE hidden = 1;
  UPDATE bot_threads SET position = ordered.place FROM (
    SELECT thread_id, ROW_NUMBER() OVER (PARTITION BY bot_id ORDER BY position, bound_at) AS place
    FROM bot_threads
  ) AS ordered WHERE ordered.thread_id = bot_threads.thread_id;
  CREATE INDEX bots_by_owner ON bots(owner_id, position);
  CREATE INDEX bots_by_name ON bots(owner_id, name);
  CREATE INDEX thread_chains_by_chain ON thread_chains(chain_id);
  CREATE INDEX letters_by_chain ON letters(chain_id);
  CREATE INDEX letters_by_recipient ON letters(to_bot);
  CREATE INDEX letters_by_time ON letters(sent_at);
  CREATE INDEX bot_events_by_time ON bot_events(at);
  CREATE INDEX pending_letters_by_chain ON pending_letters(chain_id);
  CREATE INDEX pending_letters_by_recipient ON pending_letters(to_thread);
  DELETE FROM bot_events WHERE bot_id NOT IN (SELECT id FROM bots);
  DELETE FROM letters WHERE from_bot NOT IN (SELECT id FROM bots) OR to_bot NOT IN (SELECT id FROM bots);
  DELETE FROM pending_starts WHERE bot_id NOT IN (SELECT id FROM bots);
  DELETE FROM thread_chains WHERE thread_id NOT IN (SELECT thread_id FROM bot_threads);
  DELETE FROM pending_letters WHERE to_thread NOT IN (SELECT thread_id FROM bot_threads);
  DELETE FROM chains WHERE ${UNUSED_CHAIN};`,
];

interface SummaryRow {
  id: string;
  name: string;
  role: string;
  appearance: string;
  capabilities: string;
  hidden: number;
}

interface BotRow extends SummaryRow {
  instructions: string;
  memory: string;
  defaults: string | null;
  hidden_at: number | null;
  reach: string | null;
  revision: number;
}

interface ThreadRow {
  thread_id: string;
  bot_id: string;
  position: number;
  started_from_bot: number;
  completed_at: number | null;
  bound_at: number;
}

type ThreadPlace =
  | "first"
  | "last"
  | { before: string | undefined }
  | { after: string | undefined };

export interface MoveTarget {
  threadId: string;
  placement: "before" | "after";
}

export interface MemberRow {
  threadId: string;
  botId: string;
  completedAt: number | null;
  boundAt: number;
  hiddenAt: number | null;
}

const PENDING_START_TTL_MS = 24 * 60 * 60 * 1000;
const SUMMARY_COLUMNS = "id, name, role, appearance, capabilities, hidden";

// Names of changes beside the tags: a thread came to another one, a
// conversation left its bot, though it may be back in it, and one was brought
// back, marked or not.
export const childrenOf = (threadId: string) => `children:${threadId}`;
export const leftBot = (threadId: string) => `left-bot:${threadId}`;
export const broughtBack = (threadId: string) => `brought-back:${threadId}`;

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toMember(row: ThreadRow): BotMember {
  return {
    botId: row.bot_id,
    startedFromBot: row.started_from_bot === 1,
    completed: row.completed_at !== null,
    position: row.position,
  };
}

function toSummary(row: SummaryRow): BotSummary {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    appearance: appearanceSchema.parse(JSON.parse(row.appearance)),
    capabilities: JSON.parse(row.capabilities) as string[],
    hidden: row.hidden === 1,
  };
}

function parseDefaults(raw: string | null): ChatDefaults | null {
  if (raw === null) return null;
  const parsed = chatDefaultsSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : null;
}

export class BotStore {
  private readonly watchers = new Set<string[]>();
  private readonly stale = new Set<string>();

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => number,
    readonly owner: string,
    private readonly onChange: (tags: readonly string[]) => void,
  ) {}

  // A list that grows with everything that changes, while it is watched: what
  // this store writes and what bb tells about its threads.
  watch(): string[] {
    const changes: string[] = [];
    this.watchers.add(changes);
    return changes;
  }

  unwatch(changes: string[]): void {
    this.watchers.delete(changes);
  }

  noteChange(...changed: readonly string[]): void {
    for (const changes of this.watchers) changes.push(...changed);
  }

  // Told once per outermost transaction, after it is written.
  private mark(...changed: readonly string[]): void {
    this.noteChange(...changed);
    for (const tag of changed) this.stale.add(tag);
    if (!this.db.inTransaction) this.tell();
  }

  private tell(): void {
    const changed = [...this.stale];
    this.stale.clear();
    if (changed.length > 0) this.onChange(changed);
  }

  private row(botId: string): BotRow | undefined {
    return this.db
      .prepare<[string, string], BotRow>("SELECT * FROM bots WHERE owner_id = ? AND id = ?")
      .get(this.owner, botId);
  }

  private requireRow(botId: string): BotRow {
    const row = this.row(botId);
    if (!row) throw new BotsError("not_found", `No bot with id ${botId}`);
    return row;
  }

  private detail(row: BotRow): BotDetail {
    return {
      ...toSummary(row),
      reach: row.reach === null ? null : (JSON.parse(row.reach) as string[]),
      conversations: this.db
        .prepare<[string, string], { n: number }>(
          "SELECT COUNT(*) AS n FROM bot_threads WHERE owner_id = ? AND bot_id = ?",
        )
        .get(this.owner, row.id)!.n,
      instructions: row.instructions,
      memory: row.memory,
      memorySha256: sha256(row.memory),
      defaults: parseDefaults(row.defaults),
      revision: row.revision,
    };
  }

  list(): BotSummary[] {
    return this.db
      .prepare<[string], SummaryRow>(
        `SELECT ${SUMMARY_COLUMNS} FROM bots WHERE owner_id = ? ORDER BY position, created_at`,
      )
      .all(this.owner)
      .map(toSummary);
  }

  get(botId: string): BotDetail {
    return this.detail(this.requireRow(botId));
  }

  find(botId: string): BotDetail | null {
    const row = this.row(botId);
    return row ? this.detail(row) : null;
  }

  // At most two: enough to tell one bot of this name from several.
  idsNamed(name: string): string[] {
    return this.db
      .prepare<[string, string], { id: string }>(
        "SELECT id FROM bots WHERE owner_id = ? AND name = ? LIMIT 2",
      )
      .all(this.owner, name)
      .map((row) => row.id);
  }

  // The bots this one may write to, hidden ones aside, in the sidebar's order.
  peers(bot: BotDetail, limit: number): { listed: BotSummary[]; total: number } {
    const where = `FROM bots WHERE owner_id = ? AND id <> ? AND hidden = 0
      AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))`;
    const reach = bot.reach === null ? null : JSON.stringify(bot.reach);
    const args: [string, string, string | null, string | null] = [this.owner, bot.id, reach, reach];
    return {
      listed: this.db
        .prepare<[...typeof args, number], SummaryRow>(
          `SELECT ${SUMMARY_COLUMNS} ${where} ORDER BY position, created_at LIMIT ?`,
        )
        .all(...args, limit)
        .map(toSummary),
      total: this.db
        .prepare<typeof args, { n: number }>(`SELECT COUNT(*) AS n ${where}`)
        .get(...args)!.n,
    };
  }

  conversationCounts(): Map<string, number> {
    const rows = this.db
      .prepare<[string], { bot_id: string; n: number }>(
        "SELECT bot_id, COUNT(*) AS n FROM bot_threads WHERE owner_id = ? GROUP BY bot_id",
      )
      .all(this.owner);
    return new Map(rows.map((row) => [row.bot_id, row.n]));
  }

  create(input: CreateBotInput, appearance: Appearance = randomAppearance()): BotDetail {
    const id = `bot_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const now = this.now();
    const last = this.db
      .prepare<[string], { p: number | null }>(
        "SELECT MAX(position) AS p FROM bots WHERE owner_id = ?",
      )
      .get(this.owner);
    this.db
      .prepare(
        `INSERT INTO bots (owner_id, id, name, role, appearance, instructions, capabilities, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.owner,
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
    this.mark(tags.bots);
    return this.get(id);
  }

  update(input: UpdateBotInput): BotDetail {
    return this.transaction(() => {
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
      if (next.hidden !== row.hidden) next.hidden_at = next.hidden === 1 ? this.now() : null;
      this.db
        .prepare(
          `UPDATE bots SET name = ?, role = ?, appearance = ?, capabilities = ?, instructions = ?,
             memory = ?, hidden = ?, hidden_at = ?, reach = ?, defaults = ?, revision = revision + 1,
             updated_at = ?
           WHERE owner_id = ? AND id = ?`,
        )
        .run(
          next.name,
          next.role,
          next.appearance,
          next.capabilities,
          next.instructions,
          next.memory,
          next.hidden,
          next.hidden_at,
          next.reach,
          next.defaults,
          this.now(),
          this.owner,
          row.id,
        );
      this.mark(tags.bot(row.id));
      const inList = ["name", "role", "appearance", "capabilities", "hidden"] as const;
      if (inList.some((column) => next[column] !== row[column])) this.mark(tags.bots);
      return this.get(row.id);
    });
  }

  writeMemory(botId: string, content: string, expectedSha256: string): BotDetail {
    return this.transaction(() => {
      const row = this.requireRow(botId);
      if (sha256(row.memory) !== expectedSha256) {
        throw new BotsError(
          "conflict",
          "Memory changed since it was read; read it again and merge",
        );
      }
      this.db
        .prepare(
          "UPDATE bots SET memory = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        )
        .run(content, this.now(), this.owner, botId);
      this.mark(tags.bot(botId));
      return this.get(botId);
    });
  }

  // Hiding is a sidebar choice, not an edit of the bot's content, so it needs
  // no revision; it still bumps the revision so an open editor sees it.
  setHidden(botId: string, hidden: boolean, actor: Actor): boolean {
    return this.transaction(() => {
      const row = this.requireRow(botId);
      if ((row.hidden === 1) === hidden) return false;
      const now = this.now();
      this.db
        .prepare(
          "UPDATE bots SET hidden = ?, hidden_at = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        )
        .run(Number(hidden), hidden ? now : null, now, this.owner, botId);
      this.mark(tags.bots, tags.bot(botId));
      this.record({ botId, kind: hidden ? "bot.hidden" : "bot.shown", actor });
      return true;
    });
  }

  saveDefaults(botId: string, defaults: ChatDefaults): void {
    this.db
      .prepare("UPDATE bots SET defaults = ?, updated_at = ? WHERE owner_id = ? AND id = ?")
      .run(JSON.stringify(defaults), this.now(), this.owner, botId);
    this.mark(tags.bot(botId));
  }

  // Everything kept for the bot goes with it; its conversations stay in bb.
  remove(botId: string): void {
    this.transaction(() => {
      this.requireRow(botId);
      const threads = "SELECT thread_id FROM bot_threads WHERE owner_id = ? AND bot_id = ?";
      for (const sql of [
        `DELETE FROM thread_chains WHERE owner_id = ? AND thread_id IN (${threads})`,
        `DELETE FROM pending_letters WHERE owner_id = ? AND to_thread IN (${threads})`,
      ])
        this.db.prepare(sql).run(this.owner, this.owner, botId);
      this.db
        .prepare("DELETE FROM letters WHERE owner_id = ? AND (from_bot = ? OR to_bot = ?)")
        .run(this.owner, botId, botId);
      for (const sql of [
        "DELETE FROM bot_events WHERE owner_id = ? AND bot_id = ?",
        "DELETE FROM pending_starts WHERE owner_id = ? AND bot_id = ?",
        "DELETE FROM bot_threads WHERE owner_id = ? AND bot_id = ?",
        "DELETE FROM bots WHERE owner_id = ? AND id = ?",
      ])
        this.db.prepare(sql).run(this.owner, botId);
      this.dropUnusedChains();
      this.mark(
        tags.bots,
        tags.bot(botId),
        tags.conversations(botId),
        tags.members(botId),
        tags.events(botId),
      );
    });
  }

  private dropUnusedChains(): void {
    this.db.prepare(`DELETE FROM chains WHERE owner_id = ? AND ${UNUSED_CHAIN}`).run(this.owner);
  }

  // An exchange a conversation is still in is not history: its letter limit
  // keeps counting.
  dropHistory(before: number): void {
    this.transaction(() => {
      const bots = this.db
        .prepare<[string, number], { bot_id: string }>(
          "DELETE FROM bot_events WHERE owner_id = ? AND at < ? RETURNING bot_id",
        )
        .all(this.owner, before);
      this.db
        .prepare("DELETE FROM letters WHERE owner_id = ? AND sent_at < ?")
        .run(this.owner, before);
      this.db
        .prepare("DELETE FROM pending_letters WHERE owner_id = ? AND created_at < ?")
        .run(this.owner, before);
      this.dropUnusedChains();
      this.mark(...new Set(bots.map((row) => tags.events(row.bot_id))));
    });
  }

  reorderBots(botIds: readonly string[]): void {
    this.transaction(() => {
      requireSameSet(
        botIds,
        this.db
          .prepare<[string], { id: string }>("SELECT id FROM bots WHERE owner_id = ?")
          .all(this.owner)
          .map((row) => row.id),
      );
      const write = this.db.prepare("UPDATE bots SET position = ? WHERE owner_id = ? AND id = ?");
      botIds.forEach((id, index) => write.run(index, this.owner, id));
      this.mark(tags.bots);
    });
  }

  private threadRow(threadId: string): ThreadRow | undefined {
    return this.db
      .prepare<[string, string], ThreadRow>(
        "SELECT * FROM bot_threads WHERE owner_id = ? AND thread_id = ?",
      )
      .get(this.owner, threadId);
  }

  botOfThread(threadId: string): string | null {
    return this.threadRow(threadId)?.bot_id ?? null;
  }

  boundAt(threadId: string): number | null {
    return this.threadRow(threadId)?.bound_at ?? null;
  }

  completedAt(threadId: string): number | null {
    return this.threadRow(threadId)?.completed_at ?? null;
  }

  members(threadIds: readonly string[]): Map<string, BotMember> {
    const rows = this.db
      .prepare<[string, string], ThreadRow>(
        "SELECT * FROM bot_threads WHERE owner_id = ? AND thread_id IN (SELECT value FROM json_each(?))",
      )
      .all(this.owner, JSON.stringify(threadIds));
    return new Map(rows.map((row) => [row.thread_id, toMember(row)]));
  }

  // A page of every bot's conversations, for the passes over all of them.
  memberPage(after: string, limit: number, options: { open?: true } = {}): MemberRow[] {
    return this.db
      .prepare<[string, string, number], MemberRow>(
        `SELECT thread_id AS threadId, bot_id AS botId, completed_at AS completedAt,
           bound_at AS boundAt, bots.hidden_at AS hiddenAt
         FROM bot_threads JOIN bots ON bots.id = bot_threads.bot_id
         WHERE bot_threads.owner_id = ? AND thread_id > ? ${options.open ? "AND completed_at IS NULL" : ""}
         ORDER BY thread_id LIMIT ?`,
      )
      .all(this.owner, after, limit);
  }

  threads(
    botId: string,
    page: { from: "first" | "last"; after: number | null; limit: number },
  ): { threads: BotThread[]; next: number | null } {
    const [beyond, direction] = page.from === "first" ? [">", "ASC"] : ["<", "DESC"];
    const rows = this.db
      .prepare<(string | number)[], ThreadRow>(
        `SELECT * FROM bot_threads WHERE owner_id = ? AND bot_id = ?
         ${page.after === null ? "" : `AND position ${beyond} ?`}
         ORDER BY position ${direction} LIMIT ?`,
      )
      .all(this.owner, botId, ...(page.after === null ? [] : [page.after]), page.limit + 1);
    const shown = rows.slice(0, page.limit);
    return {
      threads: shown.map((row) => {
        const { botId: _, ...thread } = toMember(row);
        return { threadId: row.thread_id, ...thread };
      }),
      next: rows.length > shown.length ? shown.at(-1)!.position : null,
    };
  }

  bind(
    threadId: string,
    botId: string,
    options: { startedFromBot: boolean; place: ThreadPlace },
  ): void {
    this.transaction(() => {
      this.requireRow(botId);
      this.unbind(threadId);
      const [position] = this.positions(botId, 1, options.place);
      this.db
        .prepare(
          `INSERT INTO bot_threads (owner_id, thread_id, bot_id, position, started_from_bot, completed_at, bound_at)
           VALUES (?, ?, ?, ?, ?, NULL, ?)`,
        )
        .run(this.owner, threadId, botId, position, Number(options.startedFromBot), this.now());
      this.mark(tags.thread(threadId), tags.conversations(botId));
    });
  }

  hasAssignmentDecision(threadId: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM thread_assignment_decisions WHERE owner_id = ? AND thread_id = ?")
        .get(this.owner, threadId) !== undefined
    );
  }

  recordAssignmentDecision(threadId: string): boolean {
    return (
      this.db
        .prepare(
          "INSERT OR IGNORE INTO thread_assignment_decisions (owner_id, thread_id) VALUES (?, ?)",
        )
        .run(this.owner, threadId).changes > 0
    );
  }

  // A continuation is top-level: it stands before the branch its source is in,
  // and that branch comes back from Done.
  bindContinuation(
    threadId: string,
    sourceThreadId: string,
    sourceBranch: readonly string[],
    startedFromBot: boolean,
  ): boolean {
    return this.transaction(() => {
      if (this.hasAssignmentDecision(threadId)) return false;
      const botId = this.botOfThread(sourceThreadId);
      if (botId === null) return false;
      this.recordAssignmentDecision(threadId);
      this.bind(threadId, botId, { startedFromBot, place: { before: sourceBranch.at(-1) } });
      this.reopen(sourceBranch);
      return true;
    });
  }

  forgetThread(threadId: string): void {
    this.transaction(() => {
      this.unbind(threadId);
      this.recordAssignmentDecision(threadId);
      this.db
        .prepare("DELETE FROM thread_chains WHERE owner_id = ? AND thread_id = ?")
        .run(this.owner, threadId);
      this.db
        .prepare("DELETE FROM pending_letters WHERE owner_id = ? AND to_thread = ?")
        .run(this.owner, threadId);
    });
  }

  // The bot the conversation was in.
  unbind(threadId: string): string | null {
    const left = this.db
      .prepare<[string, string], { bot_id: string }>(
        "DELETE FROM bot_threads WHERE owner_id = ? AND thread_id = ? RETURNING bot_id",
      )
      .get(this.owner, threadId);
    if (left === undefined) return null;
    this.noteChange(leftBot(threadId));
    this.mark(tags.thread(threadId), tags.conversations(left.bot_id));
    return left.bot_id;
  }

  // The conversations to move in their current order, when all of them and the
  // target are the bot's.
  requireMovable(botId: string, threadIds: readonly string[], target: MoveTarget): string[] {
    const members = this.members([...threadIds, target.threadId]);
    const positionOf = (threadId: string) => {
      const member = members.get(threadId);
      if (member?.botId !== botId) throw new BotsError("invalid", agentText.moveElsewhere);
      return member.position;
    };
    positionOf(target.threadId);
    if (threadIds.includes(target.threadId))
      throw new BotsError("invalid", agentText.moveElsewhere);
    return [...new Set(threadIds)]
      .map((threadId) => ({ threadId, position: positionOf(threadId) }))
      .sort((a, b) => a.position - b.position)
      .map(({ threadId }) => threadId);
  }

  moveThreads(botId: string, threadIds: readonly string[], target: MoveTarget): void {
    this.transaction(() => {
      const moved = this.requireMovable(botId, threadIds, target);
      const positions = this.positions(
        botId,
        moved.length,
        target.placement === "before" ? { before: target.threadId } : { after: target.threadId },
      );
      const write = this.db.prepare(
        "UPDATE bot_threads SET position = ? WHERE owner_id = ? AND thread_id = ?",
      );
      moved.forEach((threadId, index) => write.run(positions[index], this.owner, threadId));
      this.mark(tags.conversations(botId), ...moved.map(tags.thread));
    });
  }

  // Positions for so many conversations at a place of the bot's order. When the
  // numbers between the neighbours run out, the order is numbered anew first.
  private positions(botId: string, count: number, place: ThreadPlace): number[] {
    const free = positionsBetween(...this.neighbours(botId, place), count);
    if (free !== null) return free;
    this.db
      .prepare(
        `UPDATE bot_threads SET position = ordered.place FROM (
           SELECT thread_id, ROW_NUMBER() OVER (ORDER BY position) AS place
           FROM bot_threads WHERE owner_id = ? AND bot_id = ?
         ) AS ordered WHERE ordered.thread_id = bot_threads.thread_id`,
      )
      .run(this.owner, botId);
    this.mark(tags.members(botId));
    return positionsBetween(...this.neighbours(botId, place), count)!;
  }

  // The positions a place lies between. A conversation that left the bot
  // meanwhile holds no place: first then.
  private neighbours(botId: string, place: ThreadPlace): [number | null, number | null] {
    const nearest = (direction: "ASC" | "DESC", beyond: number | null) =>
      this.db
        .prepare<(string | number)[], { position: number }>(
          `SELECT position FROM bot_threads
           WHERE owner_id = ? AND bot_id = ?
           ${beyond === null ? "" : `AND position ${direction === "ASC" ? ">" : "<"} ?`}
           ORDER BY position ${direction} LIMIT 1`,
        )
        .get(this.owner, botId, ...(beyond === null ? [] : [beyond]))?.position ?? null;
    if (place === "last") return [nearest("DESC", null), null];
    if (place === "first") return [null, nearest("ASC", null)];
    const [threadId, after] = "after" in place ? [place.after, true] : [place.before, false];
    const beside = threadId === undefined ? undefined : this.threadRow(threadId);
    if (beside?.bot_id !== botId) return [null, nearest("ASC", null)];
    return after
      ? [beside.position, nearest("ASC", beside.position)]
      : [nearest("DESC", beside.position), beside.position];
  }

  complete(threadId: string): void {
    this.markWritten(
      threadId,
      this.db
        .prepare<[number, string, string], { bot_id: string }>(
          `UPDATE bot_threads SET completed_at = ?
           WHERE owner_id = ? AND thread_id = ? AND completed_at IS NULL RETURNING bot_id`,
        )
        .get(this.now(), this.owner, threadId),
    );
  }

  // Bringing back a conversation that is not marked counts too: whoever is
  // about to mark it must see that.
  reopen(threadIds: readonly string[]): void {
    const clear = this.db.prepare<[string, string], { bot_id: string }>(
      `UPDATE bot_threads SET completed_at = NULL
       WHERE owner_id = ? AND thread_id = ? AND completed_at IS NOT NULL RETURNING bot_id`,
    );
    this.transaction(() => {
      for (const threadId of threadIds) {
        this.noteChange(broughtBack(threadId));
        this.markWritten(threadId, clear.get(this.owner, threadId));
      }
    });
  }

  private markWritten(threadId: string, written: { bot_id: string } | undefined): void {
    if (written !== undefined) this.mark(tags.thread(threadId), tags.conversations(written.bot_id));
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
        "INSERT INTO bot_events (owner_id, at, bot_id, kind, actor_kind, actor_id, detail) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.owner,
        this.now(),
        event.botId,
        event.kind,
        event.actor.kind,
        event.actor.id,
        JSON.stringify(event.detail ?? {}),
      );
    this.mark(tags.events(event.botId));
  }

  events(botId: string, limit: number): BotEvent[] {
    return this.db
      .prepare<
        [string, string, number],
        {
          id: number;
          at: number;
          kind: string;
          actor_kind: Actor["kind"];
          actor_id: string | null;
          detail: string;
        }
      >(
        "SELECT id, at, kind, actor_kind, actor_id, detail FROM bot_events WHERE owner_id = ? AND bot_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(this.owner, botId, limit)
      .map((row) => ({
        id: row.id,
        at: row.at,
        kind: row.kind,
        actor: { kind: row.actor_kind, id: row.actor_id },
        detail: JSON.parse(row.detail) as Record<string, unknown>,
      }));
  }

  // beside: the bot's main conversation, or the branch a continuation's source is in.
  addPendingStart(botId: string, beside: readonly string[]): string {
    this.requireRow(botId);
    this.db
      .prepare("DELETE FROM pending_starts WHERE owner_id = ? AND created_at < ?")
      .run(this.owner, this.now() - PENDING_START_TTL_MS);
    const token = randomUUID();
    this.db
      .prepare(
        "INSERT INTO pending_starts (owner_id, token, bot_id, beside, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(this.owner, token, botId, JSON.stringify(beside), this.now());
    return token;
  }

  dropPendingStart(token: string): void {
    this.db
      .prepare("DELETE FROM pending_starts WHERE owner_id = ? AND token = ?")
      .run(this.owner, token);
  }

  // Binds a thread created by startThread or continueInBot the first time it is seen.
  claimPendingStart(threadId: string, token: string, sourceThreadId: string | null): string | null {
    return this.transaction(() => {
      const pending = this.db
        .prepare<[string, string], { bot_id: string; beside: string }>(
          "SELECT bot_id, beside FROM pending_starts WHERE owner_id = ? AND token = ?",
        )
        .get(this.owner, token);
      if (!pending || !this.row(pending.bot_id)) return null;
      this.dropPendingStart(token);
      if (this.botOfThread(threadId) === null) {
        const beside = JSON.parse(pending.beside) as string[];
        if (sourceThreadId !== null && this.botOfThread(sourceThreadId) === pending.bot_id) {
          this.bindContinuation(threadId, sourceThreadId, beside, true);
        } else if (this.recordAssignmentDecision(threadId)) {
          this.bind(threadId, pending.bot_id, {
            startedFromBot: true,
            place: { after: beside[0] },
          });
        }
      }
      return this.botOfThread(threadId);
    });
  }

  transaction<T>(fn: () => T): T {
    const outermost = !this.db.inTransaction;
    try {
      const result = this.db.transaction(fn)();
      if (outermost) this.tell();
      return result;
    } finally {
      if (outermost) this.stale.clear();
    }
  }

  get database(): Database.Database {
    return this.db;
  }
}

// Evenly between two positions, or beyond the one there is; null when there are
// not enough numbers between them.
function positionsBetween(low: number | null, high: number | null, count: number): number[] | null {
  const from = low ?? (high === null ? 0 : high - count - 1);
  const to = high ?? from + count + 1;
  const positions = Array.from(
    { length: count },
    (_, index) => from + ((to - from) * (index + 1)) / (count + 1),
  );
  const all = [from, ...positions, to];
  return all.every((position, index) => index === 0 || all[index - 1]! < position)
    ? positions
    : null;
}

function requireSameSet(given: readonly string[], actual: readonly string[]): void {
  const wanted = new Set(actual);
  if (
    given.length !== wanted.size ||
    new Set(given).size !== given.length ||
    !given.every((id) => wanted.has(id))
  ) {
    throw new BotsError("invalid", "Pass the complete current list in its new order");
  }
}
