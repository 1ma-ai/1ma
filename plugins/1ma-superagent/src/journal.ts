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
  })
  .loose();

export interface TrainRecord {
  readonly repo: string;
  readonly attempt: string;
  readonly event: string;
  readonly finalSha: string | null;
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
    });
  }
  return records;
}

export type MainVerdict =
  | { kind: "explained" }
  | { kind: "needs_reconcile"; detail: string }
  | { kind: "unexplained" };

export function judgeMainHead(
  records: readonly TrainRecord[],
  repo: string,
  head: string,
): MainVerdict {
  const ofRepo = records.filter((record) => record.repo === repo);
  const matches = (record: TrainRecord) =>
    record.finalSha !== null && head.startsWith(record.finalSha.slice(0, 40));
  const merged = ofRepo.filter((record) => record.event === "merged" && matches(record));
  const latest = ofRepo.at(-1);
  if (latest?.event === "rolled-back") {
    return {
      kind: "needs_reconcile",
      detail: `main moved after a rollback of attempt ${latest.attempt}`,
    };
  }
  if (merged.length > 0) return { kind: "explained" };
  const intent = ofRepo.find((record) => record.event === "push-intent" && matches(record));
  if (intent !== undefined) {
    return {
      kind: "needs_reconcile",
      detail: `push-intent of attempt ${intent.attempt} without merged`,
    };
  }
  return { kind: "unexplained" };
}
