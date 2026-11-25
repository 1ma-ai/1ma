import { useEffect, useReducer } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  type PluginPendingInteractionProps,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { questionPayloadSchema, questionRpcContract } from "./src/card.js";
import { cardView, closeRequest, initialCard, reduceCard, shouldClose } from "./src/card-model.js";
import { strings } from "./strings.js";

function QuestionCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const rpc = useRpc<typeof questionRpcContract>();
  const parsed = questionPayloadSchema.safeParse(interaction.payload);
  const questionId = parsed.success ? parsed.data.questionId : null;
  const token = parsed.success ? parsed.data.token : null;
  const [model, send] = useReducer(
    reduceCard,
    parsed.success ? parsed.data.waiting : 0,
    initialCard,
  );

  const state = experimental_useRpcQuery({
    contract: questionRpcContract,
    method: "questions.v1.state",
    input: { questionId: questionId ?? "", token: token ?? "" },
    enabled: questionId !== null && token !== null,
  }).data;

  useEffect(() => {
    if (state !== undefined) send({ type: "state", state });
  }, [state]);

  useEffect(() => {
    const request = shouldClose(model) ? closeRequest(model) : null;
    if (request === null || token === null) return;
    send({ type: "closeStarted" });
    const closing =
      request.kind === "submit" ? submit({ token, optionId: request.optionId }) : cancel();
    closing.then(
      () => send({ type: "closed" }),
      () => send({ type: "closeFailed" }),
    );
  }, [model, token, submit, cancel]);

  if (!parsed.success) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">{strings.cardBroken}</p>
        <button
          type="button"
          className="rounded-md border px-3 py-1"
          onClick={() => void cancel().catch(() => {})}
        >
          {strings.cardDismiss}
        </button>
      </div>
    );
  }
  const card = parsed.data;
  const choose = (optionId: string) => {
    if (model.phase !== "choosing") return;
    send({ type: "choose", optionId });
    rpc
      .call("questions.v1.decide", { questionId: card.questionId, token: card.token, optionId })
      .then(
        ({ outcome }) => send({ type: "decided", outcome }),
        () => send({ type: "decideFailed" }),
      );
  };
  const view = cardView(model, card);
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">{card.title}</p>
      {card.unrecorded ? (
        <p className="text-xs text-destructive">{strings.cardAnswerNotTaken}</p>
      ) : null}
      <dl className="space-y-2">
        <div>
          <dt className="text-xs text-muted-foreground">{strings.cardObserved}</dt>
          <dd>{card.observed}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{strings.cardAffected}</dt>
          <dd>{card.affected}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{strings.cardRecommendation}</dt>
          <dd>{card.recommendation}</dd>
        </div>
      </dl>
      {card.quote === undefined ? null : (
        <blockquote className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-xs">
          {card.quote}
        </blockquote>
      )}
      {view.options === "hidden" ? null : (
        <div className="flex flex-wrap gap-2">
          {card.options.map((option) => (
            <button
              key={option.id}
              type="button"
              disabled={view.options === "disabled"}
              className={`rounded-md px-3 py-1.5 ${option.recommended ? "bg-primary text-primary-foreground" : "border"} disabled:opacity-50`}
              onClick={() => choose(option.id)}
            >
              {option.recommended ? `${option.label} (${strings.recommended})` : option.label}
            </button>
          ))}
        </div>
      )}
      {view.notice === null ? null : <p className="text-xs text-muted-foreground">{view.notice}</p>}
      {view.problem === null ? null : <p className="text-xs text-destructive">{view.problem}</p>}
      {view.closeLabel === null ? null : (
        <button
          type="button"
          className="rounded-md border px-3 py-1"
          onClick={() => send({ type: "closeRequested" })}
        >
          {view.closeLabel}
        </button>
      )}
      {view.waiting === null ? null : (
        <p className="text-xs text-muted-foreground">{view.waiting}</p>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "question", component: QuestionCard });
});
