import type { PluginRpcMethodContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const optionSchema = z
  .object({
    id: z.string().min(1).max(40),
    label: z.string().min(1).max(160),
    recommended: z.boolean(),
  })
  .strict();

export const cardSchema = z
  .object({
    title: z.string().min(1).max(120),
    observed: z.string().max(600),
    affected: z.string().max(300),
    recommendation: z.string().max(300),
    quote: z.string().max(4000).optional(),
    options: z.array(optionSchema).min(1).max(3),
  })
  .strict();

export type Card = z.infer<typeof cardSchema>;

export const questionPayloadSchema = cardSchema.extend({
  questionId: z.string(),
  token: z.string(),
  waiting: z.number().int().min(0),
});
export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

export const answerSchema = z.object({ token: z.string(), optionId: z.string() }).strict();

export const ANSWER_OUTCOMES = ["applied", "recorded", "stale", "unknown", "rejected"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

export const questionRpcContract = {
  "questions.v1.decide": {
    input: z
      .object({
        questionId: z.string().max(80),
        token: z.string().max(80),
        optionId: z.string().max(40),
      })
      .strict(),
    output: z.object({ outcome: z.enum(ANSWER_OUTCOMES) }).strict(),
  },
  "questions.v1.state": {
    input: z.object({ questionId: z.string().max(80), token: z.string().max(80) }).strict(),
    output: z.object({ open: z.boolean(), decided: z.string().nullable() }).strict(),
  },
} satisfies Record<string, PluginRpcMethodContract>;
