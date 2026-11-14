import { strings } from "../strings.js";
import { type ActionRow, type ActionStore, labelOf, labelSchema } from "./actions.js";
import { describeError } from "./executors/paging.js";
import {
  type Completeness,
  DefiniteSpawnFailure,
  type Executor,
  type ServerId,
  type ThreadMetadataRow,
} from "./observation.js";
import type { Card, QuestionKind, QuestionStore } from "./questions.js";

export const UNKNOWN_AFTER_MS = 10 * 60 * 1000;
export const WAIT_MS = 30 * 60 * 1000;
export const LATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const START_KIND = "start_chat";
export const UNKNOWN_KIND = "unknown_spawn";
export const AMBIGUOUS_KIND = "ambiguous_spawn";
export const NOTICE_KIND = "notice";

export interface ActionDeps {
  readonly actions: ActionStore;
  readonly questions: QuestionStore;
  readonly executors: ReadonlyMap<ServerId, Executor>;
  readonly observed: ReadonlyMap<ServerId, Completeness>;
  readonly claimant: string;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly warn: (message: string) => void;
}

function chatRef(serverId: ServerId, threadId: string): string {
  return `${serverId}:${threadId}`;
}

export function startCard(action: ActionRow, projectName: string): Card {
  const server = action.serverId;
  return {
    title: strings.startTitle(server),
    observed: strings.startObserved(
      server,
      projectName,
      `${action.params.providerId}/${action.params.model}`,
    ),
    affected: strings.startAffected,
    recommendation: strings.startRecommendation,
    quote: action.params.prompt,
    options: [
      { id: "start", label: strings.startYes(server), recommended: true },
      { id: "no", label: strings.startNo, recommended: false },
    ],
  };
}

function ackCard(title: string, observed: string, affected: string, recommendation: string): Card {
  return {
    title,
    observed,
    affected,
    recommendation,
    options: [{ id: "ok", label: strings.acknowledge, recommended: true }],
  };
}

export function noticeKind(): QuestionKind {
  return { currentVersion: () => "1", onAnswer: () => {} };
}

export function startKind(actions: ActionStore): QuestionKind {
  return {
    currentVersion: (subject) => actions.get(subject)?.state ?? null,
    onAnswer(question, optionId, now) {
      if (optionId === "start")
        actions.transition(question.subject, ["proposed"], "confirmed", now);
      else
        actions.transition(question.subject, ["proposed"], "canceled", now, { result: "declined" });
    },
  };
}

export function unknownKind(actions: ActionStore): QuestionKind {
  return {
    currentVersion: (subject) => {
      const action = actions.get(subject);
      return action === null ? null : `${action.state}|${action.remindAt ?? ""}`;
    },
    onAnswer(question, optionId, now) {
      const action = actions.get(question.subject);
      if (action === null) return;
      if (optionId === "wait") {
        actions.setReminder(action.id, now + WAIT_MS, now);
        return;
      }
      const replacement = actions.propose(
        action.serverId,
        action.params,
        action.botThreadId,
        now,
        action.attempt + 1,
      );
      actions.transition(action.id, ["unknown"], "canceled", now, {
        result: "replaced",
        replacedBy: replacement.id,
      });
      actions.transition(replacement.id, ["proposed"], "confirmed", now);
    },
  };
}

export function ambiguousKind(): QuestionKind {
  return { currentVersion: () => "1", onAnswer: () => {} };
}

async function send(deps: ActionDeps, action: ActionRow): Promise<void> {
  const executor = deps.executors.get(action.serverId);
  if (executor === undefined) {
    deps.actions.transition(action.id, ["confirmed"], "failed", deps.now(), {
      result: "server not configured",
    });
    return;
  }
  if (!deps.actions.claim(action.id, deps.claimant, deps.now())) return;
  try {
    const { threadId } = await executor.spawn(
      { ...action.params, label: labelOf(action) },
      AbortSignal.any([deps.signal, AbortSignal.timeout(30_000)]),
    );
    deps.actions.transition(action.id, ["sending"], "bound", deps.now(), { threadId });
  } catch (error) {
    const definite = error instanceof DefiniteSpawnFailure;
    deps.actions.transition(action.id, ["sending"], definite ? "failed" : "unknown", deps.now(), {
      result: describeError(error),
    });
  }
}

function matching(rows: readonly ThreadMetadataRow[], action: ActionRow): string[] {
  return rows
    .filter((row) => {
      const parsed = labelSchema.safeParse(row.metadata);
      return (
        parsed.success &&
        parsed.data.spawn.actionId === action.id &&
        parsed.data.spawn.attempt === action.attempt
      );
    })
    .map((row) => row.threadId);
}

