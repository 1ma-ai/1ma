import type { PluginUi } from "@get-bb/plugin-sdk";
import { strings } from "../strings.js";
import type { Background } from "./background.js";
import {
  QUESTION_RENDERER,
  QUESTION_TIMEOUT_MS,
  type QuestionPayload,
  type QuestionStore,
  newToken,
} from "./questions.js";

const RETRY_MS = 5 * 60 * 1000;
export const CARD_CLOSE_GRACE_MS = 60 * 1000;

export interface DispatcherDeps {
  readonly requestInput: PluginUi["requestInput"];
  readonly warn: (message: string) => void;
  readonly background: Background;
  readonly store: QuestionStore;
  readonly chat: () => string | null;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly changed?: () => void;
  readonly closeGraceMs?: number;
}

interface LiveCard {
  readonly questionId: string;
  readonly token: string;
  readonly close: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

export class QuestionDispatcher {
  readonly #deps: DispatcherDeps;
  #live: LiveCard | null = null;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
    deps.signal.addEventListener("abort", () => this.#settle(), { once: true });
  }

  get liveQuestionId(): string | null {
    return this.#live?.questionId ?? null;
  }

  dispatch(): void {
    if (this.#deps.signal.aborted) return;
    this.#deps.changed?.();
    if (this.#live !== null) {
      this.#closeWhenSettled(this.#live);
      return;
    }
    const chat = this.#deps.chat();
    if (chat === null) return;
    const now = this.#deps.now();
    const question = this.#deps.store.next(now);
    if (question === null) return;
    const token = newToken();
    if (!this.#deps.store.markOpen(question.id, chat, token, now)) return;
    const live: LiveCard = {
      questionId: question.id,
      token,
      close: new AbortController(),
      timer: null,
    };
    this.#live = live;
    const waiting = Math.max(0, this.#deps.store.waiting().length - 1);
    const payload: QuestionPayload = {
      ...question.card,
      questionId: question.id,
      token,
      waiting,
      unrecorded: question.unrecordedAnswer,
    };
    void this.#deps.background
      .run(() =>
        this.#deps.requestInput(
          {
            threadId: chat,
            rendererId: QUESTION_RENDERER,
            title: question.card.title,
            payload,
            timeoutMs: Math.max(1, Math.min(QUESTION_TIMEOUT_MS, question.expiresAt - now)),
            presentation: {
              label: { pending: question.card.title, completed: question.card.title },
            },
            describeSubmission: () => {
              const recorded = this.#deps.store.get(question.id);
              const option =
                recorded?.state === "answered" && recorded.token === token
                  ? question.card.options.find((candidate) => candidate.id === recorded.answer)
                  : undefined;
              return {
                title:
                  option === undefined
                    ? strings.cardClosedUnrecorded(question.card.title)
                    : strings.cardClosedDecided(question.card.title, option.label),
              };
            },
          },
          { signal: AbortSignal.any([this.#deps.signal, live.close.signal]) },
        ),
      )
      .then(
        (result) => {
          this.#settle();
          if (this.#deps.signal.aborted) return;
          if (result.outcome === "submitted") {
            const recorded = this.#deps.store.get(question.id);
            if (recorded?.state === "open" && recorded.token === token)
              this.#deps.store.requeueUnrecorded(question.id, token, this.#deps.now());
          } else if (result.reason === "user") {
            this.#deps.store.closeAs(question.id, token, "canceled");
          } else if (result.reason === "timeout") {
            this.#deps.store.closeAs(question.id, token, "expired");
          } else {
            this.#deps.store.requeue(question.id, token, null);
          }
          if (!this.#deps.signal.aborted) this.dispatch();
        },
        (error: unknown) => {
          this.#settle();
          if (this.#deps.signal.aborted) return;
          this.#deps.store.requeue(question.id, token, this.#deps.now() + RETRY_MS);
          this.#deps.warn(
            `could not open a question in ${chat}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
  }

  #closeWhenSettled(live: LiveCard): void {
    if (live.timer !== null) return;
    const question = this.#deps.store.get(live.questionId);
    if (question?.state === "open" && question.token === live.token) return;
    live.timer = setTimeout(
      () => live.close.abort(),
      this.#deps.closeGraceMs ?? CARD_CLOSE_GRACE_MS,
    );
  }

  #settle(): void {
    if (this.#live !== null && this.#live.timer !== null) clearTimeout(this.#live.timer);
    this.#live = null;
  }
}
