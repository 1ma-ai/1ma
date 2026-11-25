import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";

// Compares what GitHub enforces for main with .github/main-protection.json and,
// asked to apply, writes the parts that differ.
//
// What is compared:
// - `actions`: the keys the file names, out of the repository's Actions settings;
// - `protection`: the required checks with their source app, reviews, push
//   restrictions, and every on/off setting GitHub reports for the branch. A
//   setting the file does not name is expected to be off, so one GitHub adds
//   later, or somebody switches on by hand, shows up as a difference;
// - `required_signatures`: reported with the branch, written through its own
//   address;
// - what the REST answer for the branch leaves out, read through GraphQL and
//   only read: `required_deployment_environments`, the deployments the classic
//   rule GitHub applies to the branch requires before a merge;
//   `bypass_force_push_allowances`, who that rule lets force push although
//   force pushes are off; `merge_queue`, whether merges into the branch go
//   through a merge queue;
// - `rules`: what the repository's rulesets add for the branch. They are only
//   read: a ruleset is removed by hand in the settings.
//
// Not covered: who may start workflows from forks and the rights of the workflow
// token; they are separate settings of the repository.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// A gh that does not finish within a minute gave no answer. It is killed, not
// asked to end: spawnSync waits for the child, and one that handles SIGTERM
// would hold the script.
export function ghRunner({ program = "gh", timeout = 60_000 } = {}) {
  return (args, input) => {
    const done = spawnSync(program, args, {
      encoding: "utf8",
      input,
      timeout,
      killSignal: "SIGKILL",
    });
    if (done.error) throw done.error;
    return done;
  };
}

const command = (method, address, body) => {
  const args = ["api", "--include", "-X", method, address];
  return body === undefined ? args : [...args, "--input", "-"];
};

// With --include gh prints the status line of the answer, its headers and an
// empty line before the body, for errors too. Status 0: no answer arrived.
function answerOf(done) {
  const text = done.stdout ?? "";
  const status = /^HTTP\/\S+ (?<status>\d{3})\b/u.exec(text)?.groups.status;
  if (status === undefined) return { status: 0, body: "" };
  const end = /\r?\n\r?\n/u.exec(text);
  return {
    status: Number(status),
    body: end === null ? "" : text.slice(end.index + end[0].length),
  };
}

const succeeded = (status) => status >= 200 && status < 300;

