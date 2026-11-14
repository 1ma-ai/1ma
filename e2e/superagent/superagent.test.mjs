import assert from "node:assert/strict";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Server, requireEnv, waitFor } from "./servers.mjs";

const root = requireEnv("E2E_ROOT");
const pluginDir = path.resolve(import.meta.dirname, "../../plugins/1ma-superagent");
const packageDir = path.join(root, "server-package");
const PLUGIN = "1ma-superagent";

const control = new Server({ name: "control", port: 39886, daemonPort: 39896, root, packageDir });
const executor = new Server({ name: "executor", port: 39887, daemonPort: 39897, root, packageDir });

async function spawnPendingChat(server, projectId, title) {
  const thread = server.bbJson([
    "thread",
    "spawn",
    "--project",
    projectId,
    "--provider",
    "claude-code",
    "--model",
    "claude-haiku-5-5",
    "--prompt",
    "e2e placeholder, never sent",
    "--send-at",
    "7d",
    "--title",
    title,
  ]);
  return thread.id;
}

describe("1ma-superagent on two 1ma servers", () => {
  const chats = {};

  before(async () => {
    control.start();
    executor.start();
    await Promise.all([control.waitReady(), executor.waitReady()]);
    for (const server of [control, executor]) server.bb(["plugin", "install", pluginDir, "--yes"]);
    control.bb(["plugin", "config", PLUGIN, "set", "role", "control"]);
    control.bb(["plugin", "config", PLUGIN, "set", "linuxServerUrl", executor.url]);
    const controlProject = await control.createProject(
      "control-app",
      path.join(root, "repos/control-app"),
    );
    const executorProject = await executor.createProject(
      "executor-app",
      path.join(root, "repos/executor-app"),
    );
    chats.control = await spawnPendingChat(control, controlProject, "control chat");
    chats.executor = await spawnPendingChat(executor, executorProject, "executor chat");
  });

  after(async () => {
    await Promise.all([control.stop(), executor.stop()]);
  });

  it("records the chats of both servers in the work record", async () => {
    const result = await waitFor("both chats in work.v1.list", 180_000, async () => {
      const list = await control.rpc(PLUGIN, "work.v1.list", {});
      const ids = new Set(
        list.works.map((work) => `${work.source.serverId}:${work.source.threadId}`),
      );
      return ids.has(`mac:${chats.control}`) && ids.has(`linux:${chats.executor}`) ? list : null;
    });
    const linux = result.servers.find((server) => server.id === "linux");
    assert.equal(linux?.completeness, "complete");
    assert.equal(linux?.lastError, null);
  });

  it("shows the executor server as not seen while it is down", async () => {
    await executor.stop();
    const result = await waitFor("linux marked failed", 180_000, async () => {
      const list = await control.rpc(PLUGIN, "work.v1.list", {});
      const linux = list.servers.find((server) => server.id === "linux");
      return linux?.completeness === "failed" ? list : null;
    });
    const linux = result.servers.find((server) => server.id === "linux");
    assert.notEqual(linux.lastSeenAt, null);
    assert.ok(linux.lastAttemptAt > linux.lastSeenAt);
    assert.ok(
      result.works.some((work) => work.source.serverId === "linux" && work.state !== "closed"),
      "a server that did not answer must not close its chats",
    );
  });

  it("sees the executor server again after it comes back, and the executor runs no passes", async () => {
    executor.start();
    await executor.waitReady();
    await waitFor("linux complete again", 180_000, async () => {
      const list = await control.rpc(PLUGIN, "work.v1.list", {});
      return list.servers.find((server) => server.id === "linux")?.completeness === "complete";
    });
    const list = await executor.rpc(PLUGIN, "work.v1.list", {});
    assert.deepEqual(list.works, []);
    assert.deepEqual(list.servers, []);
  });
});
