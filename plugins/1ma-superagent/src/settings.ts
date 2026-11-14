import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strings } from "../strings.js";
import { type ConnectedRepo, parseExcludedSetting, parseReposSetting } from "./repos.js";

export const ROLES = ["control", "executor"] as const;
export type Role = (typeof ROLES)[number];

const serverUrlSchema = z.string().refine((value) => {
  if (value === "") return true;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, strings.invalidServerUrl);

const threadIdSchema = z
  .string()
  .refine((value) => value === "" || /^thr_[a-z0-9]+$/.test(value), strings.invalidThreadId);

export function defineSettings(bb: BbPluginApi) {
  return bb.settings.define({
    role: {
      type: "select",
      label: strings.roleLabel,
      description: strings.roleDescription,
      options: [...ROLES],
      default: "executor",
    },
    linuxServerUrl: {
      type: "string",
      label: strings.linuxServerUrlLabel,
      description: strings.linuxServerUrlDescription,
      experimental_schema: serverUrlSchema,
      default: "",
    },
    mainBotThreadId: {
      type: "string",
      label: strings.mainBotThreadIdLabel,
      description: strings.mainBotThreadIdDescription,
      experimental_schema: threadIdSchema,
      default: "",
    },
    repos: {
      type: "string",
      label: strings.reposLabel,
      description: strings.reposDescription,
      experimental_multiline: true,
      experimental_schema: z.string().superRefine((value, ctx) => {
        const parsed = parseReposSetting(value);
        if (typeof parsed === "string")
          ctx.addIssue({ code: "custom", message: strings.invalidRepos(parsed) });
      }),
      default: "[]",
    },
    excludedRepos: {
      type: "string",
      label: strings.excludedReposLabel,
      description: strings.excludedReposDescription,
      default: "",
    },
    trainJournalPath: {
      type: "string",
      label: strings.trainJournalPathLabel,
      description: strings.trainJournalPathDescription,
      experimental_schema: z
        .string()
        .refine(
          (value) => value === "" || /^\/.+\.jsonl$/.test(value),
          "use an absolute path to a .jsonl file",
        ),
      default: "",
    },
    passEnabled: {
      type: "boolean",
      label: strings.passEnabledLabel,
      description: strings.passEnabledDescription,
      default: true,
    },
  });
}

export function reposProblem(raw: string): string | null {
  const parsed = parseReposSetting(raw);
  return typeof parsed === "string" ? parsed : null;
}

export interface Config {
  role: Role;
  linuxServerUrl: string | null;
  mainBotThreadId: string | null;
  repos: readonly ConnectedRepo[];
  excludedRepos: readonly string[];
  trainJournalPath: string | null;
  passEnabled: boolean;
}

export function toConfig(values: {
  role: string;
  linuxServerUrl: string;
  mainBotThreadId: string;
  repos: string;
  excludedRepos: string;
  trainJournalPath: string;
  passEnabled: boolean;
}): Config {
  const repos = parseReposSetting(values.repos);
  const role: Role = values.role === "control" ? "control" : "executor";
  return {
    role,
    linuxServerUrl: values.linuxServerUrl === "" ? null : values.linuxServerUrl.replace(/\/$/, ""),
    mainBotThreadId: values.mainBotThreadId === "" ? null : values.mainBotThreadId,
    repos: typeof repos === "string" ? [] : repos,
    excludedRepos: parseExcludedSetting(values.excludedRepos),
    trainJournalPath: values.trainJournalPath === "" ? null : values.trainJournalPath,
    passEnabled: values.passEnabled,
  };
}
