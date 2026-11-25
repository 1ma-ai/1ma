import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefiniteSpawnFailure } from "../observation.js";
import { createRemoteHttpExecutor } from "./remote-http.js";

interface Seen {
  readonly method: string;
  readonly path: string;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function answerFor(method: string, path: string): unknown {
  if (method === "POST" && path === "/api/v1/threads") return { id: "thr_elsewhere" };
  if (method === "GET" && path.endsWith("/queued-messages")) return [{ id: "q1" }];
  if (method === "GET" && path.startsWith("/api/v1/projects/"))
    return { id: "proj_app", gitRemoteUrl: "https://github.com/example/elsewhere.git" };
  return {};
}

describe("remote-http redirects", () => {
  let configured: Server;
  let other: Server;
  let configuredSeen: Seen[];
  let otherSeen: Seen[];
  let otherUrl: string;
  let configuredUrl: string;
  let redirect: (method: string, path: string) => number | null;

  beforeEach(async () => {
    configuredSeen = [];
    otherSeen = [];
    other = createServer((request, response) => {
      const seen = { method: request.method ?? "", path: request.url ?? "" };
      otherSeen.push(seen);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(answerFor(seen.method, seen.path)));
    });
    configured = createServer((request, response) => {
      const seen = { method: request.method ?? "", path: request.url ?? "" };
      configuredSeen.push(seen);
      const status = redirect(seen.method, seen.path);
      if (status !== null) {
        response.statusCode = status;
        response.setHeader("location", `${otherUrl}${seen.path}`);
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(answerFor(seen.method, seen.path)));
    });
    otherUrl = await listen(other);
    configuredUrl = await listen(configured);
  });

  afterEach(async () => {
    await Promise.all([close(configured), close(other)]);
  });

  const executor = () => createRemoteHttpExecutor({ serverId: "linux", baseUrl: configuredUrl });
  const signal = () => new AbortController().signal;

  it.each([307, 308])(
    "sends a chat creation once and leaves its outcome unknown after a %i",
    async (status) => {
      redirect = (method, path) =>
        method === "POST" && path === "/api/v1/threads" ? status : null;
      const outcome = await executor()
        .spawn(
          {
            projectId: "proj_app",
            providerId: "stub",
            model: "stub",
            prompt: "fixture",
            title: "fixture",
            label: { nonce: "fixture" },
          },
          signal(),
        )
        .then(
          () => "bound",
          (error: unknown) => (error instanceof DefiniteSpawnFailure ? "failed" : "unknown"),
        );
      expect({ outcome, configured: configuredSeen, other: otherSeen }).toEqual({
        outcome: "unknown",
        configured: [{ method: "POST", path: "/api/v1/threads" }],
        other: [],
      });
    },
  );

  it.each([307, 308])(
    "deletes a queued message only on the configured server after a %i",
    async (status) => {
      redirect = (method) => (method === "DELETE" ? status : null);
      await expect(
        executor().clearQueueAndStop("thr_late", () => true, signal()),
      ).rejects.toThrow();
      expect({ configured: configuredSeen, other: otherSeen }).toEqual({
        configured: [
          { method: "GET", path: "/api/v1/threads/thr_late/queued-messages" },
          { method: "DELETE", path: "/api/v1/threads/thr_late/queued-messages/q1" },
        ],
        other: [],
      });
    },
  );

  it.each([307, 308])("sends a stop only to the configured server after a %i", async (status) => {
    redirect = (method, path) => (method === "POST" && path.endsWith("/stop") ? status : null);
    await expect(executor().clearQueueAndStop("thr_late", () => true, signal())).rejects.toThrow();
    expect(configuredSeen.filter((seen) => seen.path.endsWith("/stop"))).toEqual([
      { method: "POST", path: "/api/v1/threads/thr_late/stop" },
    ]);
    expect(otherSeen).toEqual([]);
  });

  it("takes a redirected read as a failed read", async () => {
    redirect = (method) => (method === "GET" ? 307 : null);
    await expect(executor().projectRemote("proj_app", signal())).rejects.toThrow();
    expect(otherSeen).toEqual([]);
  });
});
