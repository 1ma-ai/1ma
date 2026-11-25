import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { pathspecs } from "./changed-paths.mjs";

const directory = new URL("../../.github/workflows/", import.meta.url);
const root = fileURLToPath(new URL("../../", import.meta.url));
const repository = {
  workflows: readdirSync(directory)
    .filter((name) => /\.ya?ml$/u.test(name))
    .map((file) => ({
      name: file,
      ...parse(readFileSync(new URL(file, directory), "utf8")),
      file,
    })),
  required: JSON.parse(
    readFileSync(new URL("../../.github/main-protection.json", import.meta.url), "utf8"),
  ).protection.required_status_checks.checks,
};

const jobsOf = (workflow) => Object.entries(workflow.jobs);
const needsOf = (job) => [job.needs ?? []].flat();
const eventsOf = ({ on }) =>
  typeof on === "string" ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
// The filters of one event; `on` written as a name or a list of names has none.
const triggerOf = ({ on }, event) =>
  typeof on === "object" && on !== null && !Array.isArray(on) ? (on[event] ?? {}) : {};
const listed = (value) => (value === undefined ? undefined : [value].flat());
const onPullRequests = (workflow) => eventsOf(workflow).includes("pull_request");
const isGated = (workflow) => workflow.jobs.changes !== undefined;
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
// A step without a name is known by its run text.
const nameOf = (step) => step.name ?? step.run;
const listings = new Map();
const tracked = (...specs) => {
  const key = JSON.stringify(specs);
  if (!listings.has(key))
    listings.set(
      key,
      execFileSync("git", ["-C", root, "ls-files", "--", ...specs], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line !== ""),
    );
  return listings.get(key);
};

// A result job is what gives a gated workflow its verdict. While a required
// check is renamed a workflow has two.
const isResult = (job) => (job.steps ?? []).some((step) => scriptOf(step) === VERDICT);
const resultsOf = (workflow) => jobsOf(workflow).filter(([, job]) => isResult(job));
const workOf = (workflow) =>
  Object.keys(workflow.jobs).filter((id) => id !== "changes" && !isResult(workflow.jobs[id]));
const verdictOf = (job) => job.steps.find((step) => scriptOf(step) === VERDICT);
const requiredOf = (workflow, required) =>
  jobsOf(workflow).filter(([id, job]) =>
    required.some((check) => check.context === (job.name ?? id)),
  );

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

