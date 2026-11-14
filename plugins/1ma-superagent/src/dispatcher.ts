import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  type AnswerOutcome,
  QUESTION_RENDERER,
  QUESTION_TIMEOUT_MS,
  type QuestionKind,
  type QuestionPayload,
  type QuestionStore,
  answerSchema,
  newToken,
} from "./questions.js";

const RETRY_MS = 5 * 60 * 1000;

export interface DispatcherDeps {
  readonly bb: BbPluginApi;
  readonly store: QuestionStore;
  readonly kinds: ReadonlyMap<string, QuestionKind>;
  readonly chat: () => string | null;
  readonly now: () => number;
  readonly onAnswered: (outcome: AnswerOutcome) => void;
  readonly signal: AbortSignal;
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
    if (this.#live !== null || this.#deps.signal.aborted) return;
    const chat = this.#deps.chat();
    if (chat === null) return;
    const now = this.#deps.now();
    const question = this.#deps.store.next(now);
    if (question === null) return;
    const token = newToken();
    if (!this.#deps.store.markOpen(question.id, chat, token, now)) return;
    this.#live = { questionId: question.id, token };
    const waiting = Math.max(0, this.#deps.store.waiting().length - 1);
    const payload: QuestionPayload = { ...question.card, token, waiting };
    void this.#deps.bb.ui
      .requestInput(
        {
          threadId: chat,
          rendererId: QUESTION_RENDERER,
          title: question.card.title,
          payload,
          timeoutMs: QUESTION_TIMEOUT_MS,
          presentation: { label: { pending: question.card.title, completed: question.card.title } },
          describeSubmission: (value) => {
            const parsed = answerSchema.safeParse(value);
            const option = question.card.options.find(
              (candidate) => parsed.success && candidate.id === parsed.data.optionId,
            );
            return option === undefined ? {} : { title: `${question.card.title}: ${option.label}` };
          },
        },
        { signal: this.#deps.signal },
      )
      .then(
        (result) => {
          this.#live = null;
          if (result.outcome === "submitted") {
            const parsed = answerSchema.safeParse(result.value);
            const outcome: AnswerOutcome =
              parsed.success && parsed.data.token === token
                ? this.#deps.store.answer(
                    question.id,
                    token,
                    parsed.data.optionId,
                    this.#deps.kinds,
                    this.#deps.now(),
                  )
                : "rejected";
            if (outcome === "rejected" || outcome === "unknown")
              this.#deps.store.requeue(question.id, token, null);
            this.#deps.onAnswered(outcome);
          } else if (result.reason === "user") {
            this.#deps.store.closeAs(question.id, token, "canceled");
          } else {
            this.#deps.store.requeue(question.id, token, null);
          }
          if (!this.#deps.signal.aborted) this.dispatch();
        },
        (error: unknown) => {
          this.#live = null;
          this.#deps.store.requeue(question.id, token, this.#deps.now() + RETRY_MS);
          this.#deps.bb.log.warn(
            `could not open a question in ${chat}: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      );
  }
}
