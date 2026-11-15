import type Database from "better-sqlite3";
import { strings } from "../strings.js";
import type { ActionStore } from "./actions.js";
import { describeError } from "./executors/paging.js";
import type { Completeness, Executor, ServerId, TaskOutcome } from "./observation.js";
import type { QuestionStore } from "./questions.js";
import type { Store } from "./store.js";

export const RESULT_KIND = "task_result";
export const REPORT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReportDeps {
  readonly db: Database.Database;
  readonly store: Store;
  readonly actions: ActionStore;
  readonly questions: QuestionStore;
  readonly executors: ReadonlyMap<ServerId, Executor>;
  readonly observed: ReadonlyMap<ServerId, Completeness>;
  readonly now: number;
  readonly signal: AbortSignal;
  readonly warn: (message: string) => void;
}

export function reportKey(actionId: string, outcome: TaskOutcome): string {
  return `${actionId}:${outcome.key}:${outcome.kind}`;
}

function record(deps: ReportDeps, actionId: string, chat: string, outcome: TaskOutcome): void {
  const key = reportKey(actionId, outcome);
  const apply = deps.db.transaction(() => {
    const inserted = deps.db
      .prepare(
        `INSERT INTO reports (key, action_id, kind, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(key, actionId, outcome.kind, deps.now).changes;
    if (inserted !== 1) return;
    const questionId = deps.questions.ask(
      {
        key: `${RESULT_KIND}:${key}`,
        kind: RESULT_KIND,
        subject: actionId,
        expectedVersion: "1",
        card: {
          title: strings.resultTitle(outcome.kind, chat),
          observed: strings.resultObserved(outcome.kind, chat),
          affected: strings.resultAffected,
          recommendation: strings.resultRecommendation(chat),
          ...(outcome.text === null || outcome.text === "" ? {} : { quote: outcome.text }),
          options: [{ id: "ok", label: strings.acknowledge, recommended: true }],
        },
        priority: 5,
      },
      deps.now,
    );
    deps.db.prepare(`UPDATE reports SET question_id = ? WHERE key = ?`).run(questionId, key);
  });
  apply();
}

export async function runReports(deps: ReportDeps): Promise<void> {
  const tasks = deps.actions
    .inStates(["bound"])
    .filter((action) => action.threadId !== null && deps.now - action.updatedAt < REPORT_WINDOW_MS);
  await Promise.all(
    tasks.map(async (action) => {
      const threadId = action.threadId;
      const executor = deps.executors.get(action.serverId);
      if (
        threadId === null ||
        executor === undefined ||
        deps.observed.get(action.serverId) === "failed"
      )
        return;
      const seen = deps.store.threadStatus(action.serverId, threadId);
      if (seen === "active") return;
      let outcome: TaskOutcome | null;
      try {
        outcome = await executor.taskOutcome(threadId, deps.signal);
      } catch (error) {
        deps.warn(`result of ${action.serverId}:${threadId}: ${describeError(error)}`);
        return;
      }
      if (outcome === null) return;
      record(deps, action.id, `${action.serverId}:${threadId}`, outcome);
    }),
  );
}
