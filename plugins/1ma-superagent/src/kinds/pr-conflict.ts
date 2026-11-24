import { strings } from "../../strings.js";
import type { PrLinkRow, PrStore } from "../pr-store.js";
import type { Card, QuestionKind, QuestionStore } from "../questions.js";
import type { Store } from "../store.js";
import { freshChat, parseSubject } from "./unlinked-pr.js";

export const CONFLICT_KIND = "pr_conflict";
const KEEP = "keep";
const MOVE = "move";

function subject(link: PrLinkRow): string {
  return `${link.repo}#${link.number}`;
}

function linked(link: PrLinkRow): string {
  return `${link.deliveryServerId ?? ""}:${link.deliveryThreadId ?? ""}`;
}

function version(link: PrLinkRow): string {
  return `${link.prState}|${link.linkKind ?? "none"}|${linked(link)}|${link.conflictChat ?? ""}`;
}

export function conflictCard(link: PrLinkRow, other: string): Card {
  const pr = subject(link);
  const current = linked(link);
  return {
    title: strings.conflictTitle(pr),
    observed: strings.conflictObserved(pr, current, other),
    affected: strings.conflictAffected,
    recommendation: strings.conflictRecommendation(current),
    options: [
      { id: KEEP, label: strings.conflictKeep(current), recommended: true },
      { id: MOVE, label: strings.conflictMove(other), recommended: false },
    ],
  };
}

export function askAboutConflicts(prStore: PrStore, questions: QuestionStore, now: number): void {
  for (const link of prStore.all()) {
    const key = `${CONFLICT_KIND}:${subject(link)}:${linked(link)}:${link.conflictChat ?? ""}`;
    if (link.conflictChat === null || link.linkKind !== "claim" || link.prState !== "open") {
      for (const question of questions.waiting())
        if (question.kind === CONFLICT_KIND && question.subject === subject(link))
          questions.cancel(question.key);
      continue;
    }
    if (questions.latest(key) !== null) continue;
    questions.ask(
      {
        key,
        kind: CONFLICT_KIND,
        subject: subject(link),
        expectedVersion: version(link),
        card: conflictCard(link, link.conflictChat),
        priority: 15,
      },
      now,
    );
  }
}

export function conflictKind(prStore: PrStore, store: Store): QuestionKind {
  return {
    currentVersion(value) {
      const ref = parseSubject(value);
      const link = ref === null ? null : prStore.get(ref.repo, ref.number);
      return link === null ? null : version(link);
    },
    onAnswer(question, optionId, now) {
      const ref = parseSubject(question.subject);
      const link = ref === null ? null : prStore.get(ref.repo, ref.number);
      if (ref === null || link === null) return "stale";
      if (optionId === KEEP) {
        if (link.deliveryServerId === null || link.deliveryThreadId === null) return "stale";
        prStore.setManualLink(ref.repo, ref.number, link.deliveryServerId, link.deliveryThreadId);
        return;
      }
      const chat = freshChat(store, link, link.conflictChat ?? undefined, now);
      if (chat === null) return "stale";
      prStore.setManualLink(ref.repo, ref.number, chat.serverId, chat.threadId);
    },
  };
}
