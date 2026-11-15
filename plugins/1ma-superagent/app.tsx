import { useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useRpcQuery,
  type PluginPendingInteractionProps,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { questionPayloadSchema, questionRpcContract } from "./src/card.js";
import { strings } from "./strings.js";

const RECORDED = new Set(["applied", "recorded", "stale"]);

function QuestionCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const rpc = useRpc<typeof questionRpcContract>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [decided, setDecided] = useState<string | null>(null);
  const closing = useRef(false);
  const parsed = questionPayloadSchema.safeParse(interaction.payload);
  const questionId = parsed.success ? parsed.data.questionId : null;
  const token = parsed.success ? parsed.data.token : null;

  const state = experimental_useRpcQuery({
    contract: questionRpcContract,
    method: "questions.v1.state",
    input: { questionId: questionId ?? "", token: token ?? "" },
    enabled: questionId !== null && token !== null,
  }).data;

  useEffect(() => {
    if (state === undefined || token === null || closing.current) return;
    closing.current = state.decided !== null || !state.open;
    if (state.decided !== null) {
      setDecided(state.decided);
      void submit({ token, optionId: state.decided }).catch(() => {});
    } else if (!state.open) {
      void cancel().catch(() => {});
    }
  }, [state?.decided, state?.open, token]);

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
    if (closing.current) return;
    setBusy(true);
    setProblem(null);
    rpc
      .call("questions.v1.decide", { questionId: card.questionId, token: card.token, optionId })
      .then(async ({ outcome }) => {
        if (!RECORDED.has(outcome)) {
          setProblem(strings.cardNotRecorded);
          return;
        }
        if (closing.current) return;
        closing.current = true;
        await submit({ token: card.token, optionId });
      })
      .catch(() => setProblem(strings.cardNotRecorded))
      .finally(() => setBusy(false));
  };
  const decidedLabel = card.options.find((option) => option.id === decided)?.label;
  return (
    <div className="space-y-3 text-sm">
      <p className="font-medium">{card.title}</p>
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
      <div className="flex flex-wrap gap-2">
        {card.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy || decided !== null}
            className={`rounded-md px-3 py-1.5 ${option.recommended ? "bg-primary text-primary-foreground" : "border"} disabled:opacity-50`}
            onClick={() => choose(option.id)}
          >
            {option.recommended ? `${option.label} (${strings.recommended})` : option.label}
          </button>
        ))}
      </div>
      {decidedLabel === undefined ? null : (
        <p className="text-xs text-muted-foreground">{strings.cardDecided(decidedLabel)}</p>
      )}
      {problem === null ? null : <p className="text-xs text-destructive">{problem}</p>}
      {(state?.waiting ?? card.waiting) > 0 ? (
        <p className="text-xs text-muted-foreground">
          {strings.moreWaiting(state?.waiting ?? card.waiting)}
        </p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "question", component: QuestionCard });
});
