const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function isRepoName(value: string): boolean {
  return REPO.test(value);
}

export function repoFromRemoteUrl(url: string | null): string | null {
  if (url === null) return null;
  const trimmed = url.trim();
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      const name = `${match[1]}/${match[2]}`.toLowerCase();
      return isRepoName(name) ? name : null;
    }
  }
  return null;
}

export interface PullRequestRef {
  readonly repo: string;
  readonly number: number;
}

export function parsePullRequestUrl(url: string): PullRequestRef | null {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)\/?(?:[#?].*)?$/i.exec(
    url.trim(),
  );
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const repo = match[1].toLowerCase();
  const number = Number.parseInt(match[2], 10);
  if (!isRepoName(repo) || !Number.isSafeInteger(number) || number <= 0) return null;
  return { repo, number };
}
