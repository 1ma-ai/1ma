import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createLocalExecutor } from "./src/executors/local.js";
import { createRemoteHttpExecutor } from "./src/executors/remote-http.js";
import type { Executor } from "./src/observation.js";
import { runPass } from "./src/pass.js";
import { FULL_SCOPE, PassRunner, threadScope } from "./src/pass-runner.js";
import { MIGRATIONS } from "./src/schema.js";
import { type Config, defineSettings, toConfig } from "./src/settings.js";
import { Store } from "./src/store.js";
import { workRpcContract, workRpcHandlers } from "./src/work-rpc.js";

export const PASS_SCHEDULE_NAME = "pass";
export const PASS_SCHEDULE_CRON = "* * * * *";
export const STARTUP_SERVICE_NAME = "startup-pass";

export interface SuperagentOptions {
  readonly executors?: (config: Config, bb: BbPluginApi) => readonly Executor[];
}

export function defaultExecutors(config: Config, bb: BbPluginApi): readonly Executor[] {
  const local = createLocalExecutor(bb.sdk);
  if (config.linuxServerUrl === null) return [local];
  return [local, createRemoteHttpExecutor({ serverId: "linux", baseUrl: config.linuxServerUrl })];
}

export function createPlugin(options: SuperagentOptions = {}) {
  return async function plugin(bb: BbPluginApi): Promise<void> {
    const settings = defineSettings(bb);
    let config = toConfig(await settings.get());
    settings.onChange((next) => {
      config = toConfig(next);
    });

    const db = bb.storage.database();
    bb.storage.migrate(db, MIGRATIONS);
    const store = new Store(db);
    bb.rpc.register(workRpcContract, workRpcHandlers(store));

    const lifecycle = new AbortController();
    const executorsFor = options.executors ?? defaultExecutors;
    const runner = new PassRunner(
      (scope) =>
        runPass(
          {
            store,
            executors: () => executorsFor(config, bb),
            mainBotThreadId: () => config.mainBotThreadId,
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
  };
}

export default createPlugin();
