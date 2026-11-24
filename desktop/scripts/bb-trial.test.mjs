import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { GhNotFound, startTrial } from "./bb-trial.mjs";

const repo = "1ma-ai/1ma";
const upstream = {
  repository: "https://github.com/get-bb/bb.git",
  tag: "desktop-v0.49.0",
  commit: "a".repeat(40),
};
const newTag = "desktop-v0.50.0";
const newCommit = "b".repeat(40);

// A small GitHub: commits with their patch series, branches, workflow runs.
function github({
  series = { main1: ["0001.patch:x"] },
  branches = {},
  runs = [],
  failOn = null,
} = {}) {
  const state = {
    series: { ...series },
    branches: { ...branches },
    runs: [...runs],
    calls: [],
    counter: 100,
  };
  const gh = (args) => {
    state.calls.push(args.join(" "));
    if (failOn && args.join(" ").includes(failOn)) throw new Error("gh failed: HTTP 502");
    const [command, ...rest] = args;
    if (command === "api") {
      const method = rest[0] === "-X" ? rest[1] : "GET";
      const path = rest[0] === "-X" ? rest[2] : rest[0];
      const field = (name) => {
        const index = rest.findIndex(
          (arg, i) => (rest[i - 1] === "-f" || rest[i - 1] === "-F") && arg.startsWith(`${name}=`),
        );
        return index === -1 ? undefined : rest[index].slice(name.length + 1);
      };
      let match;
      if ((match = /^repos\/[^/]+\/[^/]+\/contents\/desktop\/patches\?ref=(.+)$/u.exec(path))) {
        const files = state.series[match[1]];
        if (!files) throw new GhNotFound("Not Found");
        return JSON.stringify(
          files.map((file) => ({ name: file.split(":")[0], sha: file.split(":")[1] })),
        );
      }
      if ((match = /^repos\/[^/]+\/[^/]+\/branches\/(.+)$/u.exec(path))) {
        const sha = state.branches[match[1]];
        if (!sha) throw new GhNotFound("HTTP 404: Not Found");
        return JSON.stringify({ commit: { sha } });
      }
      if (path.endsWith("/git/refs") && method === "GET") {
        const branch = field("ref").replace("refs/heads/", "");
        state.branches[branch] = field("sha");
        return "{}";
      }
      if ((match = /\/git\/refs\/heads\/(.+)$/u.exec(path)) && method === "PATCH") {
        state.branches[match[1]] = field("sha");
        return "{}";
      }
      if (path.includes("/contents/desktop/upstream.json?ref="))
        return JSON.stringify({ sha: "upstream-sha" });
      if (path.endsWith("/contents/desktop/upstream.json") && method === "PUT") {
        const branch = field("branch");
        const previous = state.branches[branch];
        const next = `trial${(state.counter += 1)}`;
        state.series[next] = state.series[previous];
        state.branches[branch] = next;
        state.upstream = JSON.parse(Buffer.from(field("content"), "base64").toString("utf8"));
        return "{}";
      }
      throw new Error(`unexpected api ${args.join(" ")}`);
    }
    if (command === "run" && rest[0] === "list") {
      const workflow = rest[rest.indexOf("--workflow") + 1];
      return JSON.stringify(
        state.runs.filter((run) => run.workflow === workflow).map(({ headSha }) => ({ headSha })),
      );
    }
    if (command === "workflow" && rest[0] === "run") {
      const workflow = rest[1];
      const branch = rest[rest.indexOf("--ref") + 1];
      state.runs.push({ workflow, headSha: state.branches[branch] });
      return "";
    }
    throw new Error(`unexpected gh ${args.join(" ")}`);
  };
  return { gh, state };
}

const dispatched = (state) =>
  state.calls.filter((call) => call.startsWith("workflow run")).map((call) => call.split(" ")[2]);
const trial = (gh, mainSha = "main1") =>
  startTrial({ gh, repo, mainSha, upstream, tag: newTag, commit: newCommit });

describe("a trial of a new bb release", () => {
  test("a new tag gets a branch with only upstream.json changed and both runs", () => {
    const { gh, state } = github();
    const result = trial(gh);
    assert.equal(result.branch, `bb-trial/${newTag}`);
    assert.deepEqual(state.upstream, {
      ...upstream,
      seriesBase: upstream.commit,
      tag: newTag,
      commit: newCommit,
    });
    assert.deepEqual(dispatched(state), ["desktop.yml", "desktop-tests.yml"]);
  });

  test("a rerun after a partly started trial starts only the missing run", () => {
    const { gh, state } = github({
      branches: { [`bb-trial/${newTag}`]: "trial1" },
      series: { main1: ["0001.patch:x"], trial1: ["0001.patch:x"] },
      runs: [{ workflow: "desktop.yml", headSha: "trial1" }],
    });
    const result = trial(gh);
    assert.deepEqual(result.started, ["desktop-tests.yml"]);
    assert.deepEqual(dispatched(state), ["desktop-tests.yml"]);
  });

  test("a rerun of a complete trial starts nothing", () => {
    const { gh, state } = github({
      branches: { [`bb-trial/${newTag}`]: "trial1" },
      series: { main1: ["0001.patch:x"], trial1: ["0001.patch:x"] },
      runs: [
        { workflow: "desktop.yml", headSha: "trial1" },
        { workflow: "desktop-tests.yml", headSha: "trial1" },
      ],
    });
    assert.deepEqual(trial(gh).started, []);
    assert.deepEqual(dispatched(state), []);
  });

  test("a changed 1ma series starts the trial of the same tag again from the new main", () => {
    const { gh, state } = github({
      branches: { [`bb-trial/${newTag}`]: "trial1" },
      series: { main2: ["0001.patch:x", "0002.patch:y"], trial1: ["0001.patch:x"] },
      runs: [
        { workflow: "desktop.yml", headSha: "trial1" },
        { workflow: "desktop-tests.yml", headSha: "trial1" },
      ],
    });
    const result = trial(gh, "main2");
    assert.notEqual(result.head, "trial1");
    assert.deepEqual(dispatched(state), ["desktop.yml", "desktop-tests.yml"]);
    assert.ok(state.calls.some((call) => call.includes("PATCH") && call.includes("sha=main2")));
  });

  test("a failing GitHub API stops the trial instead of passing for an existing branch", () => {
    const { gh, state } = github({ failOn: "/branches/" });
    assert.throws(() => trial(gh), /HTTP 502/u);
    assert.deepEqual(dispatched(state), []);
  });
});
