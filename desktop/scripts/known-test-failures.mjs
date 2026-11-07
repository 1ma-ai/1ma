// Decides a shard of bb's tests on the 1ma tree. bb's tests run unchanged; a
// shard passes when turbo passed, or when every test that failed is listed in
// desktop/known-test-failures.json for the pinned bb release: a failure bb's
// own CI does not see because it runs elsewhere (another git, faster runners).
// Anything else that failed, or a failed task without a recognisable failed
// test, fails the shard. The list names the bb tag it was reviewed for, so a
// new bb release cannot inherit it unreviewed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Colour codes, raw or as GitHub's log viewer spells them (^[).
const ESCAPE = String.fromCodePoint(27);
const ANSI = new RegExp(String.raw`(?:${ESCAPE}|\^\[)\[[0-9;]*m`, "gu");
const FAILED = /(?:^|\s)FAIL\s+(.+?)\s*$/u;
const TASK = String.raw`[@\w./-]+#[\w:-]+`;
const FAILED_TASKS = new RegExp(String.raw`(?:^|\s)Failed:\s+(${TASK}(?:,\s*${TASK})*)\s*$`, "u");
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;

// vitest reports each failed test as "FAIL  <project>  <file> > <suite> > <test>"
// and a file that failed as a whole without " > <test>"; such a file, or a test
// without a project label, never matches an entry of the list.
export function failuresIn(log) {
  const tests = [];
  const tasks = new Set();
  for (const raw of log.split("\n")) {
    const line = raw.replaceAll(ANSI, "");
    const failedTasks = FAILED_TASKS.exec(line);
    if (failedTasks)
      for (const task of failedTasks[1].split(",")) if (task.trim()) tasks.add(task.trim());
    const failed = FAILED.exec(line);
    if (!failed) continue;
    const [head, ...names] = failed[1].split(" > ");
    const parts = head.trim().split(/\s+/u);
    const file = parts.find((part) => TEST_FILE.test(part)) ?? parts.at(-1);
    const label = parts[0] === file ? null : parts[0];
    const test = { package: label?.split(":")[0] ?? null, file, name: names.join(" > ") };
    if (!tests.some((seen) => sameTest(seen, test))) tests.push(test);
  }
  return { tests, tasks: [...tasks] };
}

function sameTest(a, b) {
  return a.package === b.package && a.file === b.file && a.name === b.name;
}

export function decide({ status, log, known, tag }) {
  if (known.bb !== tag)
    return {
      ok: false,
      lines: [
        `desktop/known-test-failures.json was reviewed for ${known.bb}, but 1ma now builds on ${tag}; review every entry against the new release and update its bb field`,
      ],
    };
  if (status === 0) return { ok: true, lines: [] };
  const { tests, tasks } = failuresIn(log);
  const lines = [];
  let ok = tasks.length > 0;
  if (!ok) lines.push(`turbo exited with ${status}, but no failed task was reported`);
  for (const task of tasks) {
    const [name, script] = task.split("#");
    const failed = tests.filter((test) => test.package === name);
    if (script !== "test" || failed.length === 0) {
      ok = false;
      lines.push(`${task} failed without a failed test that could be checked against the list`);
    }
  }
  for (const test of tests) {
    const entry =
      test.name === "" ? undefined : known.tests.find((candidate) => sameTest(candidate, test));
    const where = `${test.package} ${test.file} > ${test.name}`;
    if (entry) lines.push(`known failure (${entry.reason}): ${where}`);
    else {
      ok = false;
      lines.push(`new failure: ${where}`);
    }
  }
  return { ok, lines };
}

function main(argv) {
  const [logPath, statusText] = argv;
  if (!logPath || statusText === undefined)
    throw new Error(
      "usage: node desktop/scripts/known-test-failures.mjs <test log> <turbo exit status>",
    );
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const known = JSON.parse(readFileSync(path.join(desktop, "known-test-failures.json"), "utf8"));
  const { tag } = JSON.parse(readFileSync(path.join(desktop, "upstream.json"), "utf8"));
  const { ok, lines } = decide({
    status: Number(statusText),
    log: readFileSync(logPath, "utf8"),
    known,
    tag,
  });
  for (const line of lines)
    console.log(line.startsWith("known failure") ? `::warning::${line}` : `::error::${line}`);
  process.exitCode = ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
