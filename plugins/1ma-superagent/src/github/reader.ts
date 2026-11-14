import { z } from "zod";

export type GhApi = (
  path: string,
  signal: AbortSignal,
) => Promise<{ status: "ok"; body: string } | { status: "error"; message: string }>;

const pullSchema = z.object({
  number: z.number().int().positive(),
  state: z.enum(["open", "closed"]),
  merged_at: z.string().nullable().optional(),
  updated_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
    repo: z.object({ full_name: z.string() }).nullable(),
  }),
  base: z.object({ repo: z.object({ full_name: z.string() }) }),
});

export interface PullRequest {
  readonly repo: string;
  readonly number: number;
  readonly state: "open" | "closed" | "merged";
  readonly author: string | null;
  readonly headRepo: string | null;
  readonly headRef: string;
  readonly headSha: string;
  readonly updatedAt: number;
}

export class GitHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubError";
  }
}

function toPullRequest(raw: z.infer<typeof pullSchema>): PullRequest {
  return {
    repo: raw.base.repo.full_name.toLowerCase(),
    number: raw.number,
    state: raw.merged_at ? "merged" : raw.state,
    author: raw.user?.login.toLowerCase() ?? null,
    headRepo: raw.head.repo?.full_name.toLowerCase() ?? null,
    headRef: raw.head.ref,
    headSha: raw.head.sha,
    updatedAt: Date.parse(raw.updated_at),
  };
}

export interface GitHubReader {
  pull(repo: string, number: number, signal: AbortSignal): Promise<PullRequest>;
  recentPulls(
    repo: string,
    since: number,
    signal: AbortSignal,
  ): Promise<{ pulls: PullRequest[]; complete: boolean }>;
  mainHead(repo: string, signal: AbortSignal): Promise<string>;
}

export const RECENT_PAGE_SIZE = 50;
export const RECENT_MAX_PAGES = 3;

export function createGitHubReader(gh: GhApi): GitHubReader {
  async function getJson<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    const result = await gh(path, signal);
    if (result.status === "error") throw new GitHubError(`gh api ${path}: ${result.message}`);
    let json: unknown;
    try {
      json = JSON.parse(result.body);
    } catch {
      throw new GitHubError(`gh api ${path}: not JSON`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new GitHubError(`gh api ${path}: unexpected shape at ${issue?.path.join(".") ?? "?"}`);
    }
    return parsed.data;
  }

  return {
    async pull(repo, number, signal) {
      return toPullRequest(await getJson(`/repos/${repo}/pulls/${number}`, pullSchema, signal));
    },
    async mainHead(repo, signal) {
      const [head] = await getJson(
        `/repos/${repo}/commits?sha=main&per_page=1`,
        z.array(z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/) })),
        signal,
      );
      if (head === undefined) throw new GitHubError(`${repo} has no commits on main`);
      return head.sha;
    },
    async recentPulls(repo, since, signal) {
      const collect = async (
        page: number,
        found: PullRequest[],
      ): Promise<{ pulls: PullRequest[]; complete: boolean }> => {
        if (page > RECENT_MAX_PAGES) return { pulls: found, complete: false };
        const rows = await getJson(
          `/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=${RECENT_PAGE_SIZE}&page=${page}`,
          z.array(pullSchema),
          signal,
        );
        const pulls = rows.map(toPullRequest);
        const fresh = pulls.filter((pull) => pull.updatedAt >= since);
        const all = [...found, ...fresh];
        if (fresh.length < pulls.length || rows.length < RECENT_PAGE_SIZE)
          return { pulls: all, complete: true };
        return collect(page + 1, all);
      };
      return collect(1, []);
    },
  };
}
