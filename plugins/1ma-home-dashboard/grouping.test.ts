import { describe, expect, it } from "vitest";
import { groupThreads, laneFor, type DashboardThread } from "./grouping";

function thread(overrides: Partial<DashboardThread> = {}): DashboardThread {
  return {
    id: "thr_1",
    projectId: "proj_1",
    status: "idle",
    activity: { backgroundAgents: 0, backgroundCommands: 0, workflows: 0, goals: 0, planMode: 0 },
    queuedWork: "none",
    hasPendingInteraction: false,
    indicator: "none",
    isUnread: false,
    isArchived: false,
    isHidden: false,
    updatedAt: 1_000,
    ...overrides,
  };
}

const none: ReadonlySet<string> = new Set();

describe("laneFor", () => {
  it("puts a thread that waits for the user into needs-you before anything else", () => {
    expect(laneFor(thread({ hasPendingInteraction: true, status: "active" }), none)).toBe(
      "needs-you",
    );
    expect(laneFor(thread({ status: "error" }), new Set(["thr_1"]))).toBe("needs-you");
    expect(laneFor(thread({ queuedWork: "failed" }), none)).toBe("needs-you");
    expect(laneFor(thread({ indicator: "unread-error" }), none)).toBe("needs-you");
  });

  it("treats live execution and background activity as running, even when marked done", () => {
    const done = new Set(["thr_1"]);
    expect(laneFor(thread({ status: "active" }), done)).toBe("running");
    expect(laneFor(thread({ status: "pending" }), done)).toBe("running");
    expect(
      laneFor(
        thread({
          activity: {
            backgroundAgents: 1,
            backgroundCommands: 0,
            workflows: 0,
            goals: 0,
            planMode: 0,
          },
        }),
        done,
      ),
    ).toBe("running");
    expect(
      laneFor(
        thread({
          activity: {
            backgroundAgents: 0,
            backgroundCommands: 0,
            workflows: 0,
            goals: 0,
            planMode: 2,
          },
        }),
        done,
      ),
    ).toBe("running");
  });

  it("puts an idle thread into done only when Focus Board marked it done", () => {
    expect(laneFor(thread(), new Set(["thr_1"]))).toBe("done");
    expect(laneFor(thread(), none)).toBe("needs-you");
  });
});

describe("groupThreads", () => {
  it("drops archived and hidden threads and threads of other projects", () => {
    const lanes = groupThreads(
      [
        thread({ id: "a", isArchived: true }),
        thread({ id: "b", isHidden: true }),
        thread({ id: "c", projectId: "proj_2" }),
        thread({ id: "d" }),
      ],
      "proj_1",
      none,
    );
    expect(lanes["needs-you"].map((t) => t.id)).toEqual(["d"]);
    expect(lanes.running).toEqual([]);
    expect(lanes.done).toEqual([]);
  });

  it("shows every project on the projectless home page", () => {
    const lanes = groupThreads(
      [thread({ id: "a", projectId: "proj_2" }), thread({ id: "b", projectId: null })],
      null,
      none,
    );
    expect(lanes["needs-you"].map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("orders each lane by most recent activity", () => {
    const lanes = groupThreads(
      [
        thread({ id: "old", updatedAt: 1 }),
        thread({ id: "new", updatedAt: 3 }),
        thread({ id: "mid", updatedAt: 2 }),
      ],
      "proj_1",
      none,
    );
    expect(lanes["needs-you"].map((t) => t.id)).toEqual(["new", "mid", "old"]);
  });
});
