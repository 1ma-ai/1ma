import { z } from "zod";
import { isRepoName } from "./github/names.js";
import type { ServerId } from "./observation.js";

const repoName = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .refine(isRepoName, "use owner/name");

const accounts = z.array(z.string().min(1).max(100)).max(20);

export const reposSettingSchema = z
  .array(
    z
      .object({
        repo: repoName,
        accounts: z
          .object({ mac: accounts.optional(), linux: accounts.optional() })
          .strict()
          .optional(),
      })
      .strict(),
  )
  .max(50);

export interface ConnectedRepo {
  readonly repo: string;
  readonly accounts: Readonly<Record<ServerId, readonly string[]>>;
}

export interface RepoPolicy {
  readonly connected: ReadonlyMap<string, ConnectedRepo>;
  readonly excluded: ReadonlySet<string>;
}

export function parseReposSetting(raw: string): ConnectedRepo[] | string {
  let json: unknown;
  try {
    json = JSON.parse(raw === "" ? "[]" : raw);
  } catch {
    return "not valid JSON";
  }
  const parsed = reposSettingSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return `${issue?.path.join(".") ?? ""}: ${issue?.message ?? "invalid"}`;
  }
  return parsed.data.map((entry) => ({
    repo: entry.repo,
    accounts: {
      mac: (entry.accounts?.mac ?? []).map((login) => login.toLowerCase()),
      linux: (entry.accounts?.linux ?? []).map((login) => login.toLowerCase()),
    },
  }));
}

export function parseExcludedSetting(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value !== "");
}

export function repoPolicy(
  connected: readonly ConnectedRepo[],
  excluded: readonly string[],
): RepoPolicy {
  const excludedSet = new Set(excluded);
  return {
    connected: new Map(
      connected.filter((entry) => !excludedSet.has(entry.repo)).map((entry) => [entry.repo, entry]),
    ),
    excluded: excludedSet,
  };
}

export function isWatchedRepo(policy: RepoPolicy, repo: string | null): repo is string {
  return repo !== null && !policy.excluded.has(repo) && policy.connected.has(repo);
}