export async function runActions(deps: ActionDeps): Promise<void> {
  for (const stale of deps.actions.inStates(["sending"])) {
    if (stale.claimedBy !== deps.claimant) {
      deps.actions.transition(stale.id, ["sending"], "unknown", deps.now(), {
        result: "interrupted while sending",
      });
    }
  }
  await Promise.all(deps.actions.inStates(["confirmed"]).map((action) => send(deps, action)));

  const unknown = deps.actions.inStates(["unknown"]);
  const late = deps.actions
    .inStates(["canceled"])
    .filter(
      (action) =>
        action.sentAt !== null &&
        action.threadId === null &&
        deps.now() - action.sentAt < LATE_WINDOW_MS,
    );
  const servers = new Set([...unknown, ...late].map((action) => action.serverId));
  const spawned = new Map<ServerId, ThreadMetadataRow[]>();
  await Promise.all(
    [...servers].map(async (serverId) => {
      const executor = deps.executors.get(serverId);
      if (executor === undefined || deps.observed.get(serverId) === "failed") return;
      try {
        spawned.set(serverId, await executor.findSpawned(deps.signal));
      } catch (error) {
        deps.warn(`looking for spawned chats on ${serverId}: ${describeError(error)}`);
      }
    }),
  );

  const now = deps.now();
  for (const action of unknown) {
    const rows = spawned.get(action.serverId);
    const found = rows === undefined ? [] : matching(rows, action);
    const [only] = found;
    if (found.length === 1 && only !== undefined) {
      deps.actions.transition(action.id, ["unknown"], "bound", now, { threadId: only });
      deps.questions.cancel(`${UNKNOWN_KIND}:${action.id}`);
    } else if (found.length > 1) {
      deps.actions.transition(action.id, ["unknown"], "ambiguous", now);
      deps.questions.cancel(`${UNKNOWN_KIND}:${action.id}`);
      deps.questions.ask(
        {
          key: `${AMBIGUOUS_KIND}:${action.id}`,
          kind: AMBIGUOUS_KIND,
          subject: action.id,
          expectedVersion: "1",
          card: ackCard(
            strings.ambiguousTitle,
            strings.ambiguousObserved(
              action.serverId,
              found.map((id) => chatRef(action.serverId, id)).join(", "),
            ),
            strings.ambiguousAffected,
            strings.ambiguousRecommendation,
          ),
          priority: 30,
        },
        now,
      );
    } else if (
      action.sentAt !== null &&
      now - action.sentAt >= UNKNOWN_AFTER_MS &&
      (action.remindAt === null || action.remindAt <= now)
    ) {
      deps.questions.ask(
        {
          key: `${UNKNOWN_KIND}:${action.id}`,
          kind: UNKNOWN_KIND,
          subject: action.id,
          expectedVersion: `${action.state}|${action.remindAt ?? ""}`,
          card: {
            title: strings.unknownTitle,
            observed: strings.unknownObserved(
              action.serverId,
              Math.round((now - action.sentAt) / 60_000),
            ),
            affected: strings.unknownAffected,
            recommendation: strings.unknownRecommendation,
            options: [
              { id: "wait", label: strings.unknownWait, recommended: true },
              { id: "retry", label: strings.unknownRetry, recommended: false },
            ],
          },
          priority: 30,
        },
        now,
      );
    }
  }

  await Promise.all(
    late.map(async (action) => {
      const rows = spawned.get(action.serverId);
      const executor = deps.executors.get(action.serverId);
      if (rows === undefined || executor === undefined) return;
      const found = matching(rows, action);
      if (found.length === 0) return;
      await Promise.all(
        found.map(async (threadId) => {
          try {
            await executor.clearQueueAndStop(threadId, deps.signal);
          } catch (error) {
            deps.warn(
              `stopping late chat ${chatRef(action.serverId, threadId)}: ${describeError(error)}`,
            );
          }
        }),
      );
      const first = found[0] ?? "";
      deps.actions.transition(action.id, ["canceled"], "canceled", deps.now(), {
        threadId: first,
        result: "stopped late",
      });
      deps.questions.ask(
        {
          key: `${NOTICE_KIND}:late:${action.id}`,
          kind: NOTICE_KIND,
          subject: action.id,
          expectedVersion: "1",
          card: ackCard(
            strings.lateTitle,
            strings.lateObserved(found.map((id) => chatRef(action.serverId, id)).join(", ")),
            strings.lateAffected,
            strings.lateRecommendation,
          ),
          priority: 40,
        },
        deps.now(),
      );
    }),
  );
}
