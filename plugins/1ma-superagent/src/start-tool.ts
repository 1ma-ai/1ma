import type { BbPluginApi, PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strings } from "../strings.js";
import { START_KIND, startCard } from "./action-runner.js";
import type { BotGate } from "./bot.js";
import type { ActionStore } from "./actions.js";
import { describeError } from "./executors/paging.js";
import { repoFromRemoteUrl } from "./github/names.js";
import type { Executor, ServerId } from "./observation.js";
import type { QuestionStore } from "./questions.js";
import { type RepoPolicy, isExcludedRepo } from "./repos.js";

export const START_TOOL = "sa_start_chat";

function refuse(text: string): PluginAgentToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export interface StartToolDeps {
  readonly bb: BbPluginApi;
  readonly actions: ActionStore;
  readonly questions: QuestionStore;
  readonly executor: (serverId: ServerId) => Executor | null;
  readonly policy: () => RepoPolicy;
  readonly allowed: BotGate;
  readonly afterProposal: () => void;
  readonly now: () => number;
}

export function registerStartTool(deps: StartToolDeps): void {
  deps.bb.agents.registerTool({
    name: START_TOOL,
    description: strings.startChatDescription,
    presentation: {
      label: { pending: strings.startChatPending, completed: strings.startChatCompleted },
      icon: { glyph: "Workflow" },
    },
    parameters: z
      .object({
        server: z.enum(["mac", "linux"]),
        projectId: z.string().min(1).max(100),
        providerId: z.string().min(1).max(100),
        model: z.string().min(1).max(100),
        prompt: z.string().min(1).max(4000),
        title: z.string().min(1).max(120).optional(),
      })
      .strict(),
    async execute(input, ctx) {
      if (!(await deps.allowed(ctx))) return refuse(strings.notMainBot);
      const executor = deps.executor(input.server);
      if (executor === null) return refuse(strings.serverNotConfigured);
      let remote: string | null;
      try {
        remote = await executor.projectRemote(input.projectId, ctx.signal);
      } catch (error) {
        return refuse(strings.projectUnknown(describeError(error)));
      }
      const repo = repoFromRemoteUrl(remote);
      if (isExcludedRepo(deps.policy(), repo)) return refuse(strings.projectExcluded);
      const now = deps.now();
      const action = deps.actions.propose(
        input.server,
        {
          projectId: input.projectId,
          providerId: input.providerId,
          model: input.model,
          prompt: input.prompt,
          title: input.title ?? input.prompt.slice(0, 80),
          repo,
        },
        ctx.threadId,
        now,
      );
      deps.questions.ask(
        {
          key: `${START_KIND}:${action.id}`,
          kind: START_KIND,
          subject: action.id,
          expectedVersion: action.state,
          card: startCard(action, repo ?? input.projectId),
          priority: 20,
        },
        now,
      );
      deps.afterProposal();
      return `Proposed as ${action.id}. The owner sees a card in this chat; nothing starts until they answer. Read the outcome later with sa_overview.`;
    },
  });
}
