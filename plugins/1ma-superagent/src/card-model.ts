import { strings } from "../strings.js";
import type { AnswerOutcome, CardState, QuestionPayload } from "./card.js";

export type OutdatedReason = "stale" | "expired" | "closed";

export interface CardModel {
  readonly phase: "choosing" | "deciding" | "recorded" | "outdated" | "closed";
  readonly optionId: string | null;
  readonly reason: OutdatedReason | null;
  readonly closing: boolean;
  readonly autoClose: boolean;
  readonly problem: "not-recorded" | "close-failed" | null;
  readonly waiting: number;
}

export type CardEvent =
  | { readonly type: "choose"; readonly optionId: string }
  | { readonly type: "decided"; readonly outcome: AnswerOutcome }
  | { readonly type: "decideFailed" }
  | { readonly type: "state"; readonly state: CardState }
  | { readonly type: "closeRequested" }
  | { readonly type: "closeStarted" }
  | { readonly type: "closeFailed" }
  | { readonly type: "closed" };

export type CloseRequest =
  | { readonly kind: "submit"; readonly optionId: string }
  | { readonly kind: "cancel" };

export function initialCard(waiting: number): CardModel {
  return {
    phase: "choosing",
    optionId: null,
    reason: null,
    closing: false,
    autoClose: false,
    problem: null,
    waiting,
  };
}

function recorded(model: CardModel, optionId: string): CardModel {
  return { ...model, phase: "recorded", optionId, reason: null, autoClose: true, problem: null };
}

function outdated(model: CardModel, reason: OutdatedReason): CardModel {
  return { ...model, phase: "outdated", reason, autoClose: false, problem: null };
}

const settled = (model: CardModel) =>
  model.phase === "recorded" || model.phase === "outdated" || model.phase === "closed";

export function reduceCard(model: CardModel, event: CardEvent): CardModel {
  switch (event.type) {
    case "choose":
      return model.phase === "choosing"
        ? { ...model, phase: "deciding", optionId: event.optionId, problem: null }
        : model;
    case "decided":
      if (model.phase !== "deciding" || model.optionId === null) return model;
      switch (event.outcome) {
        case "applied":
        case "recorded":
          return recorded(model, model.optionId);
        case "stale":
          return outdated(model, "stale");
        case "unknown":
          return outdated(model, "closed");
        case "rejected":
          return { ...model, phase: "choosing", optionId: null, problem: "not-recorded" };
      }
    case "decideFailed":
      return model.phase === "deciding"
        ? { ...model, phase: "choosing", optionId: null, problem: "not-recorded" }
        : model;
    case "state": {
      const next = { ...model, waiting: event.state.waiting };
      if (model.phase === "closed") return next;
      if (model.phase === "recorded") return { ...next, autoClose: !model.closing };
      if (event.state.decided !== null) return recorded(next, event.state.decided);
      if (model.phase === "outdated" || event.state.open) return next;
      return outdated(next, event.state.outdated ?? "closed");
    }
    case "closeRequested":
      return model.phase === "recorded" || model.phase === "outdated"
        ? { ...model, autoClose: true, problem: null }
        : model;
    case "closeStarted":
      return { ...model, closing: true, autoClose: false };
    case "closeFailed":
      return { ...model, closing: false, problem: "close-failed" };
    case "closed":
      return settled(model) ? { ...model, phase: "closed", closing: false } : model;
  }
}

export function closeRequest(model: CardModel): CloseRequest | null {
  if (model.phase === "recorded" && model.optionId !== null)
    return { kind: "submit", optionId: model.optionId };
  if (model.phase === "outdated") return { kind: "cancel" };
  return null;
}

export function shouldClose(model: CardModel): boolean {
  return model.autoClose && !model.closing && closeRequest(model) !== null;
}

export interface CardView {
  readonly options: "enabled" | "disabled" | "hidden";
  readonly notice: string | null;
  readonly problem: string | null;
  readonly closeLabel: string | null;
  readonly waiting: string | null;
}

const OUTDATED: Record<OutdatedReason, string> = {
  stale: strings.cardOutdatedStale,
  expired: strings.cardOutdatedExpired,
  closed: strings.cardOutdatedClosed,
};

export function cardView(model: CardModel, card: Pick<QuestionPayload, "options">): CardView {
  const label = card.options.find((option) => option.id === model.optionId)?.label ?? "";
  const waiting = model.waiting > 0 ? strings.moreWaiting(model.waiting) : null;
  const problem =
    model.problem === "not-recorded"
      ? strings.cardNotRecorded
      : model.problem === "close-failed"
        ? strings.cardCloseFailed
        : null;
  switch (model.phase) {
    case "choosing":
    case "deciding":
      return {
        options: model.phase === "choosing" ? "enabled" : "disabled",
        notice: null,
        problem,
        closeLabel: null,
        waiting,
      };
    case "recorded":
      return {
        options: "hidden",
        notice: strings.cardDecided(label),
        problem,
        closeLabel: model.closing ? null : strings.cardRetryClose(label),
        waiting,
      };
    case "outdated":
      return {
        options: "hidden",
        notice: OUTDATED[model.reason ?? "closed"],
        problem,
        closeLabel: model.closing ? null : strings.cardDismiss,
        waiting,
      };
    case "closed":
      return { options: "hidden", notice: null, problem: null, closeLabel: null, waiting: null };
  }
}
