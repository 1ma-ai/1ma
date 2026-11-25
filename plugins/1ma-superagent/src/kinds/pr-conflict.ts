import { strings } from "../../strings.js";
import type { PrLinkRow, PrStore } from "../pr-store.js";
import type { Card, QuestionKind, QuestionStore } from "../questions.js";
import type { Store } from "../store.js";
import { freshChat, parseSubject } from "./unlinked-pr.js";

export const CONFLICT_KIND = "pr_conflict";
const KEEP = "keep";
const MOVE = "move:";
const MOVE_OPTIONS = 4;

function subject(link: PrLinkRow): string {
  return `${link.repo}#${link.number}`;
}

function linked(link: PrLinkRow): string {
  return `${link.deliveryServerId ?? ""}:${link.deliveryThreadId ?? ""}`;
}

function version(link: PrLinkRow): string {
  return `${link.prState}|${link.linkKind ?? "none"}|${linked(link)}|${link.conflictChat ?? ""}`;
}

function participants(link: PrLinkRow): string[] {
  return link.conflictChat === null ? [] : link.conflictChat.split(",");
}

export function conflictCard(link: PrLinkRow): Card {
  const pr = subject(link);
  const current = linked(link);
  const others = participants(link);
  return {
    title: strings.conflictTitle(pr),
    observed: strings.conflictObserved(pr, current, others),
    affected: strings.conflictAffected,
    recommendation: strings.conflictRecommendation(current),
    options: [
      { id: KEEP, label: strings.conflictKeep(current), recommended: true },
      ...others.slice(0, MOVE_OPTIONS).map((other, index) => ({
        id: `${MOVE}${index}`,
        label: strings.conflictMove(other),
        recommended: false,
      })),
    ],
  };
}

export function askAboutConflicts(prStore: PrStore, questions: QuestionStore, now: number): void {
  const waiting = questions.waiting().filter((question) => question.kind === CONFLICT_KIND);
  for (const link of prStore.all()) {
    const live = link.conflictChat !== null && link.linkKind === "claim" && link.prState === "open";
    const key = live
      ? `${CONFLICT_KIND}:${subject(link)}:${linked(link)}:${link.conflictChat}:${link.conflictSince ?? ""}`
      : null;
    for (const question of waiting)
      if (question.subject === subject(link) && question.key !== key)
        questions.cancel(question.key);
    if (key === null || questions.isPendingOrDecided(key)) continue;
    questions.ask(
      {
        key,
        kind: CONFLICT_KIND,
        subject: subject(link),
        expectedVersion: version(link),
        card: conflictCard(link),
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
      const index = optionId.startsWith(MOVE) ? Number(optionId.slice(MOVE.length)) : Number.NaN;
      const other = Number.isInteger(index) ? participants(link)[index] : undefined;
      if (other === undefined) return "stale";
      const chat = freshChat(store, link, other, now);
      if (chat === null) return "stale";
      prStore.setManualLink(ref.repo, ref.number, chat.serverId, chat.threadId);
    },
  };
}
