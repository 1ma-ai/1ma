import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isMainBot, mayBeMainBot } from "./src/bot.js";
import { READ_TOOLS, registerBotReadTools } from "./src/bot-tools.js";
import { claimSelection, registerClaimTool } from "./src/claim-tool.js";
import { createLocalExecutor } from "./src/executors/local.js";
import { type GhApi, type GitHubReader, createGitHubReader } from "./src/github/reader.js";
import { hostContract } from "./src/host-contract.js";
import { createRemoteHttpExecutor } from "./src/executors/remote-http.js";
import type { Executor } from "./src/observation.js";
import { type GitHubPassState, runPass } from "./src/pass.js";
import { FULL_SCOPE, PassRunner, threadScope } from "./src/pass-runner.js";
import { QuestionDispatcher } from "./src/dispatcher.js";
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
}

export function hostGh(bb: BbPluginApi): GhApi {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  let hostId: string | null = null;
  return async (path, signal) => {
    if (hostId === null) {
      hostId = (await bb.sdk.system.config({ signal })).primaryHostId;
      if (hostId === null)
        return { status: "error", message: "this server has no primary machine to run gh on" };
    }
    return host.call("ghApi", { path }, { hostId, signal });
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
    const prStore = new PrStore(db);
    const policy = () => repoPolicy(config.repos, config.excludedRepos);
    const gh = (options.gh ?? hostGh)(bb);
    const github: GitHubReader = createGitHubReader(gh);
    const questions = new QuestionStore(db);
    const kinds = new Map<string, QuestionKind>([[UNLINKED_KIND, unlinkedKind(prStore)]]);
    const handlers = workRpcHandlers(
      store,
      prStore,
      questions,
      async () => (await bb.storage.kv.get<GitHubPassState>(GITHUB_STATE_KEY)) ?? null,
    );
    bb.rpc.register(workRpcContract, handlers);

    const lifecycle = new AbortController();
    const dispatcher = new QuestionDispatcher({
      bb,
      store: questions,
      kinds,
      chat: () => (config.role === "control" ? config.mainBotThreadId : null),
      now: Date.now,
      onAnswered: () => void runner.request(FULL_SCOPE),
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
            afterFullPass: (now) => {
              askAboutUnlinked(prStore, questions, policy(), now);
              dispatcher.dispatch();
            },
            now: Date.now,
            signal: lifecycle.signal,
          },
          scope,
        ),
      (error) =>
        bb.log.error(`pass failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    bb.onDispose(() => {
      lifecycle.abort();
      runner.dispose();
    });

    const isControl = () => config.role === "control";

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
    registerBotReadTools(
      bb,
      {
        list: () => handlers["work.v1.list"]({ limit: 200 }),
        waiting: async () => handlers["work.v1.waiting"](),
        pullRequests: () => handlers["work.v1.pullRequests"]({}),
      },
      async (threadId) => isControl() && (await isMainBot(bb, threadId, config.mainBotThreadId)),
    );
    bb.agents.configure((context) => {
      const claim = claimSelection(policy(), context.project.gitRemoteUrl);
      const bot =
        isControl() &&
        mayBeMainBot(
          { threadId: context.thread.id, originPluginId: context.origin.pluginId },
          config.mainBotThreadId,
        );
      const tools = [...claim.tools, ...(bot ? READ_TOOLS : [])];
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
