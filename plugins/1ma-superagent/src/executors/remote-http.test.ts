import { describe, expect, it } from "vitest";
import type { PagingLimits } from "./paging.js";
import { type Fetch, createRemoteHttpExecutor } from "./remote-http.js";

const limits: PagingLimits = {
  pageSize: 2,
  maxPages: 5,
  pageTimeoutMs: 1_000,
  totalTimeoutMs: 5_000,
};

function apiThread(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    projectId: "proj_app",
    environmentId: "env_app",
    title: null,
    titleFallback: `Chat ${id}`,
    providerId: "claude-code",
    status: "idle",
    visibility: "visible",
    parentThreadId: null,
    originPluginId: null,
    updatedAt: 5,
    runtime: { displayStatus: "idle" },
    ...overrides,
  };
}

function fakeServer(routes: Record<string, () => Response | Promise<Response>>) {
  const requested: string[] = [];
  const fetch: Fetch = async (input) => {
    const url = new URL(input);
    const key = `${url.pathname}${url.search}`;
    requested.push(key);
    const route = routes[key] ?? routes[url.pathname];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route();
  };
  return { fetch, requested };
}

const json = (body: unknown) => () => Response.json(body);

const projects = json([
  { id: "proj_app", gitRemoteUrl: "https://github.com/example/app.git", kind: "standard" },
]);
const environments = json([
  { id: "env_app", projectId: "proj_app", branchName: "feature/x", status: "ready" },
]);

describe("remote-http executor", () => {
  it("pages through live chats and maps them", async () => {
    const server = fakeServer({
      "/api/v1/threads?archived=false&includeHidden=true&limit=2&offset=0": json([
        apiThread("thr_a"),
        apiThread("thr_b", { visibility: "hidden" }),
      ]),
      "/api/v1/threads?archived=false&includeHidden=true&limit=2&offset=2": json([
        apiThread("thr_c"),
      ]),
      "/api/v1/environments": environments,
      "/api/v1/projects": projects,
    });
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test:38886/",
      fetch: server.fetch,
      limits,
      now: () => 42,
    });
    const result = await executor.snapshot(new AbortController().signal);
    expect(result.completeness).toBe("complete");
    expect(result.observedAt).toBe(42);
    expect(
      result.items.threads.map((thread) => [thread.threadId, thread.hidden, thread.title]),
    ).toEqual([
      ["thr_a", false, "Chat thr_a"],
      ["thr_b", true, "Chat thr_b"],
      ["thr_c", false, "Chat thr_c"],
    ]);
    expect(result.items.environments).toEqual([
      { environmentId: "env_app", projectId: "proj_app", branch: "feature/x" },
    ]);
  });

  it("fails instead of returning an empty list when the server is down", async () => {
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      },
      limits,
    });
    const result = await executor.snapshot(new AbortController().signal);
    expect(result.completeness).toBe("failed");
    expect(result.items.threads).toEqual([]);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("rejects a chat list of an unexpected shape", async () => {
    const server = fakeServer({
      "/api/v1/threads": json([{ ...apiThread("thr_a"), updatedAt: "yesterday" }]),
      "/api/v1/environments": environments,
      "/api/v1/projects": projects,
    });
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: server.fetch,
      limits,
    });
    const result = await executor.snapshot(new AbortController().signal);
    expect(result.completeness).toBe("failed");
    expect(result.error).toMatch(/threads: .*unexpected shape at 0\.updatedAt/);
  });

  it("is partial when chats are listed but environments are not", async () => {
    const server = fakeServer({
      "/api/v1/threads": json([apiThread("thr_a")]),
      "/api/v1/environments": () => new Response("boom", { status: 500 }),
      "/api/v1/projects": projects,
    });
    const executor = createRemoteHttpExecutor({
      serverId: "linux",
      baseUrl: "http://linux.test",
      fetch: server.fetch,
      limits,
    });
    const result = await executor.snapshot(new AbortController().signal);
    expect(result.completeness).toBe("partial");
    expect(result.error).toContain("environments: GET /environments?limit=2&offset=0 answered 500");
  });
});
