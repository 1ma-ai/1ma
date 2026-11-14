import { useState } from "react";
import { definePluginApp, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { questionPayloadSchema } from "./src/card.js";
import { strings } from "./strings.js";

function QuestionCard({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const [busy, setBusy] = useState(false);
  const parsed = questionPayloadSchema.safeParse(interaction.payload);
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
    setBusy(true);
    void submit({ token: card.token, optionId }).finally(() => setBusy(false));
  };
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
      <div className="flex flex-wrap gap-2">
        {card.options.map((option) => (
          <button
            key={option.id}
            type="button"
            disabled={busy}
            className={`rounded-md px-3 py-1.5 ${option.recommended ? "bg-primary text-primary-foreground" : "border"} disabled:opacity-50`}
            onClick={() => choose(option.id)}
          >
            {option.recommended ? `${option.label} (${strings.recommended})` : option.label}
          </button>
        ))}
      </div>
      {card.waiting > 0 ? (
        <p className="text-xs text-muted-foreground">{strings.moreWaiting(card.waiting)}</p>
      ) : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.pendingInteraction({ id: "question", component: QuestionCard });
});
