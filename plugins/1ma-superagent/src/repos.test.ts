import { describe, expect, it } from "vitest";
import { isWatchedRepo, parseExcludedSetting, parseReposSetting, repoPolicy } from "./repos.js";

describe("repository settings", () => {
  it("reads repositories and accounts in lower case", () => {
    expect(
      parseReposSetting('[{"repo": "Example/App", "accounts": {"mac": ["Mac-Bot"]}}]'),
    ).toEqual([{ repo: "example/app", accounts: { mac: ["mac-bot"], linux: [] } }]);
  });

  it("reports a broken setting instead of guessing", () => {
    expect(parseReposSetting("[{")).toBe("not valid JSON");
    expect(typeof parseReposSetting('[{"repo": "no-slash"}]')).toBe("string");
  });

  it("lets an excluded project win over the watched list", () => {
    const policy = repoPolicy(
      parseReposSetting('[{"repo": "example/app"}, {"repo": "example/private"}]') as never,
      parseExcludedSetting("Example/Private, other/x"),
    );
    expect(isWatchedRepo(policy, "example/app")).toBe(true);
    expect(isWatchedRepo(policy, "example/private")).toBe(false);
    expect(isWatchedRepo(policy, null)).toBe(false);
  });
});
