import type { PluginRpcMethodContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CAPABILITIES_MAX,
  CAPABILITY_PATTERN,
  INSTRUCTIONS_MAX,
  MEMORY_MAX,
  NAME_MAX,
  ROLE_MAX,
} from "./limits.js";

export const SHAPES = ["circle", "squircle", "blob", "pill"] as const;
export const FACES = ["calm", "happy", "focused", "curious"] as const;
export const COLORS = [
  "#7c6cf0",
  "#1f9e7a",
  "#e07a2c",
  "#d6457a",
  "#2f8fd8",
  "#c49a1a",
  "#8a5cd0",
  "#3aa35b",
] as const;

export const appearanceSchema = z.object({
  shape: z.enum(SHAPES),
  face: z.enum(FACES),
  color: z.string().regex(/^#[0-9a-f]{6}$/),
});
export type Appearance = z.infer<typeof appearanceSchema>;

const name = z.string().trim().min(1).max(NAME_MAX);
const role = z.string().trim().max(ROLE_MAX);
const instructions = z.string().max(INSTRUCTIONS_MAX);
const capabilities = z.array(z.string().regex(CAPABILITY_PATTERN)).max(CAPABILITIES_MAX);

export const chatDefaultsSchema = z.object({
  projectId: z.string().nullable(),
  providerId: z.string().optional(),
  model: z.string().optional(),
});
export type ChatDefaults = z.infer<typeof chatDefaultsSchema>;

export const botThreadSchema = z.object({
  threadId: z.string(),
  startedFromBot: z.boolean(),
  completed: z.boolean(),
});
export type BotThread = z.infer<typeof botThreadSchema>;

export const botSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.string(),
  appearance: appearanceSchema,
  avatar: z.string(),
  capabilities: z.array(z.string()),
  hidden: z.boolean(),
  threads: z.array(botThreadSchema),
});
export type BotSummary = z.infer<typeof botSummarySchema>;

export const botDetailSchema = botSummarySchema.extend({
  instructions: z.string(),
  memory: z.string(),
  memorySha256: z.string(),
  defaults: chatDefaultsSchema.nullable(),
  revision: z.number().int(),
});
export type BotDetail = z.infer<typeof botDetailSchema>;

const botId = z.object({ botId: z.string() });
const threadId = z.object({ threadId: z.string() });
const ok = z.object({ ok: z.literal(true) });

export const createBotInput = z.object({
  name,
  role: role.optional(),
  appearance: appearanceSchema.optional(),
  capabilities: capabilities.optional(),
  instructions: instructions.optional(),
});
export type CreateBotInput = z.infer<typeof createBotInput>;

export const updateBotInput = z.object({
  botId: z.string(),
  expectedRevision: z.number().int(),
  name: name.optional(),
  role: role.optional(),
  appearance: appearanceSchema.optional(),
  capabilities: capabilities.optional(),
  instructions: instructions.optional(),
  memory: z.string().max(MEMORY_MAX).optional(),
  hidden: z.boolean().optional(),
  clearDefaults: z.literal(true).optional(),
});
export type UpdateBotInput = z.infer<typeof updateBotInput>;

export const startThreadInput = z.object({
  botId: z.string(),
  request: z.record(z.string(), z.unknown()),
});

export const botsRpc = {
  "bots.v1.list": {
    input: z.object({}),
    output: z.object({ bots: z.array(botSummarySchema) }),
  },
  "bots.v1.forThread": {
    input: threadId,
    output: z.object({ botId: z.string(), capabilities: z.array(z.string()) }).nullable(),
  },
  "bots.v1.get": { input: botId, output: botDetailSchema },
  "bots.v1.create": { input: createBotInput, output: botDetailSchema },
  "bots.v1.update": { input: updateBotInput, output: botDetailSchema },
  "bots.v1.remove": { input: botId, output: ok },
  "bots.v1.reorderBots": { input: z.object({ botIds: z.array(z.string()) }), output: ok },
  "bots.v1.assign": {
    input: z.object({
      threadId: z.string(),
      botId: z.string().nullable(),
      place: z.enum(["first", "last"]).optional(),
    }),
    output: z.object({ botId: z.string().nullable(), startedFromBot: z.boolean() }),
  },
  "bots.v1.reorderThreads": {
    input: z.object({ botId: z.string(), threadIds: z.array(z.string()) }),
    output: ok,
  },
  "bots.v1.setCompleted": {
    input: z.object({ threadId: z.string(), completed: z.boolean() }),
    output: ok,
  },
  "bots.v1.startThread": { input: startThreadInput, output: threadId },
  "bots.v1.continueInBot": { input: threadId, output: threadId },
} as const satisfies Record<string, PluginRpcMethodContract>;
