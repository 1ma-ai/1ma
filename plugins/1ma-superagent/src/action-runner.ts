import { strings } from "../strings.js";
import { type ActionRow, type ActionStore, labelOf, labelSchema } from "./actions.js";
import { type Guard, type PluginSettings, guardOf } from "./admission.js";
import { describeError } from "./executors/paging.js";
import { repoFromRemoteUrl } from "./github/names.js";
import {
  type Completeness,
  DefiniteSpawnFailure,
  type ServerId,
  type SpawnedThread,
  isLive,
} from "./observation.js";
import type { Card, QuestionKind, QuestionStore } from "./questions.js";
import { isExcludedRepo } from "./repos.js";

export const UNKNOWN_AFTER_MS = 10 * 60 * 1000;
export const WAIT_MS = 30 * 60 * 1000;
export const LATE_WINDOW_MS = 24 * 60 * 60 * 1000;
export const CLOCK_SKEW_MS = 2 * 60 * 1000;
export const START_KIND = "start_chat";
export const UNKNOWN_KIND = "unknown_spawn";
export const AMBIGUOUS_KIND = "ambiguous_spawn";
export const NOTICE_KIND = "notice";
export const STOPPING_LATE = "stopping late";
export const STOPPED_LATE = "stopped late";
export const RELEASED_LATE = "kept by the owner";
export const REVIVED_KIND = "revived_chat";

