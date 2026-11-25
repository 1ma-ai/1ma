#!/usr/bin/env node
// Compares what GitHub enforces for main with .github/main-protection.json;
// with --apply writes the parts that differ. Needs gh signed in as an
// administrator of the repository the file names. Exit code 0: GitHub enforces
// what the file says; 1: it does not; 2: GitHub could not be read or the command
// is wrong. docs/runbooks/github-main-protection.md says when to run it.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { run } from "./lib/main-protection.mjs";

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) {
  console.error("usage: node scripts/protect-main.mjs [--apply]");
  process.exit(2);
}
const gh = (ghArgs, input) => {
  const done = spawnSync("gh", ghArgs, { encoding: "utf8", input });
  if (done.error) throw done.error;
  return done;
};
try {
  process.exitCode = run({
    apply: args.includes("--apply"),
    gh,
    text: readFileSync(new URL("../.github/main-protection.json", import.meta.url), "utf8"),
    log: (line) => console.log(line),
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
