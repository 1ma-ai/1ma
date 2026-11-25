import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { judgeMainMove, parseJournal } from "./journal.js";

const sample = readFileSync(
  new URL("./fixtures/train-journal-sample.jsonl", import.meta.url),
  "utf8",
);
const lines = sample.trimEnd().split("\n");
const REPO = "owner/repo-a";
const sha = (n: number) => n.toString(16).padStart(40, "0");
const OTHER = "e".repeat(40);

const rollbackAttempt = lines.filter((line) => line.includes('"token":"attempt-b"'));
const without = (outcome: string) =>
  rollbackAttempt.filter((line) => !line.includes(`"outcome":"${outcome}"`));

describe("train journal from the real sample", () => {
  it("reads outcome, token, base and the full final_sha, and skips lines without author, repo or token", () => {
    const records = parseJournal(sample);
    expect(records.map((record) => `${record.token}:${record.outcome}`)).toEqual([
      "attempt-a:started",
      "attempt-a:snapshot",
      "attempt-a:actions-verification",
      "attempt-a:final-gate-passed",
      "attempt-a:push-intent",
      "attempt-a:merged",
      "attempt-a:deployed",
      "attempt-b:started",
      "attempt-b:snapshot",
      "attempt-b:final-gate-passed",
      "attempt-b:push-intent",
      "attempt-b:merged",
      "attempt-b:failed",
      "attempt-b:rollback-started",
      "attempt-b:rolled-back",
      "attempt-b:owner-attention",
      "attempt-b:owner-attention",
      "attempt-b:scope-complete-hold-restored",
      "attempt-c:started",
      "attempt-c:failed",
    ]);
    const pick = (token: string, outcome: string) =>
      records.find((record) => record.token === token && record.outcome === outcome);
    expect(pick("attempt-a", "push-intent")).toEqual({
      repo: REPO,
      token: "attempt-a",
      outcome: "push-intent",
      finalSha: sha(3),
      base: sha(2),
    });
    expect(pick("attempt-a", "merged")).toEqual({
      repo: REPO,
      token: "attempt-a",
      outcome: "merged",
      finalSha: sha(3),
      base: null,
    });
    expect(pick("attempt-c", "failed")?.finalSha).toBeNull();
    expect(pick("attempt-c", "started")?.finalSha).toBeNull();
  });

  it("explains a train move by joining push-intent and merged on repo, token and full final_sha", () => {
    const records = parseJournal(sample);
    expect(judgeMainMove(records, REPO, sha(2), sha(3), false)).toEqual({ kind: "explained" });
    expect(judgeMainMove(records, REPO, sha(0xc), sha(0xd), false)).toEqual({
      kind: "explained",
    });
    expect(judgeMainMove(records, "owner/repo-b", sha(2), sha(3), false).kind).toBe("unexplained");
  });

  it("does not take a push-intent of another token or a shortened final_sha as the base", () => {
    const merged = lines.find(
      (line) => line.includes('"token":"attempt-a"') && line.includes('"outcome":"merged"'),
    );
    const intent = lines.find(
      (line) => line.includes('"token":"attempt-a"') && line.includes('"outcome":"push-intent"'),
    );
    if (merged === undefined || intent === undefined) throw new Error("sample changed");
    const otherToken = parseJournal(
      [intent.replace('"token":"attempt-a"', '"token":"attempt-x"'), merged].join("\n"),
    );
    expect(judgeMainMove(otherToken, REPO, sha(2), sha(3), false).kind).toBe("needs_reconcile");
    const shortened = parseJournal(
      [intent, merged]
        .map((line) =>
          line.replaceAll(`"final_sha":"${sha(3)}"`, `"final_sha":"${sha(3).slice(-12)}"`),
        )
        .join("\n"),
    );
    expect(judgeMainMove(shortened, REPO, sha(2), sha(3), false).kind).toBe("unexplained");
  });

  it("asks about the move away from a rolled-back final_sha to a head no record names", () => {
    const records = parseJournal(rollbackAttempt.join("\n"));
    expect(judgeMainMove(records, REPO, sha(0xd), OTHER, false)).toEqual({
      kind: "rollback",
      attempt: "attempt-b",
    });
    expect(judgeMainMove(records, REPO, sha(0xc), OTHER, false).kind).toBe("unexplained");
  });

  it("needs a reconcile while a rollback has only started or ended incomplete", () => {
    const started = parseJournal(without("rolled-back").join("\n"));
    expect(judgeMainMove(started, REPO, sha(0xd), OTHER, false)).toEqual({
      kind: "needs_reconcile",
      detail: "the rollback of attempt attempt-b started and has not finished",
    });
    const incomplete = parseJournal(
      without("rolled-back")
        .concat(
          JSON.stringify({
            at: "2026-10-31T08:06:37.325672+00:00",
            author: "release-train",
            failures: ["…"],
            final_sha: sha(0xd),
            outcome: "rollback-incomplete",
            repo: REPO,
            token: "attempt-b",
          }),
        )
        .join("\n"),
    );
    expect(judgeMainMove(incomplete, REPO, sha(0xd), OTHER, false)).toEqual({
      kind: "needs_reconcile",
      detail: "the rollback of attempt attempt-b is incomplete",
    });
  });

  it("never matches a null or absent final_sha", () => {
    const records = parseJournal(
      lines.filter((line) => line.includes('"token":"attempt-c"')).join("\n"),
    );
    expect(records.every((record) => record.finalSha === null)).toBe(true);
    expect(judgeMainMove(records, REPO, sha(0x15), OTHER, false).kind).toBe("unexplained");
  });

  it("needs a reconcile for a missing record only when the tail is incomplete", () => {
    const records = parseJournal(lines.slice(-3).join("\n"));
    expect(judgeMainMove(records, REPO, sha(2), sha(3), true)).toEqual({
      kind: "needs_reconcile",
      detail: "the journal tail is incomplete: no train record ends at the new head",
    });
    expect(judgeMainMove(parseJournal(sample), REPO, sha(2), sha(3), true)).toEqual({
      kind: "explained",
    });
  });
});
