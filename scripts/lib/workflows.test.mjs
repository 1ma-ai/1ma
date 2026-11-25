import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { pathspecs } from "./changed-paths.mjs";

const directory = new URL("../../.github/workflows/", import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const workflows = readdirSync(directory)
  .filter((name) => /\.ya?ml$/u.test(name))
  .map((file) => ({ name: file, ...parse(readFileSync(new URL(file, directory), "utf8")), file }));
const protection = JSON.parse(
  readFileSync(new URL("../../.github/main-protection.json", import.meta.url), "utf8"),
);
const required = protection.protection.required_status_checks.checks;

const jobsOf = (workflow) => Object.entries(workflow.jobs);
const needsOf = (job) => [job.needs ?? []].flat();
const onPullRequests = (workflow) => Object.hasOwn(workflow.on, "pull_request");
const isGated = (workflow) => workflow.jobs.changes !== undefined;
const gated = workflows.filter(isGated);
const asking = (workflow) => workflow.jobs.changes.steps.find((step) => step.env?.PATHS);
const asked = (workflow) =>
  asking(workflow)
    .env.PATHS.split("\n")
    .filter((line) => line !== "");
const CHANGED = "needs.changes.outputs.changed == 'true'";
const OFF_PULL_REQUESTS = "github.event_name != 'pull_request'";
const VERDICT = "scripts/lib/workflow-result.mjs";
const scriptOf = (step) =>
  /^node (?<script>scripts\/lib\/[\w-]+\.mjs)$/u.exec(step.run ?? "")?.groups.script;
const isCheckout = (step) => step.uses?.startsWith("actions/checkout@") ?? false;
const tracked = (...specs) =>
  execFileSync("git", ["-C", root, "ls-files", "--", ...specs], { encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

// A result job is what gives a gated workflow its verdict. While a required
// check is renamed a workflow has two.
const isResult = (job) => (job.steps ?? []).some((step) => scriptOf(step) === VERDICT);
const resultsOf = (workflow) => jobsOf(workflow).filter(([, job]) => isResult(job));
const workOf = (workflow) =>
  Object.keys(workflow.jobs).filter((id) => id !== "changes" && !isResult(workflow.jobs[id]));

// Jobs of gated workflows that do not run for pull requests, and why.
const KEPT_OFF_PULL_REQUESTS = {
  "desktop.yml linux-server": "packaging the server takes up to an hour; main builds it",
  "desktop.yml macos": "packaging the app needs a macOS runner for up to two hours; main builds it",
};

// The only steps of gated workflows that run on a condition: the condition, and
// why the job is right without the step.
const CONDITIONAL_STEPS = {
  "bots-e2e.yml e2e Server logs": ["always()", "prints the server logs after a failure"],
  "bots-e2e.yml e2e Sidebar screenshots": ["always()", "uploads screenshots after a failure"],
  "desktop-tests.yml tests Regenerate the PWA icon variants from the 1ma icons, as bb's app build does":
    ["startsWith(matrix.shard, 'app-')", "only the app shards build the PWA"],
  "desktop-tests.yml tests Set up Bun": [
    "startsWith(matrix.shard, 'packages-') || startsWith(matrix.shard, 'plugins-')",
    "only these shards run tests under Bun",
  ],
  "desktop-tests.yml tests Install Electron runtime libraries": [
    "contains(matrix.filter, '--filter=@bb/desktop')",
    "only the desktop shard starts Electron",
  ],
  "desktop-tests.yml tests Test native browser address interactions": [
    "contains(matrix.filter, '--filter=@bb/desktop')",
    "the desktop shard's own smoke test, as in bb's CI",
  ],
};

// pnpm reads these at the root of the checkout when it installs there, and
// corepack takes pnpm's version from package.json.
const INSTALL_INPUTS = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  ".npmrc",
  ".pnpmfile.cjs",
  ".pnpmfile.mjs",
];
const installsAtRoot = (job, step) =>
  /\bpnpm install\b/u.test(step.run ?? "") &&
  [undefined, "${{ github.workspace }}"].includes(
    step["working-directory"] ?? job.defaults?.run?.["working-directory"],
  );

function waitsForTheAnswer(workflow) {
  const { jobs } = workflow;
  const waits = (id, seen = new Set()) =>
    !seen.has(id) &&
    needsOf(jobs[id]).some((need) => need === "changes" || waits(need, seen.add(id)));
  for (const id of workOf(workflow)) {
    assert.ok(waits(id), `${workflow.name} ${id} runs without the answer`);
    if (needsOf(jobs[id]).includes("changes"))
      assert.equal(jobs[id].if, CHANGED, `${workflow.name} ${id}`);
    else
      assert.ok(
        [undefined, OFF_PULL_REQUESTS].includes(jobs[id].if),
        `${workflow.name} ${id}: the result job cannot tell when "${jobs[id].if}" skips it`,
      );
    if (jobs[id].if === OFF_PULL_REQUESTS)
      assert.ok(
        Object.hasOwn(KEPT_OFF_PULL_REQUESTS, `${workflow.file} ${id}`),
        `${workflow.name} ${id} is kept off pull requests without a reason in this test`,
      );
  }
}

function resultJobsJudgeEveryJob(workflow) {
  const results = resultsOf(workflow);
  assert.ok(results.length > 0, `${workflow.name} has no result job`);
  const work = workOf(workflow);
  const off = work.filter((id) => workflow.jobs[id].if === OFF_PULL_REQUESTS);
  for (const [id, job] of results) {
    const where = `${workflow.name} ${id}`;
    assert.equal(job.if, "always()", where);
    assert.deepEqual(needsOf(job).toSorted(), ["changes", ...work].toSorted(), where);
    const step = job.steps.find((entry) => scriptOf(entry) === VERDICT);
    const checkout = job.steps.findIndex(isCheckout);
    assert.ok(
      checkout !== -1 && checkout < job.steps.indexOf(step),
      `${where}: the script is not checked out`,
    );
    assert.equal(step.env?.NEEDS, "${{ toJSON(needs) }}", where);
    assert.equal(step.if, undefined, where);
    assert.deepEqual(
      (step.env.OFF_PULL_REQUESTS ?? "").split(" ").filter((entry) => entry !== ""),
      off,
      where,
    );
  }
}

// needs.<job>.result is all the verdict sees: a job has to fail when its work
// fails, and its work has to be in this file, where these tests read it.
function nothingMasksAFailure(workflow) {
  for (const [id, job] of jobsOf(workflow)) {
    const where = `${workflow.name} ${id}`;
    assert.ok(!Object.hasOwn(job, "continue-on-error"), `${where} may fail and pass`);
    assert.equal(
      job.uses,
      undefined,
      `${where} runs another workflow, which these tests do not read`,
    );
    for (const step of job.steps ?? []) {
      assert.ok(
        !Object.hasOwn(step, "continue-on-error"),
        `${where} "${step.name}" may fail and pass`,
      );
      if (step.if === undefined) continue;
      assert.equal(
        CONDITIONAL_STEPS[`${workflow.file} ${id} ${step.name}`]?.[0],
        step.if,
        `${where} "${step.name}" runs on a condition this test does not list`,
      );
    }
  }
}

function readsWhatItDecidesBy(workflow) {
  const steps = jobsOf(workflow).flatMap(([, job]) =>
    (job.steps ?? []).map((step) => ({ job, step })),
  );
  const reads = [
    `.github/workflows/${workflow.file}`,
    ...steps.map(({ step }) => step.with?.["node-version-file"]),
    ...steps
      .filter(({ job }) => job === workflow.jobs.changes || isResult(job))
      .map(({ step }) => scriptOf(step)),
    ...(steps.some(({ job, step }) => installsAtRoot(job, step)) ? tracked(...INSTALL_INPUTS) : []),
  ].filter((file) => file !== undefined);
  assert.ok(reads.length >= 3, workflow.name);
  const covered = tracked(...pathspecs(asked(workflow)));
  for (const file of new Set(reads))
    assert.ok(covered.includes(file), `${workflow.name} does not ask about ${file}`);
}

// A required check has to report on every pull request into main.
function startsOnPullRequestsIntoMain(workflow) {
  const trigger = workflow.on.pull_request ?? {};
  for (const key of ["paths", "paths-ignore", "branches-ignore"])
    assert.equal(trigger[key], undefined, `${workflow.name}: pull_request.${key}`);
  if (trigger.branches !== undefined)
    assert.ok(
      trigger.branches.includes("main") &&
        !trigger.branches.some((branch) => branch.startsWith("!")),
      `${workflow.name}: pull_request.branches leaves out main`,
    );
  if (trigger.types !== undefined)
    for (const type of ["opened", "synchronize", "reopened"])
      assert.ok(trigger.types.includes(type), `${workflow.name}: pull_request.types lacks ${type}`);
}

const SHAPE = [
  waitsForTheAnswer,
  resultJobsJudgeEveryJob,
  nothingMasksAFailure,
  readsWhatItDecidesBy,
];
const shapeOf = (workflow) => {
  for (const check of SHAPE) check(workflow);
  startsOnPullRequestsIntoMain(workflow);
};

function requiredChecksReport(all, checks) {
  const names = all.flatMap((workflow) =>
    jobsOf(workflow).map(([id, job]) => ({ workflow, job, name: job.name ?? id })),
  );
  for (const { context } of checks) {
    const found = names.filter((entry) => entry.name === context);
    assert.equal(found.length, 1, `${context}: ${found.length} jobs carry this name`);
    const [{ workflow, job }] = found;
    assert.ok(onPullRequests(workflow), `${context}: no pull request trigger`);
    if (isGated(workflow)) assert.ok(isResult(job), `${context}: only a result job always reports`);
    else assert.equal(job.if, undefined, context);
  }
  const wanted = new Set(checks.map((check) => check.context));
  for (const workflow of all) {
    if (!onPullRequests(workflow)) continue;
    const own = jobsOf(workflow).filter(([id, job]) => wanted.has(job.name ?? id));
    assert.ok(own.length > 0, `${workflow.name}: nothing of it is required`);
  }
}

// desktop-release.yml publishes a Desktop build of main only with a green push
// run of desktop-tests.yml for the same commit.
const includes = (paths) => paths.filter((path) => !path.startsWith("!"));
const excludes = (paths) => paths.filter((path) => path.startsWith("!"));
function testsFollowBuilds(build, tests) {
  for (const path of includes(build)) assert.ok(tests.includes(path), `bb tests skip ${path}`);
  for (const path of excludes(tests)) assert.ok(build.includes(path), `bb tests leave out ${path}`);
}

const copyOf = (file, change = () => {}) => {
  const workflow = structuredClone(workflows.find((entry) => entry.file === file));
  change(workflow);
  return workflow;
};
const stepOf = (workflow, job, name) => workflow.jobs[job].steps.find((step) => step.name === name);

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

  test("every workflow starts on every pull request into main: its required check has to report", () => {
    for (const workflow of workflows.filter(onPullRequests)) startsOnPullRequestsIntoMain(workflow);
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

  test("every job of such a workflow waits for the answer", () => {
    for (const workflow of gated) waitsForTheAnswer(workflow);
  });

  test("every result job waits for every job and gives the verdict script all of them", () => {
    for (const workflow of gated) resultJobsJudgeEveryJob(workflow);
  });

  test("no job of such a workflow passes when its work fails or is left out", () => {
    for (const workflow of gated) nothingMasksAFailure(workflow);
  });

  test("the answer the jobs wait for is the one the script writes", () => {
    for (const workflow of gated) {
      const { changes } = workflow.jobs;
      const checkout = changes.steps.find(isCheckout);
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

  test("a pull request that changes only what a workflow reads to decide or to install still runs it", () => {
    for (const workflow of gated) readsWhatItDecidesBy(workflow);
  });

  test("every push to main that builds Desktop also runs bb's tests on its commit", () => {
    const [build, tests] = ["desktop.yml", "desktop-tests.yml"].map(
      (file) => copyOf(file).on.push.paths,
    );
    testsFollowBuilds(build, tests);
    assert.throws(() => testsFollowBuilds([...build, "docs/**"], tests), /bb tests skip docs/u);
    assert.throws(
      () => testsFollowBuilds(build, [...tests, "!brand/**"]),
      /bb tests leave out !brand/u,
    );
  });
});

const breaks = (workflow, message) => assert.throws(() => shapeOf(workflow), message);

describe("the shape tests catch", () => {
  test("a job or a step that may fail and still pass", () => {
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        w.jobs.e2e["continue-on-error"] = true;
      }),
      /e2e may fail and pass/u,
    );
    breaks(
      copyOf("desktop-tests.yml", (w) => {
        w.jobs.tests["continue-on-error"] = true;
      }),
      /tests may fail and pass/u,
    );
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        stepOf(w, "e2e", "Run the end-to-end tests")["continue-on-error"] = true;
      }),
      /"Run the end-to-end tests" may fail and pass/u,
    );
  });

  test("a step that is skipped on a condition nobody listed", () => {
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        stepOf(w, "e2e", "Run the end-to-end tests").if = "${{ false }}";
      }),
      /"Run the end-to-end tests" runs on a condition/u,
    );
    breaks(
      copyOf("desktop-tests.yml", (w) => {
        stepOf(w, "tests", "Test native browser address interactions").if = "${{ false }}";
      }),
      /"Test native browser address interactions" runs on a condition/u,
    );
  });

  test("a job whose work runs in another workflow", () => {
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        const { needs, if: when, name } = w.jobs.e2e;
        w.jobs.e2e = { name, needs, if: when, uses: "./.github/workflows/e2e-call.yml" };
      }),
      /e2e runs another workflow/u,
    );
  });

  test("a job kept off pull requests without a reason", () => {
    breaks(
      copyOf("desktop-tests.yml", (w) => {
        w.jobs.tests.if = OFF_PULL_REQUESTS;
        stepOf(
          w,
          "result",
          "Every job the event calls for passed, or the paths are untouched",
        ).env.OFF_PULL_REQUESTS = "tests";
      }),
      /tests is kept off pull requests without a reason/u,
    );
  });

  test("a result job that does not check the verdict script out first", () => {
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        w.jobs.result.steps = w.jobs.result.steps.filter((step) => !isCheckout(step));
      }),
      /result: the script is not checked out/u,
    );
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        w.jobs.result.steps.reverse();
      }),
      /result: the script is not checked out/u,
    );
  });

  test("a result job that does not wait for every job, or is not run after a failure", () => {
    breaks(
      copyOf("desktop-tests.yml", (w) => {
        w.jobs.result.needs = ["changes", "plan", "static"];
      }),
      /Desktop bb tests result/u,
    );
    breaks(
      copyOf("bots-e2e.yml", (w) => {
        delete w.jobs.result.if;
      }),
      /Bots end-to-end result/u,
    );
  });

  test("a pull request into main the workflow does not start on", () => {
    for (const trigger of [
      { branches: ["release-only"] },
      { branches: ["main", "!main"] },
      { "branches-ignore": ["main"] },
      { paths: ["plugins/**"] },
      { types: ["opened"] },
    ])
      breaks(
        copyOf("bots-e2e.yml", (w) => {
          w.on.pull_request = trigger;
        }),
        /pull_request\./u,
      );
    assert.doesNotThrow(() =>
      shapeOf(
        copyOf("bots-e2e.yml", (w) => {
          w.on.pull_request = { branches: ["main"], types: ["opened", "synchronize", "reopened"] };
        }),
      ),
    );
  });

  test("a workflow that a change of how pnpm installs does not run", () => {
    for (const { file: workflow } of gated)
      for (const file of ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"])
        breaks(
          copyOf(workflow, (w) => {
            const step = asking(w);
            step.env.PATHS = asked(w)
              .filter((path) => path !== file)
              .join("\n");
          }),
          new RegExp(`does not ask about ${file.replace(".", "\\.")}`, "u"),
        );
  });
});