export interface ActionDeps {
  readonly actions: ActionStore;
  readonly questions: QuestionStore;
  readonly read: PluginSettings;
  readonly settings: () => PluginSettings;
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

export function revivedKind(actions: ActionStore): QuestionKind {
  return {
    currentVersion: (subject) => {
      const action = actions.get(subject);
      return action?.state === "canceled" && action.result !== RELEASED_LATE ? "1" : null;
    },
    onAnswer(question, optionId, now) {
      if (optionId === "keep")
        actions.transition(question.subject, ["canceled"], "canceled", now, {
          result: RELEASED_LATE,
        });
    },
  };
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

function cancelForTarget(deps: ActionDeps, action: ActionRow, reason: string): void {
  if (
    !deps.actions.transition(action.id, ["confirmed"], "canceled", deps.now(), { result: reason })
  )
    return;
  deps.questions.ask(
    {
      key: `${NOTICE_KIND}:target:${action.id}`,
      kind: NOTICE_KIND,
      subject: action.id,
      expectedVersion: "1",
      card: ackCard(
        strings.targetChangedTitle,
        strings.targetChangedObserved(action.serverId, reason),
        strings.targetChangedAffected,
        strings.targetChangedRecommendation,
      ),
      priority: 40,
    },
    deps.now(),
  );
}

async function send(deps: ActionDeps, action: ActionRow, admit: Guard): Promise<void> {
  const { read } = deps;
  const executor = read.executors.get(action.serverId);
  if (executor === undefined) {
    deps.actions.transition(action.id, ["confirmed"], "failed", deps.now(), {
      result: "server not configured",
    });
    return;
  }
  const proposed = action.params.repo ?? null;
  if (isExcludedRepo(read.policy, proposed)) {
    cancelForTarget(deps, action, strings.targetExcluded);
    return;
  }
  let repo: string | null;
  try {
    repo = repoFromRemoteUrl(await executor.projectRemote(action.params.projectId, deps.signal));
  } catch (error) {
    deps.warn(`checking the target of ${action.id}: ${describeError(error)}`);
    return;
  }
  if (deps.signal.aborted || !admit()) return;
  if (repo !== proposed) {
    cancelForTarget(deps, action, strings.targetMoved);
    return;
  }
  if (isExcludedRepo(read.policy, repo)) {
    cancelForTarget(deps, action, strings.targetExcluded);
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

function matching(rows: readonly SpawnedThread[], action: ActionRow): string[] {
  return matchingRows(rows, action).map((row) => row.threadId);
}

function matchingRows(rows: readonly SpawnedThread[], action: ActionRow): SpawnedThread[] {
  return rows.filter((row) => {
    const parsed = labelSchema.safeParse(row.metadata);
    return (
      parsed.success &&
      parsed.data.spawn.nonce === action.label &&
      row.projectId === action.params.projectId &&
      action.sentAt !== null &&
      row.createdAt >= action.sentAt - CLOCK_SKEW_MS
    );
  });
}

export async function runActions(deps: ActionDeps): Promise<void> {
  const admit = guardOf(deps.read, deps.settings);
  if (deps.signal.aborted || !admit()) return;
  for (const stale of deps.actions.inStates(["sending"])) {
    if (stale.claimedBy !== deps.claimant) {
      deps.actions.transition(stale.id, ["sending"], "unknown", deps.now(), {
        result: "interrupted while sending",
      });
    }
  }
  await Promise.all(
    deps.actions.inStates(["confirmed"]).map((action) => send(deps, action, admit)),
  );
  if (deps.signal.aborted || !admit()) return;

  const unknown = deps.actions.inStates(["unknown"]);
  const late = deps.actions
    .inStates(["canceled"])
    .filter(
      (action) =>
        action.sentAt !== null &&
        (action.result === STOPPING_LATE ||
          action.result === STOPPED_LATE ||
          (action.threadId === null && deps.now() - action.sentAt < LATE_WINDOW_MS)),
    );
  const servers = new Set([...unknown, ...late].map((action) => action.serverId));
  const spawned = new Map<ServerId, SpawnedThread[]>();
  await Promise.all(
    [...servers].map(async (serverId) => {
      const executor = deps.read.executors.get(serverId);
      if (executor === undefined || deps.observed.get(serverId) === "failed") return;
      try {
        spawned.set(serverId, await executor.findSpawned(deps.signal));
      } catch (error) {
        deps.warn(`looking for spawned chats on ${serverId}: ${describeError(error)}`);
      }
    }),
  );
  if (deps.signal.aborted || !admit()) return;

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
      const executor = deps.read.executors.get(action.serverId);
      if (rows === undefined || executor === undefined) return;
      const matching = matchingRows(rows, action);
      const first = matching[0]?.threadId;
      if (first === undefined) return;
      const live = matching.filter(isLive);
      const chats = (list: readonly SpawnedThread[]) =>
        list.map((row) => chatRef(action.serverId, row.threadId)).join(", ");
      if (live.length === 0 && action.result === STOPPED_LATE) return;
      if (live.length === 0 && action.result === STOPPING_LATE) {
        if (!admit()) return;
        deps.actions.transition(action.id, ["canceled"], "canceled", deps.now(), {
          threadId: first,
          result: STOPPED_LATE,
        });
        deps.questions.ask(
          {
            key: `${NOTICE_KIND}:late:${action.id}`,
            kind: NOTICE_KIND,
            subject: action.id,
            expectedVersion: "1",
            card: ackCard(
              strings.lateTitle,
              strings.lateObserved(chats(matching)),
              strings.lateAffected,
              strings.lateRecommendation,
            ),
            priority: 40,
          },
          deps.now(),
        );
        return;
      }
      const revived = action.result === STOPPED_LATE;
      const targets = revived || action.result === STOPPING_LATE ? live : matching;
      const requested = await Promise.all(
        targets.map(async (row) => {
          try {
            return (await executor.clearQueueAndStop(row.threadId, admit, deps.signal))
              ? true
              : null;
          } catch (error) {
            deps.warn(
              `stopping late chat ${chatRef(action.serverId, row.threadId)}: ${describeError(error)}`,
            );
            return false;
          }
        }),
      );
      if (requested.includes(null) || !admit()) return;
      deps.actions.transition(action.id, ["canceled"], "canceled", deps.now(), {
        threadId: first,
        result: STOPPING_LATE,
      });
      if (revived)
        deps.questions.ask(
          {
            key: `${REVIVED_KIND}:${action.id}`,
            kind: REVIVED_KIND,
            subject: action.id,
            expectedVersion: "1",
            card: {
              title: strings.revivedTitle,
              observed: strings.revivedObserved(chats(live)),
              affected: strings.lateAffected,
              recommendation: strings.revivedRecommendation,
              options: [
                { id: "ok", label: strings.acknowledge, recommended: true },
                { id: "keep", label: strings.revivedKeep, recommended: false },
              ],
            },
            priority: 40,
          },
          deps.now(),
        );
      if (!requested.every(Boolean))
        deps.questions.ask(
          {
            key: `${NOTICE_KIND}:stopping:${action.id}`,
            kind: NOTICE_KIND,
            subject: action.id,
            expectedVersion: "1",
            card: ackCard(
              strings.stoppingTitle,
              strings.stoppingObserved(chats(targets)),
              strings.lateAffected,
              strings.stoppingRecommendation,
            ),
            priority: 40,
          },
          deps.now(),
        );
    }),
  );
}
