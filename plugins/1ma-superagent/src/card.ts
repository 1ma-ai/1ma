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
    options: z.array(optionSchema).min(1).max(3),
  })
  .strict();

export type Card = z.infer<typeof cardSchema>;

export const questionPayloadSchema = cardSchema.extend({
  token: z.string(),
  waiting: z.number().int().min(0),
});
export type QuestionPayload = z.infer<typeof questionPayloadSchema>;

export const answerSchema = z.object({ token: z.string(), optionId: z.string() }).strict();
