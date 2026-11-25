#!/usr/bin/env node
// Compares what GitHub enforces for main with .github/main-protection.json, or
// applies the file with --apply. Needs gh signed in as an administrator of the
// repository. Run it after every change of the file.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const wanted = JSON.parse(
  readFileSync(new URL("../.github/main-protection.json", import.meta.url), "utf8"),
);
const gh = (args, input) =>
  execFileSync("gh", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });
const repository = gh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
const actionsPath = `repos/${repository}/actions/permissions`;
const protectionPath = `repos/${repository}/branches/main/protection`;

if (process.argv.includes("--apply")) {
  gh(["api", "-X", "PUT", actionsPath, "--input", "-"], JSON.stringify(wanted.actions));
  gh(["api", "-X", "PUT", protectionPath, "--input", "-"], JSON.stringify(wanted.protection));
}

const actions = JSON.parse(gh(["api", actionsPath]));
const live = JSON.parse(gh(["api", protectionPath]));
const flag = (name) => live[name]?.enabled ?? false;
const found = {
  actions: Object.fromEntries(Object.keys(wanted.actions).map((key) => [key, actions[key]])),
  protection: {
    required_status_checks: {
      strict: live.required_status_checks?.strict,
      checks: (live.required_status_checks?.checks ?? []).map(({ context, app_id }) => ({
        context,
        app_id,
      })),
    },
    enforce_admins: flag("enforce_admins"),
    required_pull_request_reviews: live.required_pull_request_reviews ?? null,
    restrictions: live.restrictions ?? null,
    required_linear_history: flag("required_linear_history"),
    allow_force_pushes: flag("allow_force_pushes"),
    allow_deletions: flag("allow_deletions"),
    required_conversation_resolution: flag("required_conversation_resolution"),
  },
};
const byContext = (checks) => checks.toSorted((a, b) => a.context.localeCompare(b.context));
found.protection.required_status_checks.checks = byContext(
  found.protection.required_status_checks.checks,
);
const expected = structuredClone({ actions: wanted.actions, protection: wanted.protection });
expected.protection.required_status_checks.checks = byContext(
  expected.protection.required_status_checks.checks,
);
if (!isDeepStrictEqual(found, expected)) {
  console.error("main is not protected as .github/main-protection.json says.");
  console.error(`GitHub has:\n${JSON.stringify(found, null, 2)}`);
  console.error(`The file says:\n${JSON.stringify(expected, null, 2)}`);
  process.exit(1);
}
console.log(`main of ${repository} is protected as .github/main-protection.json says`);
