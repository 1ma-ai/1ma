import { describe, expect, it } from "vitest";
import { type Claim, type ClaimingChat, addClaim, checkClaim, readClaims } from "./claims.js";
import type { PullRequest } from "./github/reader.js";
import { repoPolicy } from "./repos.js";

const policy = repoPolicy(
  [
    { repo: "example/app", accounts: { mac: ["mac-bot"], linux: ["linux-bot"] } },
    { repo: "example/private", accounts: { mac: ["mac-bot"], linux: ["linux-bot"] } },
  ],
  ["example/private"],
);

const pull: PullRequest = {
  repo: "example/app",
  number: 7,
  state: "open",
  author: "linux-bot",
  headRepo: "example/app",
  headRef: "feature/x",
  headSha: "abc",
  updatedAt: 1,
};

const claim: Claim = { repo: "example/app", number: 7, branch: "feature/x", claimedAt: 1 };
const chat: ClaimingChat = { serverId: "linux", threadId: "thr_1", projectRepo: "example/app" };

describe("checkClaim", () => {
  it("accepts a claim from the chat of the PR's project, on its branch, pushed by the server's account", () => {
    expect(checkClaim(policy, chat, claim, pull)).toEqual({ ok: true });
  });

  it("refuses a claim from a chat of an excluded project", () => {
    const verdict = checkClaim(policy, { ...chat, projectRepo: "example/private" }, claim, pull);
    expect(verdict).toEqual({ ok: false, problem: "the chat belongs to an excluded project" });
  });

  it("refuses a claim from a chat whose project is not the PR's repository", () => {
    const verdict = checkClaim(policy, { ...chat, projectRepo: "example/other" }, claim, pull);
    expect(verdict).toEqual({
      ok: false,
      problem: "the chat's project is not the pull request's repository",
    });
  });

  it("refuses a claim on a PR of an excluded project", () => {
    const excludedPull = { ...pull, repo: "example/private", headRepo: "example/private" };
    const verdict = checkClaim(
      policy,
      { ...chat, projectRepo: "example/private" },
      { ...claim, repo: "example/private" },
      excludedPull,
    );
    expect(verdict.ok).toBe(false);
  });

  it("refuses a PR from a fork, a foreign account or another branch", () => {
    expect(checkClaim(policy, chat, claim, { ...pull, headRepo: "someone/app" }).ok).toBe(false);
    expect(checkClaim(policy, chat, claim, { ...pull, author: "mac-bot" })).toEqual({
      ok: false,
      problem: "the pull request author is not a GitHub account of the linux server",
    });
    expect(checkClaim(policy, chat, { ...claim, branch: "main" }, pull).ok).toBe(false);
    expect(checkClaim(policy, chat, { ...claim, branch: null }, pull).ok).toBe(false);
  });

  it("refuses a repository that is not watched", () => {
    const other = { ...pull, repo: "example/other", headRepo: "example/other" };
    const verdict = checkClaim(
      policy,
      { ...chat, projectRepo: "example/other" },
      { ...claim, repo: "example/other" },
      other,
    );
    expect(verdict).toEqual({ ok: false, problem: "the repository is not watched" });
  });
});

describe("claims metadata", () => {
  it("ignores metadata of another shape and keeps one claim per PR", () => {
    expect(readClaims({ claims: "yes" })).toEqual([]);
    expect(readClaims(null)).toEqual([]);
    const updated = addClaim([claim], { ...claim, branch: "feature/y", claimedAt: 2 });
    expect(updated).toEqual([{ ...claim, branch: "feature/y", claimedAt: 2 }]);
  });
});
