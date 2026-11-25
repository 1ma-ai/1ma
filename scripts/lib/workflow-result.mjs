import { pathToFileURL } from "node:url";

// The verdict of a workflow whose jobs wait for its `changes` job: the one check
// a merge into main requires of it. GitHub takes a skipped job for a passed one,
// so the verdict is spelled out here: when the paths are touched every job has
// to succeed, when they are not every job has to be skipped, and an answer that
// is neither is a failure.
//
// `needs` is the workflow's `needs` context of the result job. `offPullRequests`
// names the jobs the workflow does not run for a pull request at all.
export function verdict({ needs, event, offPullRequests = [] }) {
  const { changes, ...jobs } = needs;
  if (changes === undefined) return ["the result job does not wait for the changes job"];
  if (changes.result !== "success")
    return [`the changed paths were not read: changes is ${changes.result}`];
  const changed = changes.outputs?.changed;
  if (changed !== "true" && changed !== "false")
    return [`the changes job answered ${JSON.stringify(changed)}, not true or false`];

  const problems = [];
  for (const id of offPullRequests)
    if (!Object.hasOwn(jobs, id)) problems.push(`${id} is not a job the result job waits for`);
  if (Object.keys(jobs).length === 0) problems.push("the result job waits for no job but changes");
  for (const [id, { result }] of Object.entries(jobs)) {
    const runs = changed === "true" && !(event === "pull_request" && offPullRequests.includes(id));
    const wanted = runs ? "success" : "skipped";
    if (result !== wanted) problems.push(`${id} is ${result}, it has to be ${wanted}`);
  }
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { NEEDS, GITHUB_EVENT_NAME: event, OFF_PULL_REQUESTS = "" } = process.env;
  const needs = JSON.parse(NEEDS);
  for (const [id, job] of Object.entries(needs)) console.log(`${id}: ${job.result}`);
  const problems = verdict({
    needs,
    event,
    offPullRequests: OFF_PULL_REQUESTS.split(/\s+/u).filter((id) => id !== ""),
  });
  for (const problem of problems) console.log(`::error::${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(
    needs.changes.outputs.changed === "true"
      ? "every job passed"
      : "the paths are untouched, nothing had to run",
  );
}
