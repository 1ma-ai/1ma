import { describe, expect, it } from "vitest";
import { RECENT_PAGE_SIZE, createGitHubReader } from "./reader.js";

function apiPull(number: number, updatedAt: string, overrides: Record<string, unknown> = {}) {
  return {
    number,
    state: "open",
    merged_at: null,
    updated_at: updatedAt,
    user: { login: "Mac-Bot" },
    head: { ref: `feature/${number}`, sha: `sha${number}`, repo: { full_name: "Example/App" } },
    base: { repo: { full_name: "Example/App" } },
    ...overrides,
  };
}

describe("GitHub reader", () => {
  it("reads a merged PR with its head and author", async () => {
    const reader = createGitHubReader(async () => ({
      status: "ok",
      body: JSON.stringify(
        apiPull(3, "2026-11-14T10:00:00Z", { state: "closed", merged_at: "2026-11-14T10:00:00Z" }),
      ),
    }));
    expect(await reader.pull("example/app", 3, new AbortController().signal)).toEqual({
      repo: "example/app",
      number: 3,
      state: "merged",
      author: "mac-bot",
      headRepo: "example/app",
      headRef: "feature/3",
      headSha: "sha3",
      updatedAt: Date.parse("2026-11-14T10:00:00Z"),
    });
  });

  it("stops listing recent PRs at the first one older than the cursor", async () => {
    const paths: string[] = [];
    const page1 = Array.from({ length: RECENT_PAGE_SIZE }, (_, index) =>
      apiPull(100 - index, "2026-11-14T10:00:00Z"),
    );
    const page2 = [apiPull(50, "2026-11-14T09:00:00Z"), apiPull(49, "2026-11-01T00:00:00Z")];
    const reader = createGitHubReader(async (path) => {
      paths.push(path);
      return { status: "ok", body: JSON.stringify(path.endsWith("page=1") ? page1 : page2) };
    });
    const result = await reader.recentPulls(
      "example/app",
      Date.parse("2026-11-10T00:00:00Z"),
      new AbortController().signal,
    );
    expect(result.complete).toBe(true);
    expect(result.pulls.map((pull) => pull.number)).toContain(50);
    expect(result.pulls.map((pull) => pull.number)).not.toContain(49);
    expect(paths).toHaveLength(2);
  });

  it("turns a gh failure and an unexpected answer into errors", async () => {
    const failing = createGitHubReader(async () => ({ status: "error", message: "HTTP 404" }));
    await expect(failing.pull("example/app", 1, new AbortController().signal)).rejects.toThrow(
      "HTTP 404",
    );
    const odd = createGitHubReader(async () => ({ status: "ok", body: '{"number": "one"}' }));
    await expect(odd.pull("example/app", 1, new AbortController().signal)).rejects.toThrow(
      "unexpected shape",
    );
  });
});
