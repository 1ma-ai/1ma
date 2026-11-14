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
  const byName = store.list().filter((bot) => bot.name === reference);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1) {
    throw new BotsError("invalid", `Several bots are named ${reference}; use the bot id`);
  }
  throw new BotsError("not_found", `No bot ${reference}; list bots with bb 1ma-bots list`);
}

// One transaction: the limit check and the count it guards cannot interleave.
export function routeLetter(
  store: BotStore,
  args: { fromThreadId: string; to: string; toThreadId?: string | null; now: number },
  limits: LetterLimits,
): LetterRoute {
  return store.transaction(() => {
    const db = store.database;
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
    let toThreadId: string;
    if (args.toThreadId) {
      if (store.botOfThread(args.toThreadId) !== toBotId) {
        throw new BotsError("invalid", "That conversation does not belong to the recipient bot");
      }
      toThreadId = args.toThreadId;
    } else {
      const first = store.firstThread(toBotId);
      if (first === null) {
        throw new BotsError("not_found", "The recipient bot has no conversation yet");
      }
      toThreadId = first;
    }

    const sentLastHour = db
      .prepare<[string, number], { n: number }>(
        "SELECT COUNT(*) AS n FROM letters WHERE from_bot = ? AND sent_at > ?",
      )
      .get(fromBotId, args.now - HOUR_MS)!.n;
    if (sentLastHour >= limits.hourlyLetters) {
      throw new BotsError(
        "forbidden",
        `This bot already sent ${sentLastHour} letters in the last hour. Ask the owner before writing again.`,
      );
    }

    const chainOf = db.prepare<[string], { id: string; letters: number }>(
      `SELECT chains.id, chains.letters FROM thread_chains
       JOIN chains ON chains.id = thread_chains.chain_id WHERE thread_chains.thread_id = ?`,
    );
    // A conversation the owner wrote in carries its own exchange; one that
    // never had one joins the recipient's, so a fresh conversation cannot
    // restart an exchange that ran out.
    const current = chainOf.get(args.fromThreadId) ?? chainOf.get(toThreadId);
    if (current && current.letters >= limits.chainLetters) {
      throw new BotsError(
        "forbidden",
        `This exchange between bots reached its limit of ${limits.chainLetters} letters. Stop and ask the owner how to continue.`,
      );
    }
    const chainId = current?.id ?? `chain_${randomUUID()}`;
    if (current) {
      db.prepare("UPDATE chains SET letters = letters + 1 WHERE id = ?").run(chainId);
    } else {
      db.prepare("INSERT INTO chains (id, letters, created_at) VALUES (?, 1, ?)").run(
        chainId,
        args.now,
      );
    }
    setChain(store, args.fromThreadId, chainId);
    db.prepare(
      `INSERT INTO letters (chain_id, from_bot, from_thread, to_bot, to_thread, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(chainId, fromBotId, args.fromThreadId, toBotId, toThreadId, args.now);
    // The recipient joins this exchange only when the letter is accepted
    // into a turn (acceptDelivery), not while it waits in the queue.
    const token = randomUUID();
    db.prepare(
      "INSERT INTO pending_letters (token, chain_id, to_thread, created_at) VALUES (?, ?, ?, ?)",
    ).run(token, chainId, toThreadId, args.now);
    store.setCompleted(toThreadId, false);
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

function setChain(store: BotStore, threadId: string, chainId: string): void {
  store.database
    .prepare(
      `INSERT INTO thread_chains (thread_id, chain_id) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET chain_id = excluded.chain_id`,
    )
    .run(threadId, chainId);
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
    const db = store.database;
    const chains: Array<{ id: string; letters: number }> = [];
    for (const token of tokens) {
      const pending = db
        .prepare<[string, string], { chain_id: string }>(
          "SELECT chain_id FROM pending_letters WHERE token = ? AND to_thread = ?",
        )
        .get(token, threadId);
      if (!pending) continue;
      db.prepare("DELETE FROM pending_letters WHERE token = ?").run(token);
      const chain = db
        .prepare<[string], { id: string; letters: number }>(
          "SELECT id, letters FROM chains WHERE id = ?",
        )
        .get(pending.chain_id);
      if (chain) chains.push(chain);
    }
    if (chains.length === 0) return false;
    if (joinsRunningTurn) {
      const running = db
        .prepare<[string], { id: string; letters: number }>(
          `SELECT chains.id, chains.letters FROM thread_chains
           JOIN chains ON chains.id = thread_chains.chain_id WHERE thread_chains.thread_id = ?`,
        )
        .get(threadId);
      if (running) chains.push(running);
    }
    const longest = chains.reduce((a, b) => (b.letters > a.letters ? b : a));
    setChain(store, threadId, longest.id);
    return true;
  });
}

// The owner's own message starts a new, empty exchange in that conversation.
export function startOwnerExchange(store: BotStore, threadId: string, now: number): void {
  store.transaction(() => {
    const chainId = `chain_${randomUUID()}`;
    store.database
      .prepare("INSERT INTO chains (id, letters, created_at) VALUES (?, 0, ?)")
      .run(chainId, now);
    setChain(store, threadId, chainId);
  });
}
