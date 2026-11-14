import type Database from "better-sqlite3";
import { strings } from "../strings.js";
import { describeError } from "./executors/paging.js";
import type { GitHubReader } from "./github/reader.js";
import { judgeMainHead, parseJournal } from "./journal.js";
import type { QuestionStore } from "./questions.js";
import type { RepoPolicy } from "./repos.js";

export const BYPASS_KIND = "main_bypass";

export type ReadJournal = (
  path: string,
  signal: AbortSignal,
) => Promise<
  { status: "ok"; text: string; truncated: boolean } | { status: "error"; message: string }
>;

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
  readonly journalPath: string | null;
  readonly policy: RepoPolicy;
  readonly questions: QuestionStore;
  readonly now: number;
  readonly signal: AbortSignal;
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

export async function runMainWatch(deps: MainWatchDeps): Promise<string[]> {
  if (deps.journalPath === null || deps.policy.connected.size === 0) return [];
  const problems: string[] = [];
  const journal = await deps.readJournal(deps.journalPath, deps.signal);
  if (journal.status === "error") return [`train journal: ${journal.message}`];
  const records = parseJournal(journal.text);
  const previous = new Map(mainWatchRows(deps.db).map((row) => [row.repo, row]));
  const save = deps.db.prepare(
    `INSERT INTO main_watch (repo, last_head, state, detail, checked_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (repo) DO UPDATE SET last_head = excluded.last_head, state = excluded.state,
       detail = excluded.detail, checked_at = excluded.checked_at`,
  );
  await Promise.all(
    [...deps.policy.connected.keys()].map(async (repo) => {
      let head: string;
      try {
        head = await deps.github.mainHead(repo, deps.signal);
      } catch (error) {
        problems.push(`${repo} main: ${describeError(error)}`);
        return;
      }
      const before = previous.get(repo);
      if (before === undefined) {
        save.run(repo, head, "ok", "first observation", deps.now);
        return;
      }
      if (before.lastHead === head) return;
      const verdict = judgeMainHead(records, repo, head);
      if (verdict.kind === "explained") {
        save.run(repo, head, "ok", null, deps.now);
      } else if (verdict.kind === "needs_reconcile") {
        save.run(repo, head, "needs_reconcile", verdict.detail, deps.now);
      } else {
        save.run(repo, head, "bypass", null, deps.now);
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
    }),
  );
  return problems;
}
