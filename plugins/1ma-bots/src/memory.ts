import { z } from "zod";
import { BotsError } from "./errors.js";
import { FACT_MAX, MEMORY_MAX } from "./limits.js";

export const memoryChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("append"), fact: z.string() }),
  z.object({ action: z.literal("forget"), fact: z.string() }),
  z.object({
    action: z.literal("overwrite"),
    content: z.string(),
    expectedSha256: z.string(),
  }),
]);
export type MemoryChange = z.infer<typeof memoryChangeSchema>;

function lines(memory: string): string[] {
  return memory.split("\n").filter((line) => line.trim() !== "");
}

function normalizeFact(fact: string): string {
  const trimmed = fact.trim().replace(/^[-*]\s+/, "");
  if (trimmed === "") throw new BotsError("invalid", "A fact must not be empty");
  if (trimmed.includes("\n")) throw new BotsError("invalid", "A fact is one line");
  if (trimmed.length > FACT_MAX) {
    throw new BotsError("invalid", `A fact is at most ${FACT_MAX} characters`);
  }
  return `- ${trimmed}`;
}

export function checkMemorySize(content: string): void {
  if (content.length > MEMORY_MAX) {
    throw new BotsError(
      "invalid",
      `Memory is limited to ${MEMORY_MAX} characters (this would be ${content.length}). Read it, condense it, then overwrite it.`,
    );
  }
}

export function appendFact(memory: string, fact: string): string {
  const line = normalizeFact(fact);
  const current = lines(memory);
  if (current.includes(line)) return memory;
  const next = [...current, line].join("\n");
  checkMemorySize(next);
  return next;
}

export function forgetFact(memory: string, fact: string): string {
  const line = normalizeFact(fact);
  const current = lines(memory);
  if (!current.includes(line)) {
    throw new BotsError("not_found", "No such fact in memory; read memory for the exact line");
  }
  return current.filter((item) => item !== line).join("\n");
}