// With GH_DEBUG set gh prints every header it sent and got on stderr; what it
// says about a missing answer is its last line.
const SAID_AT_MOST = 300;
function lastWords(text) {
  const line = (text ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .findLast((entry) => entry !== "");
  if (line === undefined) return "gh printed nothing";
  return line.length > SAID_AT_MOST ? `${line.slice(0, SAID_AT_MOST)}…` : line;
}

function refusal(method, address, done, { status, body }) {
  if (status === 0)
    return new GitHubError(`${method} ${address}: no answer (${lastWords(done.stderr)})`, 0);
  let message;
  try {
    ({ message } = JSON.parse(body));
  } catch {
    // The body is not GitHub's JSON: the status says it all.
  }
  const said = typeof message === "string" ? `${message} ` : "";
  return new GitHubError(`${method} ${address}: ${said}(HTTP ${status})`, status);
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const listOf = (fits) => (value) => Array.isArray(value) && value.every(fits);

// A read is an answer gh read whole: gh exited 0, GitHub answered 2xx, and the
// body is JSON of the kind the caller asks for. A body cut off after the
// headers is not an empty setting.
function reader(gh) {
  return (address, fits = isObject, { method = "GET", body } = {}) => {
    const done = gh(command(method, address, body), JSON.stringify(body));
    const answer = answerOf(done);
    if (!succeeded(answer.status)) throw refusal(method, address, done, answer);
    let value;
    try {
      value = JSON.parse(answer.body);
    } catch {
      value = undefined;
    }
    if (done.status !== 0 || !fits(value))
      throw new GitHubError(
        `${method} ${address}: the answer could not be read (HTTP ${answer.status})`,
        answer.status,
      );
    return value;
  };
}

// What GitHub answered a write. It only explains what the read after the
// write shows: after a redirect gh prints the answer to the GET it turned the
// write into, and a write whose answer was lost may be done.
function attempt(gh, { method, address, body }) {
  let done;
  try {
    done = gh(command(method, address, body), JSON.stringify(body));
  } catch (error) {
    return {
      succeeded: false,
      said: `${method} ${address}: no answer (${lastWords(error.message)})`,
    };
  }
  const answer = answerOf(done);
  if (succeeded(answer.status))
    return { succeeded: true, said: `${method} ${address}: HTTP ${answer.status}` };
  return { succeeded: false, said: refusal(method, address, done, answer).message };
}

const OUTSIDE_REST = `query($owner: String!, $name: String!, $branch: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) { id }
    ref(qualifiedName: $ref) {
      branchProtectionRule {
        requiresDeployments
        requiredDeploymentEnvironments
        bypassForcePushAllowances(first: 100) {
          pageInfo { hasNextPage }
          nodes { actor { kind: __typename ... on App { slug } ... on Team { combinedSlug } ... on User { login } } }
        }
      }
    }
  }
}`;

// GitHub answers null for an actor the token may not see; it is an allowance
// all the same.
const actorName = (actor) =>
  `${actor?.kind ?? "Actor"}:${actor?.login ?? actor?.combinedSlug ?? actor?.slug ?? "unknown"}`;

// What the REST answer for the branch leaves out, in the shape of the file.
// GitHub applies one classic rule to a branch, the one its ref names.
function outsideRest(get, { repository, branch }) {
  const [owner, name] = repository.split("/");
  const answer = get("graphql", isObject, {
    method: "POST",
    body: { query: OUTSIDE_REST, variables: { owner, name, branch, ref: `refs/heads/${branch}` } },
  });
  const unreadable = () =>
    new Error(`GraphQL: the branch protection rule of ${branch} could not be read`);
  const found = answer?.data?.repository;
  if (answer?.errors !== undefined || found?.mergeQueue === undefined || found.ref === undefined)
    throw unreadable();
  if (found.ref === null) throw new Error(`GraphQL: ${repository} has no branch ${branch}`);
  const rule = found.ref.branchProtectionRule;
  if (rule === undefined) throw unreadable();
  const environments = [];
  const actors = [];
  if (rule !== null) {
    const allowances = rule.bypassForcePushAllowances;
    if (!Array.isArray(allowances?.nodes) || allowances.pageInfo?.hasNextPage) throw unreadable();
    actors.push(...allowances.nodes.map((allowance) => actorName(allowance?.actor)));
    if (rule.requiresDeployments === true) {
      if (!Array.isArray(rule.requiredDeploymentEnvironments)) throw unreadable();
      environments.push(...rule.requiredDeploymentEnvironments);
    }
  }
  return {
    required_deployment_environments: environments.toSorted(),
    bypass_force_push_allowances: actors.toSorted(),
    merge_queue: found.mergeQueue !== null,
  };
}

const byContext = (checks) => checks.toSorted((a, b) => a.context.localeCompare(b.context));
const statusChecks = (value) =>
  value == null
    ? null
    : {
        strict: value.strict,
        checks: byContext((value.checks ?? []).map(({ context, app_id }) => ({ context, app_id }))),
      };

export function addresses({ repository, branch }) {
  const protection = `repos/${repository}/branches/${branch}/protection`;
  return {
    repository: `repos/${repository}`,
    actions: `repos/${repository}/actions/permissions`,
    protection,
    statusChecks: `${protection}/required_status_checks`,
    signatures: `${protection}/required_signatures`,
    rules: `repos/${repository}/rules/branches/${branch}`,
    file: `repos/${repository}/contents/.github/main-protection.json?ref=${branch}`,
  };
}

const isProtection = (value) =>
  isObject(value) &&
  (value.required_status_checks == null ||
    (isObject(value.required_status_checks) &&
      listOf(isObject)(value.required_status_checks.checks ?? [])));

// A renamed or moved repository still answers under its old name, through a
// redirect, so the name GitHub gives is the one compared.
function identify(gh, wanted) {
  const { full_name: name } = reader(gh)(
    addresses(wanted).repository,
    (value) => isObject(value) && typeof value.full_name === "string",
  );
  if (name !== wanted.repository)
    throw new Error(
      `GitHub answers for ${name}, not for ${wanted.repository}, which ` +
        `.github/main-protection.json names: correct "repository" in the file.`,
    );
}

// What GitHub enforces now, in the shape of the file.
export function read(gh, wanted) {
  const get = reader(gh);
  const at = addresses(wanted);
  const actions = get(
    at.actions,
    (value) =>
      isObject(value) && Object.keys(wanted.actions).every((key) => Object.hasOwn(value, key)),
  );
  let live;
  try {
    live = get(at.protection, isProtection);
  } catch (error) {
    if (
      !(
        error instanceof GitHubError &&
        error.status === 404 &&
        /not protected/iu.test(error.message)
      )
    )
      throw error;
    live = null;
  }
  const flags = Object.fromEntries(
    Object.entries(live ?? {}).flatMap(([name, value]) =>
      typeof value?.enabled === "boolean" ? [[name, value.enabled]] : [],
    ),
  );
  const { required_signatures: signatures = false, ...switches } = flags;
  return {
    actions: Object.fromEntries(Object.keys(wanted.actions).map((key) => [key, actions[key]])),
    protection:
      live === null
        ? null
        : {
            required_status_checks: statusChecks(live.required_status_checks),
            required_pull_request_reviews: live.required_pull_request_reviews ?? null,
            restrictions: live.restrictions ?? null,
            ...switches,
          },
    required_signatures: signatures,
    rules: get(at.rules, listOf(isObject)).map(({ type, ruleset_id: ruleset }) => ({
      type,
      ruleset,
    })),
    ...outsideRest(get, wanted),
  };
}

// Every place where GitHub and the file disagree: { name, has, wants }.
export function differences(found, wanted) {
  const list = [];
  const compare = (name, has, wants) => {
    if (!isDeepStrictEqual(has, wants)) list.push({ name, has, wants });
  };
  for (const [key, wants] of Object.entries(wanted.actions))
    compare(`actions.${key}`, found.actions[key], wants);
  if (found.protection === null) {
    list.push({ name: "protection", has: null, wants: wanted.protection });
  } else {
    const { required_status_checks: checks, ...rest } = wanted.protection;
    compare(
      "protection.required_status_checks",
      found.protection.required_status_checks,
      statusChecks(checks),
    );
    for (const name of new Set([...Object.keys(rest), ...Object.keys(found.protection)])) {
      if (name === "required_status_checks") continue;
      const wants = Object.hasOwn(rest, name) ? rest[name] : false;
      const has = found.protection[name] ?? (typeof wants === "boolean" ? false : null);
      compare(`protection.${name}`, has, wants);
    }
  }
  compare("required_signatures", found.required_signatures, wanted.required_signatures);
  compare("rules", found.rules, wanted.rules);
  for (const name of ["required_deployment_environments", "bypass_force_push_allowances"])
    compare(name, found[name], wanted[name].toSorted());
  compare("merge_queue", found.merge_queue, wanted.merge_queue);
  return list;
}

const ofProtection = (name) => name === "protection" || name.startsWith("protection.");

// The writes that remove the differences: only the parts that differ. A write
// is done when none of the differences it owns is left after it.
export function writes(list, wanted) {
  const at = addresses(wanted);
  const names = list.map((entry) => entry.name);
  const steps = [];
  if (names.some((name) => name.startsWith("actions.")))
    steps.push({
      part: "actions",
      owns: (name) => name.startsWith("actions."),
      method: "PUT",
      address: at.actions,
      body: wanted.actions,
    });
  const protection = names.filter(ofProtection);
  if (protection.length === 1 && protection[0] === "protection.required_status_checks")
    steps.push({
      part: "required checks",
      owns: (name) => name === "protection.required_status_checks",
      method: "PATCH",
      address: at.statusChecks,
      body: wanted.protection.required_status_checks,
    });
  else if (protection.length > 0)
    steps.push({
      part: "branch protection",
      owns: ofProtection,
      method: "PUT",
      address: at.protection,
      body: wanted.protection,
    });
  if (names.includes("required_signatures"))
    steps.push({
      part: "required signatures",
      owns: (name) => name === "required_signatures",
      method: wanted.required_signatures ? "POST" : "DELETE",
      address: at.signatures,
    });
  return steps;
}

// Where the parts this script only reads are changed, by hand.
const READ_ONLY = {
  rules: "Rules come from the repository's rulesets",
  required_deployment_environments:
    "Required deployments come from the classic branch protection rules",
  bypass_force_push_allowances:
    "Who may force push past the protection comes from the classic branch protection rules",
  merge_queue: "The merge queue comes from the classic branch protection rules",
};

const show = (value) => JSON.stringify(value);
const lines = (list) =>
  list.map(
    ({ name, has, wants }) => `- ${name}: GitHub has ${show(has)}, the file says ${show(wants)}`,
  );

// Returns the exit code: 0 when GitHub enforces what the file says.
export function run({ apply, gh, text, log }) {
  const wanted = JSON.parse(text);
  const where = `${wanted.branch} of ${wanted.repository}`;
  identify(gh, wanted);
  const before = differences(read(gh, wanted), wanted);
  if (before.length === 0) {
    log(`${where} is protected as .github/main-protection.json says`);
    return 0;
  }
  log(`${where} is not protected as .github/main-protection.json says:`);
  for (const line of lines(before)) log(line);
  if (!apply) return 1;

  let onBranch;
  try {
    const { content } = reader(gh)(
      addresses(wanted).file,
      (value) => isObject(value) && typeof value.content === "string",
    );
    onBranch = Buffer.from(content, "base64").toString("utf8");
  } catch (error) {
    if (!(error instanceof GitHubError && error.status === 404)) throw error;
    onBranch = null;
  }
  if (onBranch !== text) {
    log(
      `Nothing was changed: .github/main-protection.json here is not the file on ${where}. ` +
        "Merge the change of the file first, then apply it from the merged commit.",
    );
    return 1;
  }

  const written = [];
  let left = before;
  let stop = null;
  for (const step of writes(before, wanted)) {
    const answer = attempt(gh, step);
    try {
      left = differences(read(gh, wanted), wanted);
    } catch (error) {
      if (written.length > 0) log(`Written: ${written.join(", ")}.`);
      log(
        `Writing ${step.part}: GitHub could not be read after it, so it is not known ` +
          `whether it was written (the answer was ${answer.said}).`,
      );
      throw error;
    }
    const owned = left.filter(({ name }) => step.owns(name)).map(({ name }) => name);
    if (owned.length > 0) {
      stop = { step, answer, owned };
      break;
    }
    written.push(step.part);
    if (!answer.succeeded)
      log(`${step.part}: GitHub shows it written, although the answer was ${answer.said}.`);
  }
  if (stop === null) {
    log(`Written: ${written.join(", ") || "nothing"}.`);
  } else {
    const { step, answer, owned } = stop;
    log(
      answer.succeeded
        ? `Not written: ${step.part}. GitHub answered success (${answer.said}), ` +
            `yet it still differs from the file in ${owned.join(", ")}.`
        : `Not written: ${step.part}. GitHub still differs from the file in ` +
            `${owned.join(", ")}; the answer was ${answer.said}.`,
    );
    log(written.length > 0 ? `Already written: ${written.join(", ")}.` : "Nothing was written.");
  }
  if (left.length === 0) {
    log(`${where} is now protected as the file says`);
    return 0;
  }
  log("GitHub still differs from the file:");
  for (const line of lines(left)) log(line);
  for (const { name } of left)
    if (Object.hasOwn(READ_ONLY, name))
      log(`${READ_ONLY[name]}; this script does not change them.`);
  return 1;
}