// The steps of workflows with a required check that are the work the check
// stands for: what each has to run, and why a green result means little
// without it. A step is listed when its job stays green without it and the
// check then says less. Steps the later ones cannot do without (checkout,
// installs, preparing the tree) are not listed: without them the job fails
// anyway; of such a step only a command the later ones do without is listed.
//
// A command counts on a line of `run` that is not a comment. This is not a
// shell parser: a command after `#` on its line, in a heredoc, in a function
// nobody calls or behind a condition that is never true still counts.
const WORK_STEPS = {
  "ci.yml check pnpm run check:marketplace": [
    ["pnpm run check:marketplace"],
    "the marketplace entries match the plugins",
  ],
  "ci.yml check pnpm run check:brand": [
    ["pnpm run check:brand"],
    "the committed brand assets are the ones the brand sources make",
  ],
  "ci.yml check pnpm run lint": [["pnpm run lint"], "the lint the check is named after"],
  "ci.yml check pnpm run format:check": [["pnpm run format:check"], "the formatting of every file"],
  "ci.yml check pnpm run typecheck": [["pnpm run typecheck"], "the typecheck of every plugin"],
  "ci.yml check pnpm run test": [["pnpm run test"], "the tests of every plugin"],
  "ci.yml check pnpm run test:scripts": [
    ["pnpm run test:scripts"],
    "the tests of the scripts, these shape tests among them",
  ],
  "ci.yml check Build every plugin with the pinned bb": [
    ["pnpm run build"],
    "every plugin builds with the bb it is developed against",
  ],
  "ci.yml check Install and build every plugin the way bb installs it from git": [
    ["pnpm run check:git-install"],
    "a plugin that builds here can still fail to install from git",
  ],
  "ci.yml workflows Lint workflow files with actionlint": [
    ["set -euo pipefail", "sha256sum -c -", '"$RUNNER_TEMP/actionlint"'],
    "actionlint's verdict, from the binary its checksums name",
  ],
  "bots-e2e.yml e2e Run the end-to-end tests": [
    ["e2e/bots/bots.test.mjs"],
    "the end-to-end tests are what the check reports",
  ],
  "desktop.yml patches Test the rebrand rules": [
    ["--filter 1ma-desktop-tooling run test"],
    "the tests of the tooling that applies the patches and the rebrand",
  ],
  "desktop.yml patches Run bb's own source checks on the patched tree": [
    [
      "scripts/check-source-nul.mjs",
      "scripts/check-provider-literal-ratchet.mjs",
      "scripts/check-test-process-identity.mjs",
      "scripts/check-branch-ref-owner.mjs",
    ],
    "bb's checks of its own sources, on the patched tree",
  ],
  "desktop.yml patches Check the embedded 1ma plugins for literal NUL bytes, as bb checks its own sources":
    [["desktop/scripts/check-plugin-nul.mjs"], "bb's own NUL check does not read the 1ma plugins"],
  "desktop.yml linux-server Number the build (the next bb patch, as a prerelease naming this run)":
    [
      [
        'desktop/scripts/version.mjs" next',
        'node scripts/bump-version.mjs "$version"',
        'mv "$RUNNER_TEMP/provenance.json" 1ma-provenance.json',
      ],
      "desktop-release.yml publishes only a build whose version names its run",
    ],
  "desktop.yml linux-server Typecheck the server and the plugins the 1ma patches touch, as bb's CI does":
    [["turbo run typecheck"], "the patched server is typechecked before it is packed"],
  "desktop.yml linux-server Build the server package and smoke-test its tarball, as bb does before publishing":
    [["smoke:tarball"], "the server package starts from its tarball"],
  "desktop.yml linux-server Pack the server package": [
    ['cp 1ma-provenance.json "$RUNNER_TEMP/server/"'],
    "desktop-release.yml refuses a server package without its provenance; the upload passes without it",
  ],
  "desktop.yml linux-server Start the packed server from an empty folder and check the built-in 1ma plugins over HTTP":
    [["desktop/scripts/smoke-builtin-plugins.mjs"], "the packed server serves the 1ma plugins"],
  "desktop.yml linux-server A change to an embedded 1ma plugin alone reaches the server package without --force":
    [['grep -q "$marker"'], "a change of a plugin is not lost to turbo's cache"],
  "desktop.yml macos Number the build (the next bb patch, as a prerelease naming this run)": [
    [
      'desktop/scripts/version.mjs" next',
      'node scripts/bump-version.mjs "$version"',
      'mv "$RUNNER_TEMP/provenance.json" 1ma-provenance.json',
    ],
    "desktop-release.yml publishes only a build whose version names its run",
  ],
  "desktop.yml macos Verify arm64 runner": [
    ['test "$(uname -m)" = "arm64"'],
    "the app is tested and started on the architecture it is built for",
  ],
  "desktop.yml macos Put the 1ma plugins in as built-in plugins": [
    ["desktop/scripts/embed-plugins.mjs"],
    "nothing on macOS fails when the app lacks the plugins 1ma embeds",
  ],
  "desktop.yml macos Typecheck desktop, launcher and config": [
    ["turbo run typecheck"],
    "the patched app is typechecked before it is packaged",
  ],
  "desktop.yml macos Test desktop, launcher and config": [
    ["turbo run test"],
    "bb's tests of the app, on macOS",
  ],
  "desktop.yml macos Verify the ad-hoc signature of the app in the DMG and the ZIP": [
    ["set -euo pipefail", "codesign --verify"],
    "an unsigned app does not open on Apple Silicon; without -e only the last check counts",
  ],
  "desktop.yml macos Smoke test the packaged app": [["smoke:packaged"], "the packaged app starts"],
  "desktop.yml macos Generate the version feed": [
    ["desktop:version-feed"],
    "desktop-release.yml takes the version from desktop-version.json; the upload passes without it",
  ],
  "desktop-tests.yml plan Plan the shards with bb's own CI planner at the pinned commit": [
    ["scripts/plan-ci.mjs --full", "desktop/scripts/shard-matrix.mjs"],
    "every shard of bb's suite, not the ones a diff selects",
  ],
  "desktop-tests.yml static Put the 1ma plugins in as built-in plugins": [
    ["desktop/scripts/embed-plugins.mjs"],
    "bb's checks pass without the plugins 1ma embeds",
  ],
  "desktop-tests.yml static Lint and typecheck, as bb's CI does": [
    ["turbo run lint lint:type-aware typecheck"],
    "bb's static checks are what the job reports",
  ],
  "desktop-tests.yml tests Put the 1ma plugins in as built-in plugins": [
    ["desktop/scripts/embed-plugins.mjs"],
    "bb's tests pass without the plugins 1ma embeds",
  ],
  "desktop-tests.yml tests Regenerate the PWA icon variants from the 1ma icons, as bb's app build does":
    [["generate:pwa-icons"], "the app shards otherwise test bb's icons, not the ones 1ma ships"],
  "desktop-tests.yml tests Test": [
    ["turbo run test", "desktop/scripts/known-test-failures.mjs"],
    "bb's tests; after set +e the script gives the step its status",
  ],
  "desktop-tests.yml tests Test native browser address interactions": [
    ["smoke:browser-address"],
    "the desktop shard's smoke test, which turbo run test does not run",
  ],
};

