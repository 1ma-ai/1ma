import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strings } from "../strings.js";
import { parsePullRequestUrl } from "./github/names.js";
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

export function botPullRequest(pr: PullRequestDto) {
  return {
    pr: `${pr.repo}#${pr.number}`,
    state: pr.state,
    headSha: pr.headSha.slice(0, 12),
    link: pr.link.kind === null ? "unlinked" : pr.link.kind,
    chat: pr.link.threadId === null ? null : `${pr.link.serverId}:${pr.link.threadId}`,
    linkProblem: pr.link.problem,
    provenance: pr.provenance.known
      ? {
          complete: pr.provenance.complete,
          models: pr.provenance.models.map((model) => `${model.providerId}/${model.model}`),
        }
      : "unknown",
  };
}

export function botWork(work: WorkDto) {
  return {
    chat: `${work.source.serverId}:${work.source.threadId}`,
    state: work.state,
    waiting: work.waitingReason,
    repo: work.repo,
    branch: work.branch,
    provider: work.providerId,
    pullRequests: work.pullRequests.map(botPullRequest),
    updatedAt: iso(work.updatedAt),
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
      return data({
        servers: list.servers.map((server) => ({
          server: server.id,
          completeness: server.completeness,
          lastSeen: iso(server.lastSeenAt),
          lastAttempt: iso(server.lastAttemptAt),
          problem: server.lastError,
        })),
        github:
          list.github === null
            ? null
            : { lastPass: iso(list.github.at), problems: list.github.problems },
        works: list.works.slice(0, OVERVIEW_LIMIT).map(botWork),
        moreWorks: Math.max(0, list.works.length - OVERVIEW_LIMIT),
        waiting: waiting.works.map((work) => `${work.source.serverId}:${work.source.threadId}`),
        questionsForOwner: waiting.questions.map((question) => ({
          kind: question.kind,
          title: question.title,
          state: question.state,
        })),
        main: list.releases.map((row) => ({
          repo: row.repo,
          head: row.mainHead.slice(0, 12),
          state: row.state,
          detail: row.detail,
        })),
        botTasks: source.botTasks().map((task) => ({ ...task, updatedAt: iso(task.updatedAt) })),
        unlinkedPullRequests: pulls.pullRequests
          .filter((pr) => pr.link.threadId === null && pr.state === "open")
          .map(botPullRequest),
      });
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
