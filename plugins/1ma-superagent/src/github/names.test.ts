import { describe, expect, it } from "vitest";
import { parsePullRequestUrl, repoFromRemoteUrl } from "./names.js";

describe("repoFromRemoteUrl", () => {
  it.each([
    ["https://github.com/Example/App.git", "example/app"],
    ["https://github.com/example/app", "example/app"],
    ["https://token@github.com/example/app.git", "example/app"],
    ["git@github.com:example/app.git", "example/app"],
    ["ssh://git@github.com/example/app.git", "example/app"],
  ])("reads %s as %s", (url, repo) => {
    expect(repoFromRemoteUrl(url)).toBe(repo);
  });

  it.each([
    null,
    "https://gitlab.com/example/app.git",
    "/home/someone/app",
    "https://github.com/example",
  ])("does not take %s for a GitHub repository", (url) => {
    expect(repoFromRemoteUrl(url)).toBeNull();
  });
});

describe("parsePullRequestUrl", () => {
  it("reads a pull request URL", () => {
    expect(parsePullRequestUrl("https://github.com/Example/App/pull/12")).toEqual({
      repo: "example/app",
      number: 12,
    });
    expect(parsePullRequestUrl("https://github.com/example/app/pull/12/files")).toBeNull();
    expect(parsePullRequestUrl("https://github.com/example/app/issues/12")).toBeNull();
    expect(parsePullRequestUrl("http://github.com/example/app/pull/12")).toBeNull();
  });
});
