import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin, PASS_SCHEDULE_NAME } from "../server.js";
import { type QueuedWait, waitingReasonOf } from "./observation.js";
import { fakeExecutor, snapshot, threadSummary } from "./test-helpers.js";

const limiterHold: QueuedWait = {
  retry: false,
  waitingOn: { kind: "plugin", pluginId: "concurrency-limit" },
};

describe("waiting reasons", () => {
  it("names the owner, the provider limit or the machine", () => {
    expect(waitingReasonOf({ hasPendingInteraction: true }, [limiterHold])).toBe("owner");
    expect(
      waitingReasonOf({ hasPendingInteraction: false }, [
        { retry: true, waitingOn: { kind: "time" } },
      ]),
    ).toBe("limit");
    expect(waitingReasonOf({ hasPendingInteraction: false }, [limiterHold])).toBe("machine");
    expect(
      waitingReasonOf({ hasPendingInteraction: false }, [
        { retry: false, waitingOn: { kind: "host-offline" } },
      ]),
    ).toBe("machine");
    expect(
      waitingReasonOf({ hasPendingInteraction: false }, [
        { retry: false, waitingOn: { kind: "thread-busy" } },
      ]),
    ).toBeNull();
  });

  it("are recorded on the work of a chat held by the executor's concurrency limit, and cleared after", async () => {
    let held = true;
    const { bb, harness } = createFakePluginHost({
      pluginId: "1ma-superagent",
      settings: { role: "control" },
    });
    await createPlugin({
      executors: () => [
        fakeExecutor("linux", {
          snapshot: async () =>
            snapshot([
              threadSummary({ threadId: "thr_held", queuedWork: held ? "waiting" : "none" }),
            ]),
          queuedWaits: async () => (held ? [limiterHold] : []),
        }),
      ],
      gh: () => async () => ({ status: "error", message: "unused" }),
    })(bb);
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    const first = await harness.behavior.callRpc("work.v1.list", {});
    expect(first).toMatchObject({ works: [{ waitingReason: "machine" }] });
    held = false;
    await harness.behavior.runSchedule(PASS_SCHEDULE_NAME);
    const second = await harness.behavior.callRpc("work.v1.list", {});
    expect(second).toMatchObject({ works: [{ waitingReason: null }] });
    await harness.lifecycle.dispose();
  });
});
