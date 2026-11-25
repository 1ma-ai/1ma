import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { pathspecs } from "./changed-paths.mjs";

const directory = new URL("../../.github/workflows/", import.meta.url);
const workflows = readdirSync(directory)
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((file) => ({ name: file, ...parse(readFileSync(new URL(file, directory), "utf8")), file }));
const protection = JSON.parse(
  readFileSync(new URL("../../.github/main-protection.json", import.meta.url), "utf8"),
);

const jobsOf = (workflow) => Object.entries(workflow.jobs);
const needsOf = (job) => [job.needs ?? []].flat();
const onPullRequests = (workflow) => Object.hasOwn(workflow.on, "pull_request");
const gated = workflows.filter((workflow) => workflow.jobs.changes !== undefined);
const asking = (workflow) => workflow.jobs.changes.steps.find((step) => step.env?.PATHS);
const asked = (workflow) =>
  asking(workflow)
    .env.PATHS.split("\n")
    .filter((line) => line !== "");
const CHANGED = "needs.changes.outputs.changed == 'true'";
const OFF_PULL_REQUESTS = "github.event_name != 'pull_request'";
const scriptOf = (step) =>
  /^node (?<script>scripts\/lib\/[\w-]+\.mjs)$/u.exec(step.run ?? "")?.groups.script;

describe("workflows", () => {
  test("every action is pinned to a commit, not to a tag its owner can move", () => {
    const loose = [];
    for (const workflow of workflows)
      for (const [id, job] of jobsOf(workflow))
        for (const uses of [job.uses, ...(job.steps ?? []).map((step) => step.uses)])
          if (uses !== undefined && !uses.startsWith("./") && !/@[0-9a-f]{40}$/u.test(uses))
            loose.push(`${workflow.name} ${id}: ${uses}`);
    assert.deepEqual(loose, []);
  });

  test("no workflow is kept from pull requests by a path filter: its required check would never report", () => {
    for (const workflow of workflows) {
      const trigger = workflow.on.pull_request ?? {};
      assert.equal(trigger.paths, undefined, workflow.name);
      assert.equal(trigger["paths-ignore"], undefined, workflow.name);
    }
  });

  test("a workflow that starts on main only for some paths asks pull requests about the same paths", () => {
    for (const workflow of workflows) {
      const paths = workflow.on.push?.paths;
      if (paths === undefined) continue;
      assert.notEqual(workflow.jobs.changes, undefined, `${workflow.name} has no changes job`);
      assert.deepEqual(asked(workflow), paths, workflow.name);
    }
  });

  test("the paths a pull request is asked about are ones git reads as the filter would", () => {
    assert.ok(gated.length > 0);
    for (const workflow of gated) assert.doesNotThrow(() => pathspecs(asked(workflow)));
  });

  test("every job of such a workflow waits for the answer, and the result job waits for every job", () => {
    for (const workflow of gated) {
      const jobs = workflow.jobs;
      const others = Object.keys(jobs).filter((id) => id !== "changes" && id !== "result");
      const waits = (id, seen = new Set()) =>
        !seen.has(id) &&
        needsOf(jobs[id]).some((need) => need === "changes" || waits(need, seen.add(id)));
      for (const id of others) {
        assert.ok(waits(id), `${workflow.name} ${id} runs without the answer`);
        if (needsOf(jobs[id]).includes("changes"))
          assert.equal(jobs[id].if, CHANGED, `${workflow.name} ${id}`);
        else
          assert.ok(
            [undefined, OFF_PULL_REQUESTS].includes(jobs[id].if),
            `${workflow.name} ${id}: the result job cannot tell when "${jobs[id].if}" skips it`,
          );
      }
      assert.equal(jobs.result.if, "always()", workflow.name);
      assert.deepEqual(needsOf(jobs.result).toSorted(), ["changes", ...others].toSorted());
    }
  });

  test("the answer the jobs wait for is the one the script writes", () => {
    for (const workflow of gated) {
      const { changes } = workflow.jobs;
      const checkout = changes.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
      assert.equal(checkout.with["fetch-depth"], 2, `${workflow.name}: the merge needs its parent`);
      const step = asking(workflow);
      assert.equal(scriptOf(step), "scripts/lib/changed-paths.mjs", workflow.name);
      assert.deepEqual(
        changes.outputs,
        { changed: `\${{ steps.${step.id}.outputs.changed }}` },
        workflow.name,
      );
    }
  });

  test("the result job gives the verdict script every job and the jobs kept off pull requests", () => {
    for (const workflow of gated) {
      const { result, ...jobs } = workflow.jobs;
      const step = result.steps.find((entry) => scriptOf(entry) !== undefined);
      assert.equal(scriptOf(step), "scripts/lib/workflow-result.mjs", workflow.name);
      assert.ok(
        result.steps.indexOf(step) >
          result.steps.findIndex((entry) => entry.uses?.startsWith("actions/checkout@")),
        `${workflow.name}: the script is not checked out`,
      );
      assert.equal(step.env.NEEDS, "${{ toJSON(needs) }}", workflow.name);
      assert.equal(step.if, undefined, workflow.name);
      const off = Object.keys(jobs).filter((id) => jobs[id].if === OFF_PULL_REQUESTS);
      assert.deepEqual(
        (step.env.OFF_PULL_REQUESTS ?? "").split(" ").filter((id) => id !== ""),
        off,
        workflow.name,
      );
    }
  });

  test("a pull request that changes only what a workflow reads to decide still runs it", () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    for (const workflow of gated) {
      const steps = jobsOf(workflow).flatMap(([, job]) => job.steps ?? []);
      const reads = [
        `.github/workflows/${workflow.file}`,
        ...steps.map((step) => step.with?.["node-version-file"]),
        ...[workflow.jobs.changes, workflow.jobs.result].flatMap((job) => job.steps.map(scriptOf)),
      ].filter((file) => file !== undefined);
      assert.ok(reads.length >= 3, workflow.name);
      const covered = execFileSync(
        "git",
        ["-C", root, "ls-files", "--", ...pathspecs(asked(workflow))],
        { encoding: "utf8" },
      ).split("\n");
      for (const file of new Set(reads))
        assert.ok(covered.includes(file), `${workflow.name} does not ask about ${file}`);
    }
  });
});

describe("protection of main", () => {
  const names = workflows.flatMap((workflow) =>
    jobsOf(workflow).map(([id, job]) => ({ workflow, id, job, name: job.name ?? id })),
  );

  test("every required check is a job that reports on every pull request", () => {
    for (const { context } of protection.protection.required_status_checks.checks) {
      const found = names.filter((entry) => entry.name === context);
      assert.equal(found.length, 1, `${context}: ${found.length} jobs carry this name`);
      const [{ workflow, id, job }] = found;
      assert.ok(onPullRequests(workflow), `${context}: no pull request trigger`);
      if (workflow.jobs.changes === undefined) assert.equal(job.if, undefined, context);
      else assert.equal(id, "result", `${context}: only the result job always reports`);
    }
  });

  test("every workflow that runs on pull requests has a required check", () => {
    const required = new Set(
      protection.protection.required_status_checks.checks.map((check) => check.context),
    );
    for (const workflow of workflows) {
      if (!onPullRequests(workflow)) continue;
      const own = jobsOf(workflow).filter(([id, job]) => required.has(job.name ?? id));
      assert.ok(own.length > 0, `${workflow.name}: nothing of it is required`);
    }
  });
});
