import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const GH_OUTPUT_LIMIT = 4 * 1024 * 1024;
export const JOURNAL_TAIL_BYTES = 2 * 1024 * 1024;
export const RECENT_PAGE_SIZE = 50;
export const RECENT_MAX_PAGES = 3;

const repoPart = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+$/)
  .refine((part) => part !== "." && part !== "..");
const repoName = z.string().refine((value) => {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => repoPart.safeParse(part).success);
});

export const ghRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("pull"), repo: repoName, number: z.number().int().positive() }).strict(),
  z
    .object({
      op: z.literal("recentPulls"),
      repo: repoName,
      page: z.number().int().min(1).max(RECENT_MAX_PAGES),
    })
    .strict(),
  z.object({ op: z.literal("mainHead"), repo: repoName }).strict(),
]);

export type GhRequest = z.infer<typeof ghRequestSchema>;

export function ghPath(request: GhRequest): string {
  switch (request.op) {
    case "pull":
      return `/repos/${request.repo}/pulls/${request.number}`;
    case "recentPulls":
      return `/repos/${request.repo}/pulls?state=all&sort=updated&direction=desc&per_page=${RECENT_PAGE_SIZE}&page=${request.page}`;
    case "mainHead":
      return `/repos/${request.repo}/commits?sha=main&per_page=1`;
  }
}

export function ghArgs(request: GhRequest): string[] {
  return ["api", "--method", "GET", "-H", "Accept: application/vnd.github+json", ghPath(request)];
}

export const journalTailSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), text: z.string(), truncated: z.boolean() }).strict(),
  z.object({ status: z.literal("unconfigured") }).strict(),
  z.object({ status: z.literal("error"), message: z.string() }).strict(),
]);

export type JournalTail = z.infer<typeof journalTailSchema>;

export const hostContract = defineRpcContract({
  readJournal: {
    experimental_retryable: true,
    input: z.object({}).strict(),
    output: journalTailSchema,
  },
  gh: {
    experimental_retryable: true,
    input: ghRequestSchema,
    output: z.discriminatedUnion("status", [
      z.object({ status: z.literal("ok"), body: z.string() }).strict(),
      z.object({ status: z.literal("error"), message: z.string() }).strict(),
    ]),
  },
});
