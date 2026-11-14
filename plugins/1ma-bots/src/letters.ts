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

    const current = db
      .prepare<[string], { id: string; letters: number }>(
        `SELECT chains.id, chains.letters FROM thread_chains
         JOIN chains ON chains.id = thread_chains.chain_id WHERE thread_chains.thread_id = ?`,
      )
      .get(args.fromThreadId);
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
    const setChain = db.prepare(
      `INSERT INTO thread_chains (thread_id, chain_id) VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET chain_id = excluded.chain_id`,
    );
    setChain.run(args.fromThreadId, chainId);
    setChain.run(toThreadId, chainId);
    db.prepare(
      `INSERT INTO letters (chain_id, from_bot, from_thread, to_bot, to_thread, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(chainId, fromBotId, args.fromThreadId, toBotId, toThreadId, args.now);
    store.setCompleted(toThreadId, false);
    return {
      chainId,
      letterNumber: (current?.letters ?? 0) + 1,
      fromBotId,
      toBotId,
      toThreadId,
    };
  });
}

export function clearChain(store: BotStore, threadId: string): void {
  store.database.prepare("DELETE FROM thread_chains WHERE thread_id = ?").run(threadId);
}
