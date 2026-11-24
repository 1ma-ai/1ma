import { describe, expect, it } from "vitest";
import { strings } from "../strings.js";
import {
  type CardEvent,
  type CardModel,
  type CardView,
  cardView,
  closeRequest,
  initialCard,
  reduceCard,
  shouldClose,
} from "./card-model.js";

const card = {
  options: [
    { id: "yes", label: "Да", recommended: true },
    { id: "no", label: "Нет", recommended: false },
  ],
};

const openState = { open: true, decided: null, outdated: null, waiting: 0 } as const;

function play(start: CardModel, events: readonly CardEvent[]) {
  const views: CardView[] = [cardView(start, card)];
  let model = start;
  for (const event of events) {
    model = reduceCard(model, event);
    views.push(cardView(model, card));
  }
  return { model, views };
}

describe("question card", () => {
  it("retries the close of a recorded decision with that option and never says it was not recorded", () => {
    const recorded = play(initialCard(0), [
      { type: "choose", optionId: "no" },
      { type: "decided", outcome: "applied" },
    ]);
    expect(shouldClose(recorded.model)).toBe(true);
    expect(closeRequest(recorded.model)).toEqual({ kind: "submit", optionId: "no" });

    const failed = play(recorded.model, [{ type: "closeStarted" }, { type: "closeFailed" }]);
    expect(shouldClose(failed.model)).toBe(false);
    expect(cardView(failed.model, card)).toEqual({
      options: "hidden",
      notice: strings.cardDecided("Нет"),
      problem: strings.cardCloseFailed,
      closeLabel: strings.cardRetryClose("Нет"),
      waiting: null,
    });

    const retried = play(failed.model, [{ type: "closeRequested" }]);
    expect(shouldClose(retried.model)).toBe(true);
    expect(closeRequest(retried.model)).toEqual({ kind: "submit", optionId: "no" });
    const done = play(retried.model, [{ type: "closeStarted" }, { type: "closed" }]);
    expect(done.model.phase).toBe("closed");

    const views = [...recorded.views, ...failed.views, ...retried.views, ...done.views];
    expect(views.map((view) => view.problem)).not.toContain(strings.cardNotRecorded);
  });

  it("retries a failed close on the next state refresh", () => {
    const { model } = play(initialCard(0), [
      { type: "choose", optionId: "yes" },
      { type: "decided", outcome: "recorded" },
      { type: "closeStarted" },
      { type: "closeFailed" },
      { type: "state", state: { ...openState, open: false, decided: "yes" } },
    ]);
    expect(shouldClose(model)).toBe(true);
    expect(closeRequest(model)).toEqual({ kind: "submit", optionId: "yes" });
  });

  it("shows a decision recorded elsewhere and closes the card with it", () => {
    const { model } = play(initialCard(0), [
      { type: "state", state: { ...openState, open: false, decided: "no" } },
    ]);
    expect(cardView(model, card).notice).toBe(strings.cardDecided("Нет"));
    expect(cardView(model, card).options).toBe("hidden");
    expect(closeRequest(model)).toEqual({ kind: "submit", optionId: "no" });
  });

  it("shows a stale answer as an outdated card that is closed by cancel, not by the chosen option", () => {
    const { model, views } = play(initialCard(0), [
      { type: "choose", optionId: "yes" },
      { type: "decided", outcome: "stale" },
    ]);
    expect(views.at(-1)).toEqual({
      options: "hidden",
      notice: strings.cardOutdatedStale,
      problem: null,
      closeLabel: strings.cardDismiss,
      waiting: null,
    });
    expect(shouldClose(model)).toBe(false);
    const dismissed = reduceCard(model, { type: "closeRequested" });
    expect(shouldClose(dismissed)).toBe(true);
    expect(closeRequest(dismissed)).toEqual({ kind: "cancel" });
  });

  it("shows an expired or withdrawn card as outdated with its reason", () => {
    const expired = play(initialCard(0), [
      { type: "state", state: { ...openState, open: false, outdated: "expired" } },
    ]);
    expect(cardView(expired.model, card).notice).toBe(strings.cardOutdatedExpired);
    expect(closeRequest(expired.model)).toEqual({ kind: "cancel" });
    const withdrawn = play(initialCard(0), [
      { type: "state", state: { ...openState, open: false } },
    ]);
    expect(cardView(withdrawn.model, card).notice).toBe(strings.cardOutdatedClosed);
  });

  it("lets the owner choose again when the decision was not recorded", () => {
    for (const event of [
      { type: "decided", outcome: "rejected" },
      { type: "decideFailed" },
    ] as const) {
      const { model } = play(initialCard(0), [{ type: "choose", optionId: "yes" }, event]);
      expect(cardView(model, card)).toMatchObject({
        options: "enabled",
        problem: strings.cardNotRecorded,
      });
      expect(closeRequest(model)).toBeNull();
    }
  });
});
