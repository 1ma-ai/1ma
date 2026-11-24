import type { PluginUi } from "@get-bb/plugin-sdk";
import type { Background } from "./background.js";
import {
  QUESTION_RENDERER,
  QUESTION_TIMEOUT_MS,
  type QuestionPayload,
  type QuestionStore,
  answerSchema,
  newToken,
} from "./questions.js";

const RETRY_MS = 5 * 60 * 1000;

export interface DispatcherDeps {
  readonly requestInput: PluginUi["requestInput"];
  readonly warn: (message: string) => void;
  readonly background: Background;
  readonly store: QuestionStore;
  readonly chat: () => string | null;
  readonly now: () => number;
  readonly signal: AbortSignal;
  readonly changed?: () => void;
}

export class QuestionDispatcher {
  readonly #deps: DispatcherDeps;
  #live: { questionId: string; token: string } | null = null;

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  get liveQuestionId(): string | null {
    return this.#live?.questionId ?? null;
  }

  dispatch(): void {
    if (this.#deps.signal.aborted) return;
    this.#deps.changed?.();
    if (this.#live !== null) return;
    const chat = this.#deps.chat();
    if (chat === null) return;
    const now = this.#deps.now();
    const question = this.#deps.store.next(now);
    if (question === null) return;
    const token = newToken();
    if (!this.#deps.store.markOpen(question.id, chat, token, now)) return;
    this.#live = { questionId: question.id, token };
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
            describeSubmission: (value) => {
              const parsed = answerSchema.safeParse(value);
              const option = question.card.options.find(
                (candidate) => parsed.success && candidate.id === parsed.data.optionId,
              );
              return option === undefined
                ? {}
                : { title: `${question.card.title}: ${option.label}` };
            },
          },
          { signal: this.#deps.signal },
        ),
      )
      .then(
        (result) => {
          this.#live = null;
          if (this.#deps.signal.aborted) return;
          if (result.outcome === "submitted") {
            const recorded = this.#deps.store.get(question.id);
            if (recorded?.state === "open" && recorded.token === token)
              this.#deps.store.requeueUnrecorded(question.id, token);
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
          this.#live = null;
          if (this.#deps.signal.aborted) return;
          this.#deps.store.requeue(question.id, token, this.#deps.now() + RETRY_MS);
          this.#deps.warn(
            `could not open a question in ${chat}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
  }
}
