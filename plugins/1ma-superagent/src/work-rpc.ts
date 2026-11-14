import { defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { ServerRow, Store, WorkRow } from "./store.js";

const MAX_PAGE = 200;

const serverSchema = z.object({
  id: z.enum(["mac", "linux"]),
  lastSeenAt: z.number().nullable(),
  lastCompleteAt: z.number().nullable(),
  lastAttemptAt: z.number(),
  completeness: z.enum(["complete", "partial", "failed"]),
  lastError: z.string().nullable(),
});

const workSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  source: z.object({
    kind: z.string(),
    serverId: z.enum(["mac", "linux"]),
    threadId: z.string(),
  }),
  state: z.enum(["active", "idle", "error", "closed"]),
  waitingReason: z.string().nullable(),
  title: z.string().nullable(),
  providerId: z.string().nullable(),
  projectId: z.string().nullable(),
  branch: z.string().nullable(),
  repo: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

export type WorkDto = z.infer<typeof workSchema>;

export const workRpcContract = defineRpcContract({
  "work.v1.list": {
    input: z
      .object({
        limit: z.number().int().min(1).max(MAX_PAGE).optional(),
        offset: z.number().int().min(0).optional(),
        includeClosed: z.boolean().optional(),
      })
      .strict(),
    output: z.object({
      works: z.array(workSchema),
      servers: z.array(serverSchema),
      nextOffset: z.number().int().nullable(),
    }),
  },
  "work.v1.get": {
    input: z.object({ workId: z.string().min(1) }).strict(),
    output: z.object({ work: workSchema, server: serverSchema.nullable() }),
  },
  "work.v1.waiting": {
    input: z.null(),
    output: z.object({ works: z.array(workSchema) }),
  },
});

export function toWorkDto(row: WorkRow): WorkDto {
  return {
    id: row.id,
    version: row.version,
    source: { kind: row.sourceKind, serverId: row.serverId, threadId: row.threadId },
    state: row.state,
    waitingReason: row.waitingReason,
    title: row.title,
    providerId: row.providerId,
    projectId: row.projectId,
    branch: row.branch,
    repo: row.repo,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serverDto(row: ServerRow): z.infer<typeof serverSchema> {
  return { ...row };
}

export function workRpcHandlers(store: Store) {
  return {
    "work.v1.list"(input: { limit?: number; offset?: number; includeClosed?: boolean }) {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const rows = store.listWorks({
        limit: limit + 1,
        offset,
        includeClosed: input.includeClosed ?? false,
      });
      return {
        works: rows.slice(0, limit).map(toWorkDto),
        servers: store.servers().map(serverDto),
        nextOffset: rows.length > limit ? offset + limit : null,
      };
    },
    "work.v1.get"(input: { workId: string }) {
      const row = store.getWork(input.workId);
      if (row === null) {
        throw new experimental_PluginRpcRefusal({
          code: "not_found",
          message: `No work ${input.workId}`,
        });
      }
      const server = store.servers().find((candidate) => candidate.id === row.serverId) ?? null;
      return { work: toWorkDto(row), server: server === null ? null : serverDto(server) };
    },
    "work.v1.waiting"() {
      return { works: store.waitingWorks().map(toWorkDto) };
    },
  };
}
