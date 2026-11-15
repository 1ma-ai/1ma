import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strings } from "../strings.js";
import { claimProblemCode } from "./claims.js";
import { isRepoName, parsePullRequestUrl, repoFromRemoteUrl } from "./github/names.js";
import type { PullRequestDto, WorkDto } from "./work-rpc.js";

export const OVERVIEW_TOOL = "sa_overview";
export const DETAIL_TOOL = "sa_work_detail";
export const READ_TOOLS = [OVERVIEW_TOOL, DETAIL_TOOL] as const;
export const OVERVIEW_LIMIT = 40;

export interface BotReadSource {
  list(): Promise<{
    works: WorkDto[];
    servers: Array<{
      id: string;
      completeness: string;
      lastSeenAt: number | null;
      lastAttemptAt: number;
      lastError: string | null;
    }>;
    github: { at: number; problems: string[] } | null;
    releases: Array<{ repo: string; mainHead: string; state: string; detail: string | null }>;
  }>;
  waiting(): Promise<{
    works: WorkDto[];
    questions: Array<{ kind: string; title: string; state: string }>;
  }>;
  pullRequests(): Promise<{ pullRequests: PullRequestDto[] }>;
  botTasks(): Array<{
    id: string;
    server: string;
    state: string;
    chat: string | null;
    updatedAt: number;
  }>;
}

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

const SHA = /^[0-9a-f]{7,40}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,99}$/;
const THREAD = /^thr_[a-z0-9]+$/;
const WAITING = new Set(["owner", "limit", "machine"]);
const MAIN_STATES = new Set(["ok", "needs_reconcile", "bypass", "unknown"]);

function ident(value: string | null): string | null {
  return value !== null && IDENT.test(value) ? value : null;
}

function chatRef(serverId: string | null, threadId: string | null): string | null {
  if (threadId === null || !THREAD.test(threadId)) return null;
  return serverId === "mac" || serverId === "linux" ? `${serverId}:${threadId}` : null;
}

function repoName(value: string): string | null {
  return isRepoName(value) ? value : null;
}

export function botPullRequest(pr: PullRequestDto) {
  const repo = repoName(pr.repo);
  return {
    pr: repo === null ? null : `${repo}#${pr.number}`,
    state: pr.state,
    headSha: SHA.test(pr.headSha) ? pr.headSha.slice(0, 12) : null,
    link: pr.link.kind === null ? "unlinked" : pr.link.kind === "claim" ? "claimed" : "manual",
    chat: chatRef(pr.link.serverId, pr.link.threadId),
    linkProblem: pr.link.problem === null ? null : claimProblemCode(pr.link.problem),
    provenance: pr.provenance,
    chatModelsClaimed: pr.chatModels.models.flatMap((model) => {
      const provider = ident(model.providerId);
      const name = ident(model.model);
      return provider === null || name === null ? [] : [`${provider}/${name}`];
    }),
  };
}

export function botWork(work: WorkDto) {
  return {
    chat: chatRef(work.source.serverId, work.source.threadId),
    state: work.state,
    waiting:
      work.waitingReason !== null && WAITING.has(work.waitingReason) ? work.waitingReason : null,
    repo: repoFromRemoteUrl(work.repo),
    provider: ident(work.providerId),
    pullRequests: work.pullRequests.map(botPullRequest),
    updatedAt: iso(work.updatedAt),
  };
}

export function overviewData(
  list: Awaited<ReturnType<BotReadSource["list"]>>,
  waiting: Awaited<ReturnType<BotReadSource["waiting"]>>,
  pulls: Awaited<ReturnType<BotReadSource["pullRequests"]>>,
  tasks: ReturnType<BotReadSource["botTasks"]>,
) {
  return {
    servers: list.servers.map((server) => ({
      server: server.id === "mac" || server.id === "linux" ? server.id : null,
      completeness: server.completeness,
      lastSeen: iso(server.lastSeenAt),
      lastAttempt: iso(server.lastAttemptAt),
      problem: server.lastError === null ? null : "read_failed",
    })),
    github:
      list.github === null
        ? null
        : { lastPass: iso(list.github.at), problems: list.github.problems.length },
    works: list.works.slice(0, OVERVIEW_LIMIT).map(botWork),
    moreWorks: Math.max(0, list.works.length - OVERVIEW_LIMIT),
    waiting: waiting.works.map((work) => chatRef(work.source.serverId, work.source.threadId)),
    questionsForOwner: waiting.questions.map((question) => ({
      kind: ident(question.kind),
      state: question.state === "open" ? "open" : "queued",
    })),
    main: list.releases.map((row) => ({
      repo: repoName(row.repo),
      head: SHA.test(row.mainHead) ? row.mainHead.slice(0, 12) : null,
      state: MAIN_STATES.has(row.state) ? row.state : "unknown",
    })),
    botTasks: tasks.map((task) => ({
      id: ident(task.id),
      server: task.server === "mac" || task.server === "linux" ? task.server : null,
      state: ident(task.state),
      chat: task.chat !== null && /^(mac|linux):thr_[a-z0-9]+$/.test(task.chat) ? task.chat : null,
      updatedAt: iso(task.updatedAt),
    })),
    unlinkedPullRequests: pulls.pullRequests
      .filter((pr) => pr.link.threadId === null && pr.state === "open")
      .map(botPullRequest),
  };
}

function data(value: unknown): string {
  return JSON.stringify(value);
}

function refuse(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function registerBotReadTools(
  bb: BbPluginApi,
  source: BotReadSource,
  allowed: (threadId: string) => Promise<boolean>,
): void {
  bb.agents.registerTool({
    name: OVERVIEW_TOOL,
    description: strings.overviewDescription,
    presentation: {
      label: { pending: strings.overviewPending, completed: strings.overviewCompleted },
      icon: { glyph: "Workflow" },
    },
    parameters: z.object({}).strict(),
    async execute(_input, ctx) {
      if (!(await allowed(ctx.threadId))) return refuse(strings.notMainBot);
      const [list, waiting, pulls] = await Promise.all([
        source.list(),
        source.waiting(),
        source.pullRequests(),
      ]);
      return data(overviewData(list, waiting, pulls, source.botTasks()));
    },
  });

  bb.agents.registerTool({
    name: DETAIL_TOOL,
    description: strings.detailDescription,
    presentation: {
      label: { pending: strings.detailPending, completed: strings.detailCompleted },
      icon: { glyph: "Workflow" },
    },
    parameters: z.object({ ref: z.string().min(1).max(300) }).strict(),
    async execute({ ref }, ctx) {
      if (!(await allowed(ctx.threadId))) return refuse(strings.notMainBot);
      const pr = parsePullRequestUrl(ref);
      if (pr !== null) {
        const found = (await source.pullRequests()).pullRequests.find(
          (candidate) => candidate.repo === pr.repo && candidate.number === pr.number,
        );
        return found === undefined
          ? refuse(`No record of ${pr.repo}#${pr.number} yet.`)
          : data(botPullRequest(found));
      }
      const match = /^(?:(mac|linux):)?(thr_[a-z0-9]+)$/.exec(ref.trim());
      if (match === null)
        return refuse("Pass mac:thr_..., linux:thr_..., thr_... or a pull request URL.");
      const works = (await source.list()).works.filter(
        (work) =>
          work.source.threadId === match[2] &&
          (match[1] === undefined || work.source.serverId === match[1]),
      );
      if (works.length === 0) return refuse(`No work for ${ref} in the record.`);
      return data(works.map(botWork));
    },
  });
}
