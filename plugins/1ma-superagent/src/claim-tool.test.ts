import {
  createFakePluginHost,
  makePluginAgentConfigurationContext,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createPlugin } from "../server.js";
import { CLAIM_TOOL } from "./claim-tool.js";

const REPOS = JSON.stringify([
  { repo: "example/app", accounts: { mac: ["mac-bot"] } },
  { repo: "example/private" },
]);

async function setup(remoteUrl: string | null) {
  const metadata: Record<string, unknown> = {};
  const { bb, harness } = createFakePluginHost({
    pluginId: "1ma-superagent",
    settings: { repos: REPOS, excludedRepos: "example/private" },
    sdk: {
      projects: { get: async () => ({ id: "proj_app", gitRemoteUrl: remoteUrl }) },
      threads: {
        get: async () => makeThreadResponse({ id: "thr_1", environmentId: "env_1" }),
        getPluginMetadata: async () => metadata,
        updatePluginMetadata: async (args: { set?: Record<string, unknown> }) =>
          Object.assign(metadata, args.set),
      },
      environments: { get: async () => ({ id: "env_1", branchName: "feature/x" }) },
    },
  });
  await createPlugin({
    executors: () => [],
    gh: () => async () => ({ status: "error", message: "unused" }),
  })(bb);
  return { harness, metadata };
}

function configure(gitRemoteUrl: string | null) {
  return makePluginAgentConfigurationContext({ project: { gitRemoteUrl } });
}

describe("sa_claim_pr", () => {
  it("records the claim with the chat's branch in the chat's metadata", async () => {
    const { harness, metadata } = await setup("https://github.com/example/app.git");
    const result = await harness.behavior.callAgentTool(
      CLAIM_TOOL,
      { url: "https://github.com/example/app/pull/7" },
      { threadId: "thr_1", projectId: "proj_app" },
    );
    expect(JSON.stringify(result)).toContain("Claimed example/app#7");
    expect(metadata).toEqual({
      claims: [
        { repo: "example/app", number: 7, branch: "feature/x", claimedAt: expect.any(Number) },
      ],
    });
    await harness.lifecycle.dispose();
  });

  it("refuses a PR of another repository than the chat's project", async () => {
    const { harness, metadata } = await setup("https://github.com/example/app.git");
    const result = await harness.behavior.callAgentTool(
      CLAIM_TOOL,
      { url: "https://github.com/example/other/pull/7" },
      { threadId: "thr_1", projectId: "proj_app" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(metadata).toEqual({});
    await harness.lifecycle.dispose();
  });

  it("refuses a claim from a chat of an excluded project", async () => {
    const { harness, metadata } = await setup("https://github.com/example/private.git");
    const result = await harness.behavior.callAgentTool(
      CLAIM_TOOL,
      { url: "https://github.com/example/private/pull/7" },
      { threadId: "thr_1", projectId: "proj_app" },
    );
    expect(result).toMatchObject({ isError: true });
    expect(metadata).toEqual({});
    await harness.lifecycle.dispose();
  });
});

describe("claim instructions", () => {
  it("go only to chats of watched projects, never to excluded ones, and stay short", async () => {
    const { harness } = await setup(null);
    const watched = await harness.behavior.resolveAgentConfiguration(
      configure("git@github.com:example/app.git"),
    );
    expect(watched.tools.map((tool) => (typeof tool === "string" ? tool : tool.name))).toEqual([
      CLAIM_TOOL,
    ]);
    expect(watched.instructions?.length ?? 0).toBeGreaterThan(0);
    expect(watched.instructions?.length ?? 0).toBeLessThanOrEqual(300);
    const others = await Promise.all(
      ["https://github.com/example/private.git", "https://github.com/example/other.git", null].map(
        (remote) => harness.behavior.resolveAgentConfiguration(configure(remote)),
      ),
    );
    for (const other of others) {
      expect(other.tools).toEqual([]);
      expect(other.instructions ?? null).toBeNull();
    }
    await harness.lifecycle.dispose();
  });
});
