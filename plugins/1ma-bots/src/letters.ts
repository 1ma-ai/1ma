import { randomUUID } from "node:crypto";
import { BotsError } from "./errors.js";
import { HOUR_MS } from "./limits.js";
import type { BotStore } from "./store.js";

export interface LetterLimits {
  chainLetters: number;
  hourlyLetters: number;
}

export interface LetterRoute {
  chainId: string;
  token: string;
  letterNumber: number;
  fromBotId: string;
  toBotId: string;
  toThreadId: string;
}

export function resolveBot(store: BotStore, reference: string): string {
  const byId = store.find(reference);
  if (byId) return byId.id;
  const named = store.idsNamed(reference);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new BotsError("invalid", `Several bots are named ${reference}; use the bot id`);
  }
  throw new BotsError("not_found", `No bot ${reference}; find it with bot_find`);
}

// One transaction: the limit check and the count it guards cannot interleave.
export function routeLetter(
  store: BotStore,
  args: {
    fromThreadId: string;
    to: string;
    toThreadId: string | null;
    now: number;
    /** The owner's request that started the sender's current turn, if it was the owner's. */
    ownerTurn: number | null;
  },
  limits: LetterLimits,
): LetterRoute {
  return store.transaction(() => {
    const { database: db, owner } = store;
    const fromBotId = store.botOfThread(args.fromThreadId);
    if (fromBotId === null) {
      throw new BotsError("forbidden", "Only a bot's conversation can write to another bot");
    }
    const toBotId = resolveBot(store, args.to);
    if (toBotId === fromBotId) throw new BotsError("invalid", "A bot does not write to itself");
    if (!store.canReach(fromBotId, toBotId)) {
      throw new BotsError(
        "forbidden",
        "This bot may not write to that bot. The owner chooses whom a bot may write to on its page.",
      );
    }
    const { toThreadId } = args;
    if (toThreadId === null) {
      throw new BotsError("not_found", "The recipient bot has no conversation yet");
    }
    if (store.botOfThread(toThreadId) !== toBotId) {
      throw new BotsError("invalid", "That conversation does not belong to the recipient bot");
    }

    const sentLastHour = db
      .prepare<[string, string, number], { n: number }>(
        "SELECT COUNT(*) AS n FROM letters WHERE owner_id = ? AND from_bot = ? AND sent_at > ?",
      )
      .get(owner, fromBotId, args.now - HOUR_MS)!.n;
    if (sentLastHour >= limits.hourlyLetters) {
      throw new BotsError(
        "forbidden",
        `This bot already sent ${sentLastHour} letters in the last hour. Ask the owner before writing again.`,
      );
    }

    // A conversation the owner wrote in carries its own exchange; one that
    // never had one joins the recipient's, so a fresh conversation cannot
    // restart an exchange that ran out.
    if (args.ownerTurn !== null)
      startOwnerExchange(store, args.fromThreadId, args.now, args.ownerTurn);
    const current = chainOf(store, args.fromThreadId) ?? chainOf(store, toThreadId);
    if (current && current.letters >= limits.chainLetters) {
      throw new BotsError(
        "forbidden",
        `This exchange between bots reached its limit of ${limits.chainLetters} letters. Stop and ask the owner how to continue.`,
      );
    }
    const chainId = current?.id ?? `chain_${randomUUID()}`;
    if (current) {
      db.prepare("UPDATE chains SET letters = letters + 1 WHERE owner_id = ? AND id = ?").run(
        owner,
        chainId,
      );
    } else {
      db.prepare("INSERT INTO chains (owner_id, id, letters, created_at) VALUES (?, ?, 1, ?)").run(
        owner,
        chainId,
        args.now,
      );
    }
    setChain(store, args.fromThreadId, chainId);
    db.prepare(
      `INSERT INTO letters (owner_id, chain_id, from_bot, from_thread, to_bot, to_thread, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(owner, chainId, fromBotId, args.fromThreadId, toBotId, toThreadId, args.now);
    // The recipient joins this exchange only when the letter is accepted
    // into a turn (acceptDelivery), not while it waits in the queue.
    const token = randomUUID();
    db.prepare(
      "INSERT INTO pending_letters (owner_id, token, chain_id, to_thread, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(owner, token, chainId, toThreadId, args.now);
    return {
      chainId,
      token,
      letterNumber: (current?.letters ?? 0) + 1,
      fromBotId,
      toBotId,
      toThreadId,
    };
  });
}

interface Chain {
  id: string;
  letters: number;
}

function chainOf(store: BotStore, threadId: string): Chain | undefined {
  return store.database
    .prepare<[string, string], Chain>(
      `SELECT chains.id, chains.letters FROM thread_chains
       JOIN chains ON chains.id = thread_chains.chain_id
       WHERE thread_chains.owner_id = ? AND thread_chains.thread_id = ?`,
    )
    .get(store.owner, threadId);
}

function setChain(store: BotStore, threadId: string, chainId: string): void {
  store.database
    .prepare(
      `INSERT INTO thread_chains (owner_id, thread_id, chain_id) VALUES (?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET chain_id = excluded.chain_id`,
    )
    .run(store.owner, threadId, chainId);
}

const LETTER_TOKEN = /<<<letter ([0-9a-f-]{36})\b/gu;

export function letterTokens(texts: readonly string[]): string[] {
  return texts.flatMap((text) => [...text.matchAll(LETTER_TOKEN)].map((match) => match[1]!));
}

// A turn that takes up letters belongs to the longest of their exchanges;
// one that joins a running turn also keeps the turn's own exchange.
export function acceptDelivery(
  store: BotStore,
  threadId: string,
  tokens: readonly string[],
  joinsRunningTurn: boolean,
): boolean {
  if (tokens.length === 0) return false;
  return store.transaction(() => {
    const { database: db, owner } = store;
    const chains: Chain[] = [];
    for (const token of tokens) {
      const pending = db
        .prepare<[string, string, string], { chain_id: string }>(
          "SELECT chain_id FROM pending_letters WHERE owner_id = ? AND token = ? AND to_thread = ?",
        )
        .get(owner, token, threadId);
      if (!pending) continue;
      db.prepare("DELETE FROM pending_letters WHERE owner_id = ? AND token = ?").run(owner, token);
      const chain = db
        .prepare<[string, string], Chain>(
          "SELECT id, letters FROM chains WHERE owner_id = ? AND id = ?",
        )
        .get(owner, pending.chain_id);
      if (chain) chains.push(chain);
    }
    if (chains.length === 0) return false;
    if (joinsRunningTurn) {
      const running = chainOf(store, threadId);
      if (running) chains.push(running);
    }
    const longest = chains.reduce((a, b) => (b.letters > a.letters ? b : a));
    setChain(store, threadId, longest.id);
    return true;
  });
}

// A turn the owner started gives its conversation one new, empty exchange,
// the first time that conversation writes a letter during it. The anchor is
// the owner's request as bb recorded it, so a held or rejected message, which
// bb never records, changes nothing.
export function startOwnerExchange(
  store: BotStore,
  threadId: string,
  now: number,
  ownerTurn: number,
): void {
  store.transaction(() => {
    const { database: db, owner } = store;
    const anchored = db
      .prepare<[string, string], { owner_turn: number | null }>(
        "SELECT owner_turn FROM thread_chains WHERE owner_id = ? AND thread_id = ?",
      )
      .get(owner, threadId);
    if (anchored?.owner_turn === ownerTurn) return;
    const chainId = `chain_${randomUUID()}`;
    db.prepare("INSERT INTO chains (owner_id, id, letters, created_at) VALUES (?, ?, 0, ?)").run(
      owner,
      chainId,
      now,
    );
    db.prepare(
      `INSERT INTO thread_chains (owner_id, thread_id, chain_id, owner_turn) VALUES (?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET chain_id = excluded.chain_id, owner_turn = excluded.owner_turn`,
    ).run(owner, threadId, chainId, ownerTurn);
  });
}
