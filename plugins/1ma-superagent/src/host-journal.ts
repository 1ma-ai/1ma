import { constants } from "node:fs";
import { open, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { JOURNAL_TAIL_BYTES, type JournalTail } from "./host-contract.js";

export const HOST_SETTINGS_FILE = "settings.json";

const hostSettingsSchema = z
  .object({
    trainJournal: z
      .string()
      .refine((value) => isAbsolute(value) && value.endsWith(".jsonl"))
      .optional(),
  })
  .strict();

function errorCode(error: unknown): string | null {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

async function configuredJournal(dataDir: string): Promise<string | null | { problem: string }> {
  let raw: string;
  try {
    raw = await readFile(join(dataDir, HOST_SETTINGS_FILE), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    return { problem: `host settings unreadable (${errorCode(error) ?? "error"})` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { problem: "host settings are not JSON" };
  }
  const parsed = hostSettingsSchema.safeParse(json);
  if (!parsed.success)
    return { problem: "host settings: trainJournal must be an absolute path to a .jsonl file" };
  return parsed.data.trainJournal ?? null;
}

export async function readTrainJournal(dataDir: string): Promise<JournalTail> {
  const configured = await configuredJournal(dataDir);
  if (configured === null) return { status: "unconfigured" };
  if (typeof configured !== "string") return { status: "error", message: configured.problem };
  let real: string;
  let allowedDir: string;
  try {
    allowedDir = await realpath(dirname(configured));
    real = await realpath(configured);
  } catch (error) {
    return { status: "error", message: `train journal not found (${errorCode(error) ?? "error"})` };
  }
  if (dirname(real) !== allowedDir || !basename(real).endsWith(".jsonl"))
    return { status: "error", message: "train journal resolves outside its directory" };
  try {
    const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        return { status: "error", message: "train journal is not a regular file" };
      const start = Math.max(0, stat.size - JOURNAL_TAIL_BYTES);
      const buffer = Buffer.alloc(stat.size - start);
      await file.read(buffer, 0, buffer.length, start);
      const text = buffer.toString("utf8");
      return {
        status: "ok",
        text: start === 0 ? text : text.slice(text.indexOf("\n") + 1),
        truncated: start > 0,
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    return {
      status: "error",
      message: `train journal unreadable (${errorCode(error) ?? "error"})`,
    };
  }
}