// The events a workflow with a required check starts on, no more and no
// fewer. The check has to report for the commit of a pull request:
// pull_request_target runs the code of the base, merge_group comes only from
// a merge queue, which main does not use, and workflow_call and workflow_run
// start the workflow from another one. Bots has no push run, so after a
// rename of its required check (docs/runbooks/github-main-protection.md) only
// workflow_dispatch gives main a status under the new name.
const TRIGGERS = {
  "ci.yml": ["push", "pull_request", "schedule", "workflow_dispatch"],
  "bots-e2e.yml": ["pull_request", "workflow_dispatch"],
  "desktop.yml": ["push", "pull_request", "workflow_dispatch"],
  "desktop-tests.yml": ["push", "pull_request", "workflow_dispatch"],
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
  [undefined, ".", "./", "${{ github.workspace }}"].includes(
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
    assert.equal(job.if, "always()", `${where} is not run after a failure`);
    assert.deepEqual(
      needsOf(job).toSorted(),
      ["changes", ...work].toSorted(),
      `${where} does not wait for every job`,
    );
    const step = verdictOf(job);
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

const workStepOf = (key) => {
  const [file, job, ...words] = key.split(" ");
  return { file, job, name: words.join(" "), runs: WORK_STEPS[key][0] };
};

const commandLines = (step) =>
  (step.run ?? "").split("\n").filter((line) => !line.trimStart().startsWith("#"));

function doesItsWork(workflow) {
  for (const { file, job, name, runs } of Object.keys(WORK_STEPS).map(workStepOf)) {
    if (file !== workflow.file) continue;
    const step = (workflow.jobs[job]?.steps ?? []).find((entry) => nameOf(entry) === name);
    assert.ok(step !== undefined, `${workflow.name} ${job} lacks "${name}"`);
    const lines = commandLines(step);
    for (const run of runs)
      assert.ok(
        lines.some((line) => line.includes(run)),
        `${workflow.name} ${job} "${name}" does not run ${run}`,
      );
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
  const trigger = triggerOf(workflow, "pull_request");
  for (const key of ["paths", "paths-ignore", "branches-ignore"])
    assert.equal(trigger[key], undefined, `${workflow.name}: pull_request.${key}`);
  const branches = listed(trigger.branches);
  if (branches !== undefined)
    assert.ok(
      branches.includes("main") && !branches.some((branch) => String(branch).startsWith("!")),
      `${workflow.name}: pull_request.branches leaves out main`,
    );
  const types = listed(trigger.types);
  if (types !== undefined)
    for (const type of ["opened", "synchronize", "reopened"])
      assert.ok(types.includes(type), `${workflow.name}: pull_request.types lacks ${type}`);
}

function startsOnTheListedEvents(workflow) {
  const events = TRIGGERS[workflow.file];
  assert.ok(events !== undefined, `${workflow.name}: this test lists no events for it`);
  const starts = eventsOf(workflow);
  for (const event of events)
    assert.ok(
      starts.includes(event),
      `${workflow.name} does not start on ${event}, which this test lists for it`,
    );
  for (const event of starts)
    assert.ok(
      events.includes(event),
      `${workflow.name} starts on ${event}, which this test does not list for it`,
    );
}

// A push run of a workflow with a required check is chosen by branch and path
// alone: tags start it on a tag as well, and these tests read the paths of
// `paths` and the branches of `branches` only.
function pushesByBranchAndPath(workflow) {
  if (!eventsOf(workflow).includes("push")) return;
  const push = triggerOf(workflow, "push");
  for (const key of Object.keys(push))
    assert.ok(["branches", "paths"].includes(key), `${workflow.name}: push.${key}`);
  for (const branch of listed(push.branches) ?? [])
    assert.ok(
      !String(branch).startsWith("!"),
      `${workflow.name}: push.branches negates ${String(branch).slice(1)}`,
    );
}

const GATED_SHAPE = [waitsForTheAnswer, resultJobsJudgeEveryJob, readsWhatItDecidesBy];
const shapeOf = (workflow, required) => {
  if (requiredOf(workflow, required).length > 0) {
    nothingMasksAFailure(workflow);
    startsOnTheListedEvents(workflow);
    pushesByBranchAndPath(workflow);
    doesItsWork(workflow);
  }
  if (isGated(workflow)) for (const check of GATED_SHAPE) check(workflow);
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
  for (const workflow of all.filter(onPullRequests))
    assert.ok(
      requiredOf(workflow, checks).length > 0,
      `${workflow.name}: nothing of it is required`,
    );
}

// desktop-release.yml publishes a Desktop build of main only with a green push
// run of desktop-tests.yml on main for the same commit.
function startsOnPushesToMain(workflow) {
  assert.ok(eventsOf(workflow).includes("push"), `${workflow.name} does not start on push`);
  pushesByBranchAndPath(workflow);
  const branches = listed(triggerOf(workflow, "push").branches);
  assert.ok(
    branches === undefined || branches.includes("main"),
    `${workflow.name}: push.branches leaves out main`,
  );
}
const includes = (paths) => paths.filter((path) => !path.startsWith("!"));
const excludes = (paths) => paths.filter((path) => path.startsWith("!"));
function testsFollowBuilds(build, tests) {
  for (const workflow of [build, tests]) startsOnPushesToMain(workflow);
  const [built, tested] = [build, tests].map((workflow) =>
    listed(triggerOf(workflow, "push").paths),
  );
  if (tested === undefined) return;
  assert.ok(
    built !== undefined,
    `bb tests skip the pushes outside their paths, on which ${build.name} builds`,
  );
  for (const path of includes(built)) assert.ok(tested.includes(path), `bb tests skip ${path}`);
  for (const path of excludes(tested))
    assert.ok(built.includes(path), `bb tests leave out ${path}`);
}

const stepOf = (workflow, job, name) =>
  workflow.jobs[job].steps.find((step) => nameOf(step) === name);
// `on` as a map of events, whichever way the workflow writes it.
const eventMapOf = (workflow) => {
  if (typeof workflow.on === "string" || Array.isArray(workflow.on))
    workflow.on = Object.fromEntries(eventsOf(workflow).map((event) => [event, null]));
  return workflow.on;
};

// Every test of this file, on one state of the workflows and the required checks.
function register({ workflows, required }) {
  const gated = workflows.filter(isGated);
  const carrying = workflows.filter((workflow) => requiredOf(workflow, required).length > 0);
  const copyOf = (file, change = () => {}) => {
    const workflow = structuredClone(workflows.find((entry) => entry.file === file));
    change(workflow);
    return workflow;
  };
  const firstResultOf = (file) => resultsOf(copyOf(file))[0][0];
  const desktopPair = () => ["desktop.yml", "desktop-tests.yml"].map((file) => copyOf(file));
  const breaks = (workflow, expected) =>
    assert.throws(
      () => shapeOf(workflow, required),
      typeof expected === "string" ? (error) => error.message.includes(expected) : expected,
    );

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
      for (const workflow of workflows.filter(onPullRequests))
        startsOnPullRequestsIntoMain(workflow);
    });

    test("a workflow with a required check starts on exactly the events this test lists for it", () => {
      assert.ok(carrying.length > 0);
      for (const workflow of carrying) startsOnTheListedEvents(workflow);
    });

    test("a workflow with a required check starts on pushes by branch and path alone", () => {
      for (const workflow of carrying) pushesByBranchAndPath(workflow);
    });

    test("a workflow that starts on main only for some paths asks pull requests about the same paths", () => {
      for (const workflow of workflows) {
        const paths = listed(triggerOf(workflow, "push").paths);
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

    test("no job of a workflow with a required check passes when its work fails or is left out", () => {
      for (const workflow of carrying) nothingMasksAFailure(workflow);
    });

    test("every step that is the work of a required check is there and runs that work", () => {
      for (const { file } of Object.keys(WORK_STEPS).map(workStepOf))
        assert.ok(
          carrying.some((workflow) => workflow.file === file),
          `${file} carries no required check`,
        );
      for (const workflow of carrying) doesItsWork(workflow);
    });

    test("the answer the jobs wait for is the one the script writes", () => {
      for (const workflow of gated) {
        const { changes } = workflow.jobs;
        const checkout = changes.steps.find(isCheckout);
        assert.equal(
          checkout.with["fetch-depth"],
          2,
          `${workflow.name}: the merge needs its parent`,
        );
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
      testsFollowBuilds(...desktopPair());
      const [wider, tests] = desktopPair();
      wider.on.push.paths.push("docs/**");
      assert.throws(() => testsFollowBuilds(wider, tests), /bb tests skip docs/u);
      const [build, narrower] = desktopPair();
      narrower.on.push.paths.push("!brand/**");
      assert.throws(() => testsFollowBuilds(build, narrower), /bb tests leave out !brand/u);
    });
  });

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
      breaks(
        copyOf("ci.yml", (w) => {
          const [[, job]] = requiredOf(w, required);
          job["continue-on-error"] = true;
        }),
        /CI \S+ may fail and pass/u,
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

    test("a step that is the work of a required check, removed, made to do nothing, or left in a comment", () => {
      breaks(
        copyOf("desktop-tests.yml", (w) => {
          w.jobs.tests.steps = w.jobs.tests.steps.filter(
            (step) => step.name !== "Test native browser address interactions",
          );
        }),
        /tests lacks "Test native browser address interactions"/u,
      );
      breaks(
        copyOf("bots-e2e.yml", (w) => {
          stepOf(w, "e2e", "Run the end-to-end tests").run =
            "# node --test e2e/bots/bots.test.mjs\necho skipped";
        }),
        /e2e "Run the end-to-end tests" does not run e2e\/bots\/bots\.test\.mjs/u,
      );
      for (const { file, job, name } of Object.keys(WORK_STEPS).map(workStepOf)) {
        // A step known by its run text is gone once the text changes.
        const emptied =
          stepOf(copyOf(file), job, name)?.name === undefined
            ? `${job} lacks "${name}"`
            : `${job} "${name}" does not run`;
        breaks(
          copyOf(file, (w) => {
            stepOf(w, job, name).run = "true";
          }),
          emptied,
        );
        breaks(
          copyOf(file, (w) => {
            const step = stepOf(w, job, name);
            step.run = `${step.run
              .split("\n")
              .map((line) => `# ${line}`)
              .join("\n")}\ntrue`;
          }),
          emptied,
        );
        breaks(
          copyOf(file, (w) => {
            w.jobs[job].steps = w.jobs[job].steps.filter((step) => nameOf(step) !== name);
          }),
          `${job} lacks "${name}"`,
        );
      }
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
          for (const [, job] of resultsOf(w)) verdictOf(job).env.OFF_PULL_REQUESTS = "tests";
        }),
        /tests is kept off pull requests without a reason/u,
      );
    });

    test("a result job that does not check the verdict script out first", () => {
      const id = firstResultOf("bots-e2e.yml");
      breaks(
        copyOf("bots-e2e.yml", (w) => {
          w.jobs[id].steps = w.jobs[id].steps.filter((step) => !isCheckout(step));
        }),
        `${id}: the script is not checked out`,
      );
      breaks(
        copyOf("bots-e2e.yml", (w) => {
          w.jobs[id].steps.reverse();
        }),
        `${id}: the script is not checked out`,
      );
    });

    test("a result job that does not wait for every job, or is not run after a failure", () => {
      const tests = firstResultOf("desktop-tests.yml");
      breaks(
        copyOf("desktop-tests.yml", (w) => {
          w.jobs[tests].needs = ["changes", "plan", "static"];
        }),
        `Desktop bb tests ${tests} does not wait for every job`,
      );
      const bots = firstResultOf("bots-e2e.yml");
      breaks(
        copyOf("bots-e2e.yml", (w) => {
          delete w.jobs[bots].if;
        }),
        `Bots end-to-end ${bots} is not run after a failure`,
      );
    });

    test("a pull request into main the workflow does not start on", () => {
      for (const [trigger, error] of [
        [{ branches: ["release-only"] }, /pull_request\.branches leaves out main/u],
        [{ branches: ["main", "!main"] }, /pull_request\.branches leaves out main/u],
        [{ "branches-ignore": ["main"] }, /pull_request\.branches-ignore/u],
        [{ paths: ["plugins/**"] }, /pull_request\.paths/u],
        [{ "paths-ignore": ["docs/**"] }, /pull_request\.paths-ignore/u],
        [{ types: ["opened"] }, /pull_request\.types lacks synchronize/u],
      ])
        breaks(
          copyOf("bots-e2e.yml", (w) => {
            eventMapOf(w).pull_request = trigger;
          }),
          error,
        );
      assert.doesNotThrow(() =>
        shapeOf(
          copyOf("bots-e2e.yml", (w) => {
            w.on.pull_request = {
              branches: ["main"],
              types: ["opened", "synchronize", "reopened"],
            };
          }),
          required,
        ),
      );
    });

    test("a workflow with a required check that also starts on an event this test does not list", () => {
      for (const { file } of carrying)
        for (const event of ["pull_request_target", "merge_group", "workflow_call", "workflow_run"])
          breaks(
            copyOf(file, (w) => {
              eventMapOf(w)[event] = null;
            }),
            `starts on ${event}, which this test does not list`,
          );
    });

    test("a workflow with a required check that does not start on an event this test lists", () => {
      for (const { file } of carrying)
        for (const event of TRIGGERS[file])
          breaks(
            copyOf(file, (w) => {
              delete eventMapOf(w)[event];
            }),
            `does not start on ${event}, which this test lists for it`,
          );
    });

    test("events written as a name or a list, which have no filters", () => {
      for (const on of ["pull_request", ["pull_request"]])
        breaks(
          copyOf("bots-e2e.yml", (w) => {
            w.on = on;
          }),
          /Bots end-to-end does not start on workflow_dispatch/u,
        );
      assert.doesNotThrow(() =>
        shapeOf(
          copyOf("bots-e2e.yml", (w) => {
            w.on = ["pull_request", "workflow_dispatch"];
          }),
          required,
        ),
      );
      breaks(
        copyOf("ci.yml", (w) => {
          w.on = "pull_request";
        }),
        /CI does not start on push/u,
      );
      const anyPush = (file) =>
        copyOf(file, (w) => {
          w.on = ["push", "pull_request", "workflow_dispatch"];
        });
      for (const file of ["desktop.yml", "desktop-tests.yml"])
        assert.doesNotThrow(() => shapeOf(anyPush(file), required), file);
      assert.doesNotThrow(() =>
        testsFollowBuilds(copyOf("desktop.yml"), anyPush("desktop-tests.yml")),
      );
      assert.throws(
        () => testsFollowBuilds(anyPush("desktop.yml"), copyOf("desktop-tests.yml")),
        /bb tests skip the pushes outside their paths/u,
      );
    });

    test("a push run of a workflow with a required check chosen by more than branch and path", () => {
      for (const { file } of carrying.filter((workflow) => eventsOf(workflow).includes("push"))) {
        breaks(
          copyOf(file, (w) => {
            w.on.push = { ...triggerOf(w, "push"), tags: ["desktop/v*"] };
          }),
          `: push.tags`,
        );
        breaks(
          copyOf(file, (w) => {
            w.on.push = { ...triggerOf(w, "push"), "branches-ignore": ["release-only"] };
            delete w.on.push.branches;
          }),
          `: push.branches-ignore`,
        );
        breaks(
          copyOf(file, (w) => {
            w.on.push = { ...triggerOf(w, "push"), "paths-ignore": ["docs/**"] };
            delete w.on.push.paths;
          }),
          `: push.paths-ignore`,
        );
        breaks(
          copyOf(file, (w) => {
            w.on.push = { ...triggerOf(w, "push"), branches: ["main", "!release-only"] };
          }),
          `: push.branches negates release-only`,
        );
      }
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
            `does not ask about ${file}`,
          );
      for (const folder of [".", "./", "${{ github.workspace }}"])
        for (const where of ["step", "job default"])
          breaks(
            copyOf("bots-e2e.yml", (w) => {
              const { e2e } = w.jobs;
              const install = e2e.steps.find((step) => installsAtRoot(e2e, step));
              if (where === "step") install["working-directory"] = folder;
              else e2e.defaults = { run: { "working-directory": folder } };
              asking(w).env.PATHS = asked(w)
                .filter((path) => path !== "package.json")
                .join("\n");
            }),
            "does not ask about package.json",
          );
    });

    test("a Desktop workflow that does not start on pushes to main", () => {
      for (const [push, error] of [
        [{ branches: ["release-only"] }, /push\.branches leaves out main/u],
        [{ branches: ["main", "!main"] }, /push\.branches negates main/u],
        [{ "branches-ignore": ["release-only"] }, /push\.branches-ignore/u],
        [{ tags: ["desktop/v*"] }, /push\.tags/u],
      ])
        for (const index of [0, 1]) {
          const pair = desktopPair();
          pair[index].on.push = { ...push, paths: pair[index].on.push.paths };
          assert.throws(() => testsFollowBuilds(...pair), error);
        }
      for (const index of [0, 1]) {
        const pair = desktopPair();
        delete pair[index].on.push;
        assert.throws(() => testsFollowBuilds(...pair), /does not start on push/u);
      }
    });
  });

  describe("protection of main", () => {
    test("every required check is a job that reports on every pull request, and every such workflow has one", () => {
      requiredChecksReport(workflows, required);
    });

    test("a second result job judges every job, and a required name has a job until it is no longer required", () => {
      for (const workflow of gated) {
        const [[id, job]] = requiredOf(workflow, required);
        const spare = { ...structuredClone(job), name: `${job.name ?? id} spare` };
        breaks(
          copyOf(workflow.file, (w) => {
            w.jobs.spare_result = { ...spare, needs: ["changes"] };
          }),
          `${workflow.name} spare_result does not wait for every job`,
        );
        const only = copyOf(workflow.file, (w) => {
          for (const [result] of resultsOf(w)) delete w.jobs[result];
          w.jobs.spare_result = spare;
        });
        assert.throws(
          () =>
            requiredChecksReport(
              workflows.map((entry) => (entry.file === workflow.file ? only : entry)),
              required,
            ),
          /0 jobs carry/u,
        );
      }
    });
  });
}

// docs/runbooks/github-main-protection.md renames a required check in three
// pull requests; each of them has to pass this file. The new job takes an id
// its workflow does not use and a name no job and no required check has.
const RENAME_STEPS = [
  "both result jobs, the old name required",
  "both result jobs, the new name required",
  "only the new result job, the new name required",
];
const unused = (base, taken, joint) => {
  let candidate = base;
  for (let count = 2; taken.has(candidate); count += 1) candidate = `${base}${joint}${count}`;
  return candidate;
};
function renamed({ workflows, required }, file, step) {
  const workflow = structuredClone(workflows.find((entry) => entry.file === file));
  const [[id, job]] = requiredOf(workflow, required);
  const old = job.name ?? id;
  const names = new Set([
    ...workflows.flatMap((entry) => jobsOf(entry).map(([key, other]) => other.name ?? key)),
    ...required.map((check) => check.context),
  ]);
  const name = unused(`${old} after a rename`, names, " ");
  workflow.jobs[unused("renamed_result", new Set(Object.keys(workflow.jobs)), "_")] = {
    ...structuredClone(job),
    name,
  };
  if (step === 2) delete workflow.jobs[id];
  return {
    workflows: workflows.map((entry) => (entry.file === file ? workflow : entry)),
    required:
      step === 0
        ? required
        : required.map((check) => (check.context === old ? { ...check, context: name } : check)),
  };
}

// The repository with a work job of Bots under the id the rename starts from,
// and a job in another workflow under the name it starts from.
function crowded({ workflows, required }) {
  const change = (file, edit) => {
    const workflow = structuredClone(workflows.find((entry) => entry.file === file));
    edit(workflow);
    return workflow;
  };
  const bots = change("bots-e2e.yml", (w) => {
    w.jobs.renamed_result = {
      name: "More end-to-end tests",
      needs: "changes",
      if: CHANGED,
      "runs-on": "ubuntu-latest",
      steps: [{ run: "true" }],
    };
    for (const [, job] of resultsOf(w)) job.needs = [...needsOf(job), "renamed_result"];
  });
  const [[id, result]] = requiredOf(bots, required);
  const ci = change("ci.yml", (w) => {
    w.jobs.namesake = {
      name: `${result.name ?? id} after a rename`,
      "runs-on": "ubuntu-latest",
      steps: [{ run: "true" }],
    };
  });
  const changed = { "bots-e2e.yml": bots, "ci.yml": ci };
  return {
    workflows: workflows.map((entry) => changed[entry.file] ?? entry),
    required,
  };
}

register(repository);
for (const { file, name } of repository.workflows.filter(isGated))
  for (const [step, state] of RENAME_STEPS.entries())
    describe(`${name} with its required check renamed, ${state}`, () => {
      register(renamed(repository, file, step));
    });
for (const [step, state] of RENAME_STEPS.entries())
  describe(`Bots end-to-end renamed where a job has the first id and another the first name, ${state}`, () => {
    register(renamed(crowded(repository), "bots-e2e.yml", step));
  });
