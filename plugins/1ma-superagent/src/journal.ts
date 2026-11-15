import { z } from "zod";

const recordSchema = z
  .object({
    author: z.literal("release-train"),
    repo: z.string().optional(),
    repository: z.string().optional(),
    attempt: z.union([z.string(), z.number()]).optional(),
    attempt_id: z.union([z.string(), z.number()]).optional(),
    event: z.string().optional(),
    type: z.string().optional(),
    final_sha: z.string().optional(),
    base_sha: z.string().optional(),
  })
  .loose();

export interface TrainRecord {
  readonly repo: string;
  readonly attempt: string;
  readonly event: string;
  readonly finalSha: string | null;
  readonly baseSha: string | null;
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
    const repo = (parsed.data.repo ?? parsed.data.repository)?.toLowerCase();
    const attempt = parsed.data.attempt ?? parsed.data.attempt_id;
    const event = parsed.data.event ?? parsed.data.type;
    if (repo === undefined || attempt === undefined || event === undefined) continue;
    records.push({
      repo,
      attempt: String(attempt),
      event,
      finalSha: parsed.data.final_sha ?? null,
      baseSha: parsed.data.base_sha ?? null,
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

function sameSha(left: string | null, right: string): boolean {
  if (left === null) return false;
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a));
}

export function judgeMainMove(
  records: readonly TrainRecord[],
  repo: string,
  previous: string,
  head: string,
  truncated: boolean,
): MainVerdict {
  const ofRepo = records.filter((record) => record.repo === repo);
  const lastMerge = (sha: string) =>
    ofRepo.filter((record) => record.event === "merged" && sameSha(record.finalSha, sha)).at(-1);
  const missing = (detail: string): MainVerdict =>
    truncated
      ? { kind: "needs_reconcile", detail: `the journal tail is incomplete: ${detail}` }
      : { kind: "unexplained", detail };

  if (lastMerge(head) === undefined) {
    const rollback = ofRepo
      .filter((record) => record.event === "rolled-back" && sameSha(record.finalSha, previous))
      .at(-1);
    if (rollback !== undefined) return { kind: "rollback", attempt: rollback.attempt };
    const intent = ofRepo
      .filter((record) => record.event === "push-intent" && sameSha(record.finalSha, head))
      .at(-1);
    if (intent !== undefined)
      return {
        kind: "needs_reconcile",
        detail: `push-intent of attempt ${intent.attempt} without merged`,
      };
    return missing("no train record ends at the new head");
  }

  let cursor = head;
  for (let step = 0; step < MAX_CHAIN; step += 1) {
    if (sameSha(previous, cursor)) return { kind: "explained" };
    const merge = lastMerge(cursor);
    if (merge === undefined)
      return missing(`a train was built on ${cursor.slice(0, 12)}, which no train wrote`);
    if (merge.baseSha === null)
      return {
        kind: "needs_reconcile",
        detail: `merged record of attempt ${merge.attempt} has no base`,
      };
    cursor = merge.baseSha;
  }
  return { kind: "needs_reconcile", detail: `more than ${MAX_CHAIN} trains since the last check` };
}
