import type Database from "better-sqlite3";
import { strings } from "../strings.js";
import { describeError } from "./executors/paging.js";
import type { GitHubReader } from "./github/reader.js";
import type { JournalTail } from "./host-contract.js";
import { judgeMainMove, parseJournal } from "./journal.js";
import type { QuestionKind, QuestionStore } from "./questions.js";
import type { RepoPolicy } from "./repos.js";

export const BYPASS_KIND = "main_bypass";

export type ReadJournal = (signal: AbortSignal) => Promise<JournalTail>;

export interface MainWatchRow {
  repo: string;
  lastHead: string;
  state: "ok" | "needs_reconcile" | "bypass" | "unknown";
  detail: string | null;
  checkedAt: number;
}

export interface MainWatchDeps {
  readonly db: Database.Database;
  readonly github: GitHubReader;
  readonly readJournal: ReadJournal;
  readonly enabled: () => boolean;
  readonly policy: () => RepoPolicy;
  readonly questions: QuestionStore;
  readonly now: number;
  readonly signal: AbortSignal;
  readonly recordJournal?: (observation: JournalObservation) => Promise<void>;
}

export function mainWatchRows(db: Database.Database): MainWatchRow[] {
  const rows = db.prepare(`SELECT * FROM main_watch ORDER BY repo`).all() as Array<{
    repo: string;
    last_head: string;
    state: string;
    detail: string | null;
    checked_at: number;
  }>;
  return rows.map((row) => ({
    repo: row.repo,
    lastHead: row.last_head,
    state:
      row.state === "ok" || row.state === "needs_reconcile" || row.state === "bypass"
        ? row.state
        : "unknown",
    detail: row.detail,
    checkedAt: row.checked_at,
  }));
}

export const JOURNAL_STATE_KEY = "train-journal";

export interface JournalObservation {
  readonly at: number;
  readonly status: "ok" | "unconfigured" | "error";
  readonly problem: string | null;
}

export const ROLLBACK_KIND = "main_rollback";

function saver(db: Database.Database) {
  return db.prepare(
    `INSERT INTO main_watch (repo, last_head, state, detail, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET last_head = excluded.last_head, state = excluded.state,
       detail = excluded.detail, checked_at = excluded.checked_at`,
  );
}

export function rollbackKind(db: Database.Database): QuestionKind {
  const save = saver(db);
  const head = (subject: string) => {
    const at = subject.lastIndexOf("@");
    return at < 0 ? null : { repo: subject.slice(0, at), sha: subject.slice(at + 1) };
  };
  return {
    currentVersion(subject) {
      const target = head(subject);
      if (target === null) return null;
      return mainWatchRows(db).find((row) => row.repo === target.repo)?.lastHead ?? null;
    },
    onAnswer(question, optionId, now) {
      const target = head(question.subject);
      if (target === null) return "stale";
      if (optionId === "yes")
        save.run(target.repo, target.sha, "ok", "rollback confirmed by the owner", now);
      else
        save.run(
          target.repo,
          target.sha,
          "bypass",
          "the owner said this was not the train's rollback",
          now,
        );
    },
  };
}

export async function runMainWatch(deps: MainWatchDeps): Promise<string[]> {
  const watched = deps.policy();
  if (!deps.enabled() || watched.connected.size === 0) return [];
  const problems: string[] = [];
  const heads = new Map<string, string>();
  await Promise.all(
    [...watched.connected.keys()].map(async (repo) => {
      try {
        heads.set(repo, await deps.github.mainHead(repo, deps.signal));
      } catch (error) {
        problems.push(`${repo} main: ${describeError(error)}`);
      }
    }),
  );
  let journal: JournalTail;
  try {
    journal = await deps.readJournal(deps.signal);
  } catch (error) {
    journal = { status: "error", message: describeError(error) };
  }
  await deps.recordJournal?.({
    at: deps.now,
    status: journal.status,
    problem:
      journal.status === "error"
        ? journal.message
        : journal.status === "unconfigured"
          ? strings.mainCheckNoJournal
          : null,
  });
  if (journal.status === "unconfigured") return [...problems, strings.mainCheckNoJournal];
  if (journal.status === "error") return [...problems, `train journal: ${journal.message}`];
  if (!deps.enabled()) return problems;
  const current = deps.policy();
  const records = parseJournal(journal.text);
  const previous = new Map(mainWatchRows(deps.db).map((row) => [row.repo, row]));
  const save = saver(deps.db);
  for (const [repo, head] of heads) {
    if (!current.connected.has(repo)) continue;
    const before = previous.get(repo);
    if (before === undefined) {
      save.run(repo, head, "ok", "first observation", deps.now);
      continue;
    }
    if (before.lastHead === head) continue;
    const verdict = judgeMainMove(records, repo, before.lastHead, head, journal.truncated);
    if (verdict.kind === "explained") {
      save.run(repo, head, "ok", null, deps.now);
    } else if (verdict.kind === "needs_reconcile") {
      save.run(repo, head, "needs_reconcile", verdict.detail, deps.now);
    } else if (verdict.kind === "rollback") {
      save.run(
        repo,
        before.lastHead,
        "needs_reconcile",
        `main moved to ${head.slice(0, 12)} after attempt ${verdict.attempt} was rolled back; waiting for the owner`,
        deps.now,
      );
      deps.questions.ask(
        {
          key: `${ROLLBACK_KIND}:${repo}:${head}`,
          kind: ROLLBACK_KIND,
          subject: `${repo}@${head}`,
          expectedVersion: before.lastHead,
          card: {
            title: strings.rollbackTitle(repo),
            observed: strings.rollbackObserved(repo, before.lastHead, head, verdict.attempt),
            affected: strings.rollbackAffected,
            recommendation: strings.rollbackRecommendation,
            options: [
              { id: "yes", label: strings.rollbackYes, recommended: false },
              { id: "no", label: strings.rollbackNo, recommended: false },
            ],
          },
          priority: 50,
        },
        deps.now,
      );
    } else {
      save.run(repo, head, "bypass", verdict.detail, deps.now);
      deps.questions.ask(
        {
          key: `${BYPASS_KIND}:${repo}:${head}`,
          kind: BYPASS_KIND,
          subject: `${repo}@${head}`,
          expectedVersion: "1",
          card: {
            title: strings.bypassTitle(repo),
            observed: strings.bypassObserved(repo, head),
            affected: strings.bypassAffected,
            recommendation: strings.bypassRecommendation,
            options: [{ id: "ok", label: strings.bypassAck, recommended: true }],
          },
          priority: 50,
        },
        deps.now,
      );
    }
  }
  return problems;
}
