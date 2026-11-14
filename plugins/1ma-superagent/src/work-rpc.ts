import { defineRpcContract, experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { GitHubPassState } from "./pass.js";
import type { PrLinkRow, PrStore } from "./pr-store.js";
import type { QuestionStore } from "./questions.js";
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

const pullRequestSchema = z.object({
  repo: z.string(),
  number: z.number().int(),
  state: z.enum(["open", "closed", "merged"]),
  headRef: z.string(),
  headSha: z.string(),
  author: z.string().nullable(),
  link: z.object({
    kind: z.enum(["claim", "manual"]).nullable(),
    serverId: z.enum(["mac", "linux"]).nullable(),
    threadId: z.string().nullable(),
    problem: z.string().nullable(),
    branchHint: z.array(z.string()),
  }),
  provenance: z.object({
    known: z.boolean(),
    complete: z.boolean(),
    models: z.array(z.object({ providerId: z.string(), model: z.string() })),
  }),
  observedAt: z.number(),
});

export type PullRequestDto = z.infer<typeof pullRequestSchema>;

const githubSchema = z.object({ at: z.number(), problems: z.array(z.string()) }).nullable();

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
  pullRequests: z.array(pullRequestSchema),
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
      github: githubSchema,
      releases: z.array(
        z.object({
          repo: z.string(),
          mainHead: z.string(),
          state: z.enum(["ok", "needs_reconcile", "bypass", "unknown"]),
          detail: z.string().nullable(),
          checkedAt: z.number(),
        }),
      ),
      nextOffset: z.number().int().nullable(),
    }),
  },
  "work.v1.pullRequests": {
    input: z.object({ unlinkedOnly: z.boolean().optional() }).strict(),
    output: z.object({ pullRequests: z.array(pullRequestSchema), github: githubSchema }),
  },
  "work.v1.get": {
    input: z.object({ workId: z.string().min(1) }).strict(),
    output: z.object({ work: workSchema, server: serverSchema.nullable() }),
  },
  "work.v1.waiting": {
    input: z.null(),
    output: z.object({
      works: z.array(workSchema),
      questions: z.array(
        z.object({
          id: z.string(),
          kind: z.string(),
          title: z.string(),
          state: z.enum(["queued", "open"]),
          createdAt: z.number(),
        }),
      ),
    }),
  },
});

export function toPullRequestDto(link: PrLinkRow, prStore: PrStore): PullRequestDto {
  const models = link.linkKind === "claim" ? prStore.provenance(link.repo, link.number) : [];
  return {
    repo: link.repo,
    number: link.number,
    state: link.prState,
    headRef: link.headRef,
    headSha: link.headSha,
    author: link.author,
    link: {
      kind: link.linkKind,
      serverId: link.deliveryServerId,
      threadId: link.deliveryThreadId,
      problem: link.claimProblem,
      branchHint: link.branchHint === null ? [] : link.branchHint.split(","),
    },
    provenance: {
      known: link.linkKind === "claim" && models.length > 0,
      complete: link.linkKind === "claim" && models.length > 0 && !link.provenanceGap,
      models: models.map((row) => ({ providerId: row.providerId, model: row.model })),
    },
    observedAt: link.observedAt,
  };
}

export function toWorkDto(row: WorkRow, prStore: PrStore): WorkDto {
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
    pullRequests: prStore
      .forThread(row.serverId, row.threadId)
      .map((link) => toPullRequestDto(link, prStore)),
  };
}

function serverDto(row: ServerRow): z.infer<typeof serverSchema> {
  return { ...row };
}

export function workRpcHandlers(
  store: Store,
  prStore: PrStore,
  questions: QuestionStore,
  releases: () => Array<{
    repo: string;
    lastHead: string;
    state: "ok" | "needs_reconcile" | "bypass" | "unknown";
    detail: string | null;
    checkedAt: number;
  }>,
  github: () => Promise<GitHubPassState | null>,
) {
  const toDto = (row: WorkRow) => toWorkDto(row, prStore);
  const githubDto = async () => {
    const state = await github();
    return state === null ? null : { at: state.at, problems: [...state.problems] };
  };
  return {
    async "work.v1.list"(input: { limit?: number; offset?: number; includeClosed?: boolean }) {
      const limit = input.limit ?? 50;
      const offset = input.offset ?? 0;
      const rows = store.listWorks({
        limit: limit + 1,
        offset,
        includeClosed: input.includeClosed ?? false,
      });
      return {
        works: rows.slice(0, limit).map(toDto),
        servers: store.servers().map(serverDto),
        github: await githubDto(),
        releases: releases().map((row) => ({
          repo: row.repo,
          mainHead: row.lastHead,
          state: row.state,
          detail: row.detail,
          checkedAt: row.checkedAt,
        })),
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
      return { work: toDto(row), server: server === null ? null : serverDto(server) };
    },
    "work.v1.waiting"() {
      return {
        works: store.waitingWorks().map(toDto),
        questions: questions.waiting().map((question) => ({
          id: question.id,
          kind: question.kind,
          title: question.card.title,
          state: question.state === "open" ? ("open" as const) : ("queued" as const),
          createdAt: question.createdAt,
        })),
      };
    },
    async "work.v1.pullRequests"(input: { unlinkedOnly?: boolean }) {
      const links = prStore
        .all()
        .filter((link) => !(input.unlinkedOnly ?? false) || link.deliveryThreadId === null);
      return {
        pullRequests: links.map((link) => toPullRequestDto(link, prStore)),
        github: await githubDto(),
      };
    },
  };
}
