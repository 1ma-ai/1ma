import { z } from "zod";

const recordSchema = z
  .object({
    author: z.string(),
    repo: z.string(),
    token: z.string().min(1),
    outcome: z.string(),
    final_sha: z.string().nullable().optional(),
    base: z.string().nullable().optional(),
  })
  .loose();

export interface TrainRecord {
  readonly repo: string;
  readonly token: string;
  readonly outcome: string;
  readonly finalSha: string | null;
  readonly base: string | null;
}

function fullSha(value: string | null | undefined): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

export function parseJournal(text: string): TrainRecord[] {
  const records: TrainRecord[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = recordSchema.safeParse(json);
    if (!parsed.success) continue;
    records.push({
      repo: parsed.data.repo.toLowerCase(),
      token: parsed.data.token,
      outcome: parsed.data.outcome,
      finalSha: fullSha(parsed.data.final_sha),
      base: fullSha(parsed.data.base),
    });
  }
  return records;
}

export const MAX_CHAIN = 20;

export type MainVerdict =
  | { kind: "explained" }
  | { kind: "needs_reconcile"; detail: string }
  | { kind: "rollback"; attempt: string }
  | { kind: "unexplained"; detail: string };

export function judgeMainMove(
  records: readonly TrainRecord[],
  repo: string,
  previous: string,
  head: string,
  truncated: boolean,
): MainVerdict {
  const ofRepo = records.filter((record) => record.repo === repo);
  const at = (sha: string, outcome: string) => {
    const wanted = sha.toLowerCase();
    return ofRepo.findLast((record) => record.outcome === outcome && record.finalSha === wanted);
  };
  const intentBase = (merge: TrainRecord) =>
    ofRepo.findLast(
      (record) =>
        record.outcome === "push-intent" &&
        record.token === merge.token &&
        record.finalSha === merge.finalSha &&
        record.base !== null,
    )?.base ?? null;
  const missing = (detail: string): MainVerdict =>
    truncated
      ? { kind: "needs_reconcile", detail: `the journal tail is incomplete: ${detail}` }
      : { kind: "unexplained", detail };

  if (at(head, "merged") === undefined) {
    const rolledBack = at(previous, "rolled-back");
    if (rolledBack !== undefined) return { kind: "rollback", attempt: rolledBack.token };
    const incomplete = at(previous, "rollback-incomplete");
    if (incomplete !== undefined)
      return {
        kind: "needs_reconcile",
        detail: `the rollback of attempt ${incomplete.token} is incomplete`,
      };
    const started = at(previous, "rollback-started");
    if (started !== undefined)
      return {
        kind: "needs_reconcile",
        detail: `the rollback of attempt ${started.token} started and has not finished`,
      };
    const intent = at(head, "push-intent");
    if (intent !== undefined)
      return {
        kind: "needs_reconcile",
        detail: `push-intent of attempt ${intent.token} without merged`,
      };
    return missing("no train record ends at the new head");
  }

  let cursor = head.toLowerCase();
  const from = previous.toLowerCase();
  for (let step = 0; step < MAX_CHAIN; step += 1) {
    if (cursor === from) return { kind: "explained" };
    const merge = at(cursor, "merged");
    if (merge === undefined)
      return missing(`a train was built on ${cursor.slice(0, 12)}, which no train wrote`);
    const base = intentBase(merge);
    if (base === null)
      return {
        kind: "needs_reconcile",
        detail: `no push-intent of attempt ${merge.token} with the same final_sha carries a base`,
      };
    cursor = base;
  }
  return { kind: "needs_reconcile", detail: `more than ${MAX_CHAIN} trains since the last check` };
}
