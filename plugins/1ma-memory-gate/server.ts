import { cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { memoryHostContract } from "./contract.js";
import {
  createGate,
  freeBytes,
  hostLabel,
  isNewTurnOnHost,
  READING_GRACE_MS,
  type DispatchQuestion,
  type GateSettings,
  type Sample,
} from "./gate.js";
import { createSampler, READ_TIMEOUT_MS } from "./sampler.js";
import { strings } from "./strings.js";

export const SAMPLER_NAME = "memory-sampler";

const RUNNING_TIMEOUT_MS = 2_000;
const MAX_STATUS_HOSTS = 50;
const RECHECK_EVENTS = [
  "thread.idle",
  "thread.failed",
  "thread.archived",
  "thread.deleted",
] as const;

const DEFAULTS = { enabled: true, reserveMb: 600, pressurePercent: 10, minRunning: 1 };
const reserveMbSchema = z.number().int().min(64).max(65536);
const pressurePercentSchema = z.number().int().min(1).max(100);
const minRunningSchema = z.number().int().min(0).max(100);

const storedSettingsSchema = z.object({
  enabled: z.boolean().catch(DEFAULTS.enabled),
  reserveMb: reserveMbSchema.catch(DEFAULTS.reserveMb),
  pressurePercent: pressurePercentSchema.catch(DEFAULTS.pressurePercent),
  minRunning: minRunningSchema.catch(DEFAULTS.minRunning),
});

type StoredSettings = z.infer<typeof storedSettingsSchema>;

function gateSettings(stored: StoredSettings): GateSettings {
  return {
    enabled: stored.enabled,
    reserveBytes: stored.reserveMb * 2 ** 20,
    pressurePercent: stored.pressurePercent,
    minRunning: stored.minRunning,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readingLine(sample: Sample | undefined): string {
  if (sample === undefined) return strings.statusNoReading;
  if (!sample.reading.supported) return strings.statusUnsupported;
  return strings.statusReading(
    freeBytes(sample.reading),
    sample.reading.pressureFullAvg10,
    Math.max(0, Math.round((Date.now() - sample.takenAt) / 1000)),
  );
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    enabled: {
      type: "boolean",
      label: strings.enabledLabel,
      description: strings.enabledDescription,
      default: DEFAULTS.enabled,
    },
    reserveMb: {
      type: "number",
      label: strings.reserveMbLabel,
      description: strings.reserveMbDescription,
      experimental_schema: reserveMbSchema,
      default: DEFAULTS.reserveMb,
    },
    pressurePercent: {
      type: "number",
      label: strings.pressurePercentLabel,
      description: strings.pressurePercentDescription,
      experimental_schema: pressurePercentSchema,
      default: DEFAULTS.pressurePercent,
    },
    minRunning: {
      type: "number",
      label: strings.minRunningLabel,
      description: strings.minRunningDescription,
      experimental_schema: minRunningSchema,
      default: DEFAULTS.minRunning,
    },
  });
  const client = bb.hosts.experimental_client({ contract: memoryHostContract });
  const gate = createGate(() => Date.now());
  const sampler = createSampler({
    now: () => Date.now(),
    connectedHosts: async (signal) =>
      (await bb.sdk.hosts.list({ signal }))
        .filter((host) => host.status === "connected")
        .map((host) => ({ id: host.id, name: host.name })),
    read: (hostId, signal) =>
      client.call("readMemory", null, { hostId, signal, timeoutMs: READ_TIMEOUT_MS }),
    warn: (message) => bb.log.warn(message),
  });

  async function currentSettings(): Promise<StoredSettings> {
    return storedSettingsSchema.parse(await settings.get());
  }

  async function runningOn(hostId: string): Promise<string[]> {
    const running = await bb.sdk.threads.listRunning({
      signal: AbortSignal.timeout(RUNNING_TIMEOUT_MS),
    });
    return running.filter((thread) => thread.hostId === hostId).map((thread) => thread.id);
  }

  function recheck(): void {
    bb.experimental_hooks.recheck("message.dispatch").catch((error: unknown) => {
      bb.log.warn(`could not re-attempt held turns: ${errorMessage(error)}`);
    });
  }

  bb.background.service(SAMPLER_NAME, {
    async start(signal) {
      const unsubscribe = bb.sdk.subscribe({
        event: "host:changed",
        callback: (event) => {
          if (event.changes.includes("host-connected")) sampler.requestRefresh();
        },
      });
      try {
        await sampler.run(signal);
      } finally {
        unsubscribe();
      }
    },
  });

  settings.onChange(() => recheck());
  for (const event of RECHECK_EVENTS) bb.events.on(event, () => recheck());

  bb.experimental_hooks.on("message.dispatch", async (context) => {
    try {
      const question: DispatchQuestion = {
        attempt: context.attempt,
        threadId: context.thread.id,
        threadStatus: context.thread.status,
        host: context.host === null ? null : { id: context.host.id, name: context.host.name },
      };
      if (!isNewTurnOnHost(question)) return { action: "proceed" };
      const stored = await currentSettings();
      if (!stored.enabled) return { action: "proceed" };
      const verdict = gate.answer({
        question,
        settings: gateSettings(stored),
        sample: sampler.get(question.host.id),
        runningOnHost: await runningOn(question.host.id),
      });
      if (verdict.action === "proceed") {
        if (verdict.why === "reading-unavailable")
          bb.log.warn(
            `no memory reading from ${hostLabel(question.host)} for ${String(READING_GRACE_MS / 1000)} s, the turn goes ahead unchecked`,
          );
        return { action: "proceed" };
      }
      if (verdict.why === "no-reading") sampler.requestRefresh();
      return { action: "wait", reason: verdict.reason, sendAt: Date.now() + verdict.retryInMs };
    } catch (error) {
      bb.log.warn(`memory check failed, the turn goes ahead: ${errorMessage(error)}`);
      return { action: "proceed" };
    }
  });

  bb.cli.register(
    defineCli({
      name: "memory-gate",
      summary: strings.cliSummary,
      description: strings.cliDescription,
      commands: {
        status: cliCommand({
          summary: strings.statusSummary,
          options: { json: { type: "boolean", description: strings.jsonOption } },
          async run(input) {
            const stored = await currentSettings();
            const [hosts, running] = await Promise.all([
              bb.sdk.hosts.list(),
              bb.sdk.threads.listRunning(),
            ]);
            const shown = hosts.slice(0, MAX_STATUS_HOSTS).map((host) => {
              const gateHost = { id: host.id, name: hostLabel({ id: host.id, name: host.name }) };
              const sample = sampler.get(host.id);
              const verdict = gate.preview({
                question: {
                  attempt: "start-turn",
                  threadId: "",
                  threadStatus: "idle",
                  host: gateHost,
                },
                settings: gateSettings(stored),
                sample,
                runningOnHost: running
                  .filter((thread) => thread.hostId === host.id)
                  .map((thread) => thread.id),
              });
              return { host: gateHost, status: host.status, sample, verdict };
            });
            if (input.options.json)
              return {
                exitCode: 0,
                stdout: JSON.stringify({
                  settings: stored,
                  hosts: shown.map(({ host, status, sample, verdict }) => ({
                    id: host.id,
                    name: host.name,
                    status,
                    reading: sample?.reading ?? null,
                    ageMs: sample === undefined ? null : Date.now() - sample.takenAt,
                    answer:
                      verdict.action === "proceed"
                        ? { action: "start", why: verdict.why }
                        : { action: "wait", why: verdict.why, reason: verdict.reason },
                  })),
                }),
              };
            const lines = shown.map(({ host, status, sample, verdict }) =>
              strings.statusHostLine(
                host.name,
                status,
                readingLine(sample),
                verdict.action === "wait"
                  ? strings.statusWait(verdict.reason)
                  : verdict.why === "reading-unavailable"
                    ? strings.statusStartUnchecked
                    : strings.statusStart,
              ),
            );
            return {
              exitCode: 0,
              stdout: [
                strings.statusSettings(
                  stored.enabled,
                  stored.reserveMb,
                  stored.pressurePercent,
                  stored.minRunning,
                ),
                ...(lines.length === 0 ? [strings.statusNoHosts] : lines),
                ...(hosts.length > MAX_STATUS_HOSTS
                  ? [strings.statusMoreHosts(hosts.length - MAX_STATUS_HOSTS)]
                  : []),
              ].join("\n"),
            };
          },
        }),
      },
    }),
  );
}
