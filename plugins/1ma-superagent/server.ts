import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { type BotGate, isBotChat } from "./src/bot.js";
import { READ_TOOLS, registerBotReadTools } from "./src/bot-tools.js";
import { claimSelection, registerClaimTool } from "./src/claim-tool.js";
import { createLocalExecutor } from "./src/executors/local.js";
import { type GhApi, type GitHubReader, createGitHubReader } from "./src/github/reader.js";
import { hostContract } from "./src/host-contract.js";
import { createRemoteHttpExecutor } from "./src/executors/remote-http.js";
import type { Executor } from "./src/observation.js";
import { type GitHubPassState, runPass } from "./src/pass.js";
import { FULL_SCOPE, PassRunner, threadScope } from "./src/pass-runner.js";
import { randomUUID } from "node:crypto";
import {
  AMBIGUOUS_KIND,
  NOTICE_KIND,
  START_KIND,
  UNKNOWN_KIND,
  ambiguousKind,
  noticeKind,
  runActions,
  startKind,
  unknownKind,
} from "./src/action-runner.js";
import { ActionStore } from "./src/actions.js";
import { createBackground } from "./src/background.js";
import { questionRpcContract } from "./src/card.js";
import { QuestionDispatcher } from "./src/dispatcher.js";
import {
  BYPASS_KIND,
  JOURNAL_STATE_KEY,
  type JournalObservation,
  type ReadJournal,
  mainWatchRows,
  runMainWatch,
} from "./src/main-watch.js";
import { runSteps } from "./src/pass-steps.js";
import { RESULT_KIND, runReports } from "./src/reports.js";
import { START_TOOL, registerStartTool } from "./src/start-tool.js";
import { UNLINKED_KIND, askAboutUnlinked, unlinkedKind } from "./src/kinds/unlinked-pr.js";
import { PrStore } from "./src/pr-store.js";
import { type QuestionKind, QuestionStore } from "./src/questions.js";
import { repoPolicy } from "./src/repos.js";
import { MIGRATIONS } from "./src/schema.js";
import { type Config, defineSettings, reposProblem, toConfig } from "./src/settings.js";
import { Store } from "./src/store.js";
import { strings } from "./strings.js";
import { workRpcContract, workRpcHandlers } from "./src/work-rpc.js";

export const PASS_SCHEDULE_NAME = "pass";
export const PASS_SCHEDULE_CRON = "* * * * *";
export const STARTUP_SERVICE_NAME = "startup-pass";

export const GITHUB_STATE_KEY = "github-pass";

export interface SuperagentOptions {
  readonly executors?: (config: Config, bb: BbPluginApi) => readonly Executor[];
  readonly gh?: (bb: BbPluginApi) => GhApi;
  readonly readJournal?: (bb: BbPluginApi) => ReadJournal;
}

function primaryHost(bb: BbPluginApi): (signal: AbortSignal) => Promise<string | null> {
  let hostId: string | null = null;
  return async (signal) => {
    if (hostId === null) hostId = (await bb.sdk.system.config({ signal })).primaryHostId;
    return hostId;
  };
}

type HostClient = ReturnType<typeof hostClient>;

function hostClient(bb: BbPluginApi) {
  return bb.hosts.experimental_client({ contract: hostContract });
}

export function hostJournal(bb: BbPluginApi, host: HostClient): ReadJournal {
  const hostId = primaryHost(bb);
  return async (signal) => {
    const id = await hostId(signal);
    if (id === null)
      return {
        status: "error",
        message: "this server has no primary machine to read the journal on",
      };
    return host.call("readJournal", {}, { hostId: id, signal });
  };
}

export function hostGh(bb: BbPluginApi, host: HostClient): GhApi {
  const hostId = primaryHost(bb);
  return async (request, signal) => {
    const id = await hostId(signal);
    if (id === null)
      return { status: "error", message: "this server has no primary machine to run gh on" };
    return host.call("gh", request, { hostId: id, signal });
  };
}

export function defaultExecutors(config: Config, bb: BbPluginApi): readonly Executor[] {
  const local = createLocalExecutor(bb.sdk);
  if (config.linuxServerUrl === null) return [local];
  return [local, createRemoteHttpExecutor({ serverId: "linux", baseUrl: config.linuxServerUrl })];
}

