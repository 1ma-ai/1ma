import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { strings } from "../strings.js";

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
      default: "control",
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
    passEnabled: {
      type: "boolean",
      label: strings.passEnabledLabel,
      description: strings.passEnabledDescription,
      default: true,
    },
  });
}

export interface Config {
  role: Role;
  linuxServerUrl: string | null;
  mainBotThreadId: string | null;
  passEnabled: boolean;
}

export function toConfig(values: {
  role: string;
  linuxServerUrl: string;
  mainBotThreadId: string;
  passEnabled: boolean;
}): Config {
  const role: Role = values.role === "executor" ? "executor" : "control";
  return {
    role,
    linuxServerUrl: values.linuxServerUrl === "" ? null : values.linuxServerUrl.replace(/\/$/, ""),
    mainBotThreadId: values.mainBotThreadId === "" ? null : values.mainBotThreadId,
    passEnabled: values.passEnabled,
  };
}