describe("protection of main", () => {
  test("every required check is a job that reports on every pull request, and every such workflow has one", () => {
    requiredChecksReport(workflows, required);
  });

  test("a required check can be renamed in the three steps the runbook gives", () => {
    const OLD = "Bots end-to-end result";
    const NEW = "Bots end-to-end verdict";
    const both = copyOf("bots-e2e.yml", (w) => {
      w.jobs.verdict = { ...structuredClone(w.jobs.result), name: NEW };
    });
    const only = copyOf("bots-e2e.yml", (w) => {
      w.jobs.verdict = { ...w.jobs.result, name: NEW };
      delete w.jobs.result;
    });
    const renamed = required.map((check) =>
      check.context === OLD ? { ...check, context: NEW } : check,
    );
    const others = workflows.filter((workflow) => workflow.file !== "bots-e2e.yml");
    for (const [workflow, checks] of [
      [both, required],
      [both, renamed],
      [only, renamed],
    ]) {
      shapeOf(workflow);
      requiredChecksReport([...others, workflow], checks);
    }
    const short = structuredClone(both);
    short.jobs.verdict.needs = ["changes"];
    assert.throws(() => shapeOf(short), /Bots end-to-end verdict/u);
    assert.throws(() => requiredChecksReport([...others, only], required), /0 jobs carry/u);
  });
});