export function createPlugin(options: SuperagentOptions = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = defineSettings(bb);
    const initial = await settings.get();
    let config = toConfig(initial);
    const warnRepos = (raw: string) => {
      const problem = reposProblem(raw);
      if (problem !== null) bb.log.warn(`watched repositories setting ignored: ${problem}`);
    };
    warnRepos(initial.repos);
    settings.onChange((next) => {
      config = toConfig(next);
      warnRepos(next.repos);
    });

    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const store = new Store(db);
    const policy = () => repoPolicy(config.repos, config.excludedRepos);
    const prStore = new PrStore(db, policy);
    const host = hostClient(bb);
    const gh = options.gh?.(bb) ?? hostGh(bb, host);
    const github: GitHubReader = createGitHubReader(gh);
    const questions = new QuestionStore(db);
    const actions = new ActionStore(db);
    const claimant = `gen_${randomUUID()}`;
    const kinds = new Map<string, QuestionKind>([
      [UNLINKED_KIND, unlinkedKind(prStore, store)],
      [START_KIND, startKind(actions)],
      [UNKNOWN_KIND, unknownKind(actions)],
      [AMBIGUOUS_KIND, ambiguousKind()],
      [NOTICE_KIND, noticeKind()],
      [RESULT_KIND, noticeKind()],
      [BYPASS_KIND, noticeKind()],
    ]);
    const readJournal = options.readJournal?.(bb) ?? hostJournal(bb, host);
    const handlers = workRpcHandlers(
      store,
      prStore,
      questions,
      () => mainWatchRows(db),
      async () => (await bb.storage.kv.get<GitHubPassState>(GITHUB_STATE_KEY)) ?? null,
      actions,
      async () => (await bb.storage.kv.get<JournalObservation>(JOURNAL_STATE_KEY)) ?? null,
    );
    bb.rpc.register(workRpcContract, handlers);

    const lifecycle = new AbortController();
    const background = createBackground();
    const dispatcher = new QuestionDispatcher({
      requestInput: (request, requestOptions) => bb.ui.requestInput(request, requestOptions),
      warn: (message) => bb.log.warn(message),
      background,
      store: questions,
      kinds,
      chat: () => (config.role === "control" ? config.mainBotThreadId : null),
      now: Date.now,
      onAnswered: () => afterAnswer(),
      signal: lifecycle.signal,
    });
    const executorsFor = options.executors ?? defaultExecutors;
    const runner = new PassRunner(
      (scope) =>
        runPass(
          {
            store,
            prStore,
            executors: () => executorsFor(config, bb),
            github: () => github,
            policy,
            mainBotThreadId: () => config.mainBotThreadId,
            recordGitHub: (state) => bb.storage.kv.set(GITHUB_STATE_KEY, state),
            afterFullPass: (now, executors, observed) =>
              runSteps(
                [
                  [
                    "unlinked PR questions",
                    () => askAboutUnlinked(prStore, questions, policy(), now),
                  ],
                  [
                    "bot actions",
                    () =>
                      runActions({
                        actions,
                        questions,
                        executors,
                        observed,
                        policy: policy(),
                        claimant,
                        now: Date.now,
                        signal: lifecycle.signal,
                        warn: (message) => bb.log.warn(message),
                      }),
                  ],
                  [
                    "check of main",
                    async () => {
                      const problems = await runMainWatch({
                        db,
                        github,
                        readJournal,
                        enabled: config.mainCheckEnabled,
                        policy: policy(),
                        questions,
                        now,
                        signal: lifecycle.signal,
                        recordJournal: (observation) =>
                          bb.storage.kv.set(JOURNAL_STATE_KEY, observation),
                      });
                      for (const problem of problems) bb.log.warn(problem);
                    },
                  ],
                  [
                    "task results",
                    () =>
                      runReports({
                        db,
                        store,
                        actions,
                        questions,
                        executors,
                        observed,
                        now: Date.now(),
                        signal: lifecycle.signal,
                        warn: (message) => bb.log.warn(message),
                      }),
                  ],
                  ["questions", () => dispatcher.dispatch()],
                ],
                (message) => bb.log.warn(message),
              ),
            now: Date.now,
            signal: lifecycle.signal,
          },
          scope,
        ),
      (error) =>
        bb.log.error(`pass failed: ${error instanceof Error ? error.message : String(error)}`),
      background,
    );
    bb.onDispose(async () => {
      lifecycle.abort();
      await runner.dispose();
    });

    const isControl = () => config.role === "control";
    const afterAnswer = () => {
      if (isControl() && config.passEnabled) void runner.request(FULL_SCOPE);
    };
    bb.rpc.register(questionRpcContract, {
      "questions.v1.decide": ({ questionId, token, optionId }) => {
        const outcome = questions.answer(questionId, token, optionId, kinds, Date.now());
        if (outcome === "applied") afterAnswer();
        return { outcome };
      },
      "questions.v1.state": ({ questionId, token }) => questions.cardState(questionId, token),
    });

    bb.background.schedule(PASS_SCHEDULE_NAME, PASS_SCHEDULE_CRON, async () => {
      if (!isControl() || !config.passEnabled) return;
      await runner.request(FULL_SCOPE);
    });

    bb.background.service(STARTUP_SERVICE_NAME, {
      async start(signal) {
        if (isControl() && config.passEnabled) await runner.request(FULL_SCOPE);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    const onLocalThread = ({ thread }: { thread: { id: string } }) => {
      if (!isControl()) return;
      void runner.request(threadScope("mac", thread.id));
    };
    bb.events.on("thread.created", onLocalThread);
    bb.events.on("thread.idle", onLocalThread);
    bb.events.on("thread.failed", onLocalThread);
    bb.events.on("thread.archived", onLocalThread);
    bb.events.on("thread.unarchived", onLocalThread);
    bb.events.on("thread.deleted", onLocalThread);
    bb.events.on("interaction.pending", onLocalThread);

    registerClaimTool(bb, policy, (threadId) => {
      if (isControl()) void runner.request(threadScope("mac", threadId));
    });
    const botAllowed: BotGate = async ({ threadId, projectId, signal }) => {
      if (!isControl() || threadId !== config.mainBotThreadId) return false;
      try {
        const project = await bb.sdk.projects.get({ projectId, signal });
        return isBotChat(
          { threadId, gitRemoteUrl: project.gitRemoteUrl },
          config.mainBotThreadId,
          policy(),
        );
      } catch {
        return false;
      }
    };
    registerBotReadTools(
      bb,
      {
        list: () => handlers["work.v1.list"]({ limit: 200 }),
        waiting: async () => handlers["work.v1.waiting"](),
        pullRequests: () => handlers["work.v1.pullRequests"]({}),
        botTasks: () =>
          actions.recent(20).map((action) => ({
            id: action.id,
            server: action.serverId,
            state: action.state,
            chat: action.threadId === null ? null : `${action.serverId}:${action.threadId}`,
            updatedAt: action.updatedAt,
          })),
      },
      botAllowed,
    );
    registerStartTool({
      bb,
      actions,
      questions,
      executor: (serverId) =>
        executorsFor(config, bb).find((candidate) => candidate.serverId === serverId) ?? null,
      policy,
      allowed: botAllowed,
      afterProposal: () => dispatcher.dispatch(),
      now: Date.now,
    });
    bb.agents.configure((context) => {
      const claim = claimSelection(policy(), context.project.gitRemoteUrl);
      const bot =
        isControl() &&
        isBotChat(
          { threadId: context.thread.id, gitRemoteUrl: context.project.gitRemoteUrl },
          config.mainBotThreadId,
          policy(),
        );
      const tools = [...claim.tools, ...(bot ? [...READ_TOOLS, START_TOOL] : [])];
      const instructions = [claim.instructions, bot ? strings.botInstruction : undefined].filter(
        (value): value is string => value !== undefined,
      );
      return {
        tools,
        skills: [],
        ...(instructions.length === 0 ? {} : { instructions: instructions.join("\n") }),
      };
    });
  };
}

export default createPlugin();
