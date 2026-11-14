import { strings } from "../../strings.js";
import type { PrLinkRow, PrStore } from "../pr-store.js";
import type { Card, QuestionKind, QuestionStore } from "../questions.js";
import type { RepoPolicy } from "../repos.js";

export const UNLINKED_KIND = "unlinked_pr";
export const UNLINKED_GRACE_MS = 10 * 60 * 1000;
const LEAVE = "leave";

function subject(link: PrLinkRow): string {
  return `${link.repo}#${link.number}`;
}

function version(link: PrLinkRow): string {
  return `${link.headSha}|${link.linkKind ?? "none"}|${link.deliveryServerId ?? ""}:${link.deliveryThreadId ?? ""}|${link.branchHint ?? ""}`;
}

function parseSubject(value: string): { repo: string; number: number } | null {
  const match = /^(.+)#(\d+)$/.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  return { repo: match[1], number: Number.parseInt(match[2], 10) };
}

function chatOption(index: number): string {
  return `link${index}`;
}

function candidates(link: PrLinkRow): string[] {
  return (link.branchHint === null ? [] : link.branchHint.split(",")).slice(0, 2);
}

export function unlinkedCard(link: PrLinkRow): Card {
  const pr = subject(link);
  const chats = candidates(link);
  const linkOptions = chats.map((chat, index) => ({
    id: chatOption(index),
    label: strings.unlinkedLink(chat),
    recommended: chats.length === 1,
  }));
  const leave = { id: LEAVE, label: strings.unlinkedLeave, recommended: chats.length !== 1 };
  return {
    title: strings.unlinkedTitle(pr),
    observed: strings.unlinkedObserved(pr, link.author ?? "?", link.headRef, link.claimProblem),
    affected: strings.unlinkedAffected,
    recommendation:
      chats.length === 1 && chats[0] !== undefined
        ? strings.unlinkedRecommendLink(chats[0])
        : strings.unlinkedRecommendLeave,
    options: chats.length === 1 ? [...linkOptions, leave] : [leave, ...linkOptions],
  };
}

export function askAboutUnlinked(
  prStore: PrStore,
  questions: QuestionStore,
  policy: RepoPolicy,
  now: number,
): void {
  for (const link of prStore.all()) {
    const key = `${UNLINKED_KIND}:${subject(link)}`;
    const ours = [...policy.connected.values()].some(
      (repo) =>
        repo.repo === link.repo &&
        link.author !== null &&
        [...repo.accounts.mac, ...repo.accounts.linux].includes(link.author),
    );
    const unlinked =
      link.prState === "open" && link.deliveryThreadId === null && link.unlinkedSince !== null;
    if (!unlinked || !ours) {
      questions.cancel(key);
      continue;
    }
    if (now - (link.unlinkedSince ?? now) < UNLINKED_GRACE_MS) continue;
    const latest = questions.latest(key);
    if (latest !== null && (latest.state === "answered" || latest.state === "canceled")) continue;
    if (latest !== null && (latest.state === "queued" || latest.state === "open")) continue;
    questions.ask(
      {
        key,
        kind: UNLINKED_KIND,
        subject: subject(link),
        expectedVersion: version(link),
        card: unlinkedCard(link),
        priority: 10,
      },
      now,
    );
  }
}

export function unlinkedKind(prStore: PrStore): QuestionKind {
  return {
    currentVersion(value) {
      const ref = parseSubject(value);
      const link = ref === null ? null : prStore.get(ref.repo, ref.number);
      return link === null ? null : version(link);
    },
    onAnswer(question, optionId) {
      if (optionId === LEAVE) return;
      const ref = parseSubject(question.subject);
      const link = ref === null ? null : prStore.get(ref.repo, ref.number);
      if (ref === null || link === null) return;
      const index = Number.parseInt(optionId.replace("link", ""), 10);
      const chat = candidates(link)[index];
      const match = chat === undefined ? null : /^(mac|linux):(thr_[a-z0-9]+)$/.exec(chat);
      if (match?.[1] !== "mac" && match?.[1] !== "linux") return;
      if (match[2] === undefined) return;
      prStore.setManualLink(ref.repo, ref.number, match[1], match[2]);
    },
  };
}
