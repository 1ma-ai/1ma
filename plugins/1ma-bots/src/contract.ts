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

const singleLine = (schema: z.ZodString) =>
  schema.regex(/^[^\p{Cc}]*$/u, "One line of text without control characters");
export const botNameSchema = singleLine(z.string().trim().min(1).max(NAME_MAX));
export const botRoleSchema = singleLine(z.string().trim().max(ROLE_MAX));
const name = botNameSchema;
const role = botRoleSchema;
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
  // New each time the conversation joins a bot, the same bot included.
  assignment: z.string(),
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
  reach: z.array(z.string()).nullable(),
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

export const actorSchema = z.object({
  kind: z.enum(["owner", "agent", "plugin", "system"]),
  id: z.string().nullable(),
});
export type Actor = z.infer<typeof actorSchema>;

export const botEventSchema = z.object({
  id: z.number().int(),
  at: z.number(),
  kind: z.string(),
  actor: actorSchema,
  detail: z.record(z.string(), z.unknown()),
});
export type BotEvent = z.infer<typeof botEventSchema>;

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
  reach: z.array(z.string()).max(200).nullable().optional(),
  clearDefaults: z.literal(true).optional(),
});
export type UpdateBotInput = z.infer<typeof updateBotInput>;

export const startThreadInput = z.object({
  botId: z.string(),
  request: z.record(z.string(), z.unknown()),
});

// What the window showed when the owner acted. Anything else by the time of the
// write is a conflict (the table in docs/plan/2026-11-14-1ma-bots-and-sidebar-design.md).
const seenAssignment = z.object({ botId: z.string(), assignment: z.string() });
export type Assignment = z.infer<typeof seenAssignment>;

const seenThread = z.object({
  threadId: z.string(),
  // Its parent in bb, which the bot's tree may not show.
  parentThreadId: z.string().nullable(),
  // The conversation and the ones it is drawn under, nearest first, each with its
  // place in the bot and its mark. A sub-thread an agent made has no place.
  branch: z.array(
    z.object({
      threadId: z.string(),
      assignment: z.string().nullable(),
      completed: z.boolean(),
    }),
  ),
});
export type SeenThread = z.infer<typeof seenThread>;

// shownDone: drawn in Done, not among the open conversations.
const seenRow = seenThread.extend({ shownDone: z.boolean() });
export type SeenRow = z.infer<typeof seenRow>;

export const moveThreadsInput = z.object({
  botId: z.string(),
  sources: z.array(seenRow).min(1),
  // inside: under the target, which changes no order.
  target: seenRow.extend({ placement: z.enum(["before", "after", "inside"]) }),
  // Whether the moved conversations and the target were drawn under the ones
  // above them. Otherwise only the order changes.
  levelShown: z.boolean(),
});
export type MoveThreadsInput = z.infer<typeof moveThreadsInput>;

export const moveToTopInput = z.object({ botId: z.string(), thread: seenRow });
export type MoveToTopInput = z.infer<typeof moveToTopInput>;

const assignInput = z.object({
  threadId: z.string(),
  botId: z.string().nullable(),
  place: z.enum(["first", "last"]).optional(),
});
export type AssignInput = z.infer<typeof assignInput>;
const assignOutput = z.object({ botId: z.string().nullable(), startedFromBot: z.boolean() });

export const botsReads = {
  "bots.v1.list": {
    input: z.object({}),
    output: z.object({ bots: z.array(botSummarySchema) }),
  },
  "bots.v1.forThread": {
    input: threadId,
    output: z.object({ botId: z.string(), capabilities: z.array(z.string()) }).nullable(),
  },
  "bots.v1.get": { input: botId, output: botDetailSchema },
  "bots.v1.events": {
    input: z.object({ botId: z.string(), limit: z.number().int().min(1).max(200).optional() }),
    output: z.object({ events: z.array(botEventSchema) }),
  },
  // The conversation a click on the bot opens; null when a click starts a new one.
  "bots.v2.main": {
    input: botId,
    output: z.object({ threadId: z.string().nullable() }),
  },
} as const satisfies Record<string, PluginRpcMethodContract>;

// Every method here has a row in the plan's table.
export const botsWrites = {
  "bots.v1.create": { input: createBotInput, output: botDetailSchema },
  "bots.v1.update": { input: updateBotInput, output: botDetailSchema },
  "bots.v1.remove": { input: botId, output: ok },
  "bots.v1.setHidden": {
    input: z.object({ botId: z.string(), hidden: z.boolean() }),
    output: ok,
  },
  "bots.v1.startThread": { input: startThreadInput, output: threadId },
  // What the 1ma-sidebar released before bots.v2 sends. It tells nothing of what
  // it showed, so these act on what there is when they arrive.
  "bots.v1.assign": { input: assignInput, output: assignOutput },
  "bots.v1.setCompleted": {
    input: z.object({ threadId: z.string(), completed: z.boolean() }),
    output: ok,
  },
  "bots.v2.assign": {
    input: assignInput.extend({ seen: seenAssignment.nullable() }),
    output: assignOutput,
  },
  "bots.v2.setCompleted": {
    input: z.object({ botId: z.string(), thread: seenThread, completed: z.boolean() }),
    output: ok,
  },
  "bots.v2.moveThreads": { input: moveThreadsInput, output: ok },
  // First under its own parent.
  "bots.v2.moveToTop": { input: moveToTopInput, output: ok },
  "bots.v2.continueInBot": {
    input: z.object({ threadId: z.string(), seen: seenAssignment }),
    output: threadId,
  },
  "bots.v2.reorderBots": {
    input: z.object({ botIds: z.array(z.string()), seen: z.array(z.string()) }),
    output: ok,
  },
} as const satisfies Record<string, PluginRpcMethodContract>;

export const botsRpc = { ...botsReads, ...botsWrites };
