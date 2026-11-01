import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const desktop = path.join(repo, "desktop");
const upstream = JSON.parse(readFileSync(path.join(desktop, "upstream.json"), "utf8"));

const ASSETS = [
  ["brand/1ma.icns", "apps/desktop/assets/icon.icns"],
  ["brand/1ma.icns", "apps/desktop/assets/icon-nightly.icns"],
  ["brand/app-icon-1024.png", "apps/desktop/assets/icon.png"],
  ["brand/app-icon-1024.png", "apps/desktop/assets/icon-nightly.png"],
  ["brand/app-icon-1024.png", "apps/desktop/assets/icon-dev.png"],
  ["plugins/1ma-brand/assets/app-icon-192.png", "apps/app/public/icon-192.png"],
  ["plugins/1ma-brand/assets/app-icon-512.png", "apps/app/public/icon-512.png"],
  ["plugins/1ma-brand/assets/app-icon-192-maskable.png", "apps/app/public/icon-192-maskable.png"],
  ["plugins/1ma-brand/assets/app-icon-512-maskable.png", "apps/app/public/icon-512-maskable.png"],
  ["plugins/1ma-brand/assets/apple-touch-icon.png", "apps/app/public/apple-touch-icon.png"],
  ["plugins/1ma-brand/assets/favicon-16.png", "apps/app/public/favicon-16x16.png"],
  ["plugins/1ma-brand/assets/favicon-16.png", "apps/app/public/favicon-16x16-dark.png"],
  ["plugins/1ma-brand/assets/favicon-16.png", "apps/app/public/favicon-16x16-dev.png"],
  ["plugins/1ma-brand/assets/favicon-32.png", "apps/app/public/favicon-32x32.png"],
  ["plugins/1ma-brand/assets/favicon-32.png", "apps/app/public/favicon-32x32-dark.png"],
  ["plugins/1ma-brand/assets/favicon-32.png", "apps/app/public/favicon-32x32-dev.png"],
  ["plugins/1ma-brand/assets/icon.svg", "assets/bb-logo.svg"],
];

function parseArgs(argv) {
  const index = argv.indexOf("--out");
  if (index === -1 || !argv[index + 1]) {
    throw new Error(
      "usage: node desktop/scripts/prepare.mjs --out <empty directory> [--no-rebrand | --update-rebrand-lock]",
    );
  }
  return {
    out: path.resolve(argv[index + 1]),
    rebrand: !argv.includes("--no-rebrand"),
    updateLock: argv.includes("--update-rebrand-lock"),
  };
}

function git(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=1ma", "-c", "user.email=hello@1ma.ai", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}\n${result.stdout}${result.stderr}`);
  }
  return result.stdout.trim();
}

const { out, rebrand, updateLock } = parseArgs(process.argv.slice(2));
if (existsSync(out) && readdirSync(out).length > 0) {
  throw new Error(`${out} is not empty; prepare writes a fresh tree`);
}
mkdirSync(out, { recursive: true });

git(out, ["init", "--quiet"]);
git(out, ["remote", "add", "origin", upstream.repository]);
git(out, [
  "fetch",
  "--quiet",
  "--depth",
  "1",
  "origin",
  `refs/tags/${upstream.tag}:refs/tags/${upstream.tag}`,
]);
const tagged = git(out, ["rev-list", "-n", "1", upstream.tag]);
if (tagged !== upstream.commit) {
  throw new Error(
    `${upstream.tag} points at ${tagged}, upstream.json pins ${upstream.commit}; refusing a moved tag`,
  );
}
git(out, ["checkout", "--quiet", "--detach", upstream.tag]);
console.log(`bb ${upstream.tag} (${upstream.commit.slice(0, 7)}) checked out in ${out}`);

const patches = readdirSync(path.join(desktop, "patches"))
  .filter((name) => name.endsWith(".patch"))
  .toSorted();
for (const name of patches) {
  git(out, ["am", "--quiet", "--3way", path.join(desktop, "patches", name)]);
  console.log(`applied ${name}`);
}
// The patch series ends here; the asset swap and the rebrand come on top and are
// never exported as patches.
git(out, ["branch", "1ma-patches"]);

for (const [from, to] of ASSETS) {
  const source = path.join(repo, from);
  const target = path.join(out, to);
  if (!existsSync(source)) throw new Error(`missing 1ma asset ${from}`);
  if (!existsSync(target)) throw new Error(`bb no longer has ${to}; update the asset map`);
  copyFileSync(source, target);
}
console.log(`replaced ${ASSETS.length} bb assets with 1ma assets`);

let rebranded = null;
if (rebrand) {
  const { REBRAND_DIR, diffInventory, formatInventory, loadRules, rebrandTree } =
    await import("./rebrand.mjs");
  const rules = loadRules();
  const result = rebrandTree(out, rules, { write: true });
  for (const { run, writes } of rules.derived) {
    if (!existsSync(path.join(out, run))) {
      throw new Error(`bb no longer has ${run}; update "derived" in desktop/rebrand/rules.json`);
    }
    const generated = spawnSync(process.execPath, [run], { cwd: out, encoding: "utf8" });
    if (generated.status !== 0) throw new Error(`${run} failed:\n${generated.stderr}`);
    console.log(`regenerated ${writes} from the renamed sources`);
  }
  const staged = [...result.changed, ...rules.derived.map(({ writes }) => writes)];
  const inventory = formatInventory(result.inventory);
  const lockPath = path.join(REBRAND_DIR, "inventory.json");
  if (updateLock) {
    writeFileSync(lockPath, inventory);
    console.log(`wrote ${path.relative(repo, lockPath)}; review its diff before committing`);
  } else {
    const { added, removed } = diffInventory(readFileSync(lockPath, "utf8"), inventory);
    if (added.length > 0 || removed.length > 0) {
      const lines = [...removed.map((line) => `- ${line}`), ...added.map((line) => `+ ${line}`)];
      throw new Error(
        `bb strings no longer match desktop/rebrand/inventory.json (${added.length} new or changed, ${removed.length} gone):\n${lines.slice(0, 60).join("\n")}\nReview them, adjust desktop/rebrand/rules.json if needed, and rerun prepare with --update-rebrand-lock.`,
      );
    }
  }
  if (result.changed.length > 0) {
    git(out, ["add", "--", ...staged]);
    git(out, [
      "commit",
      "--quiet",
      "--no-verify",
      "-m",
      "1ma: rename the product to 1ma in visible strings",
    ]);
  }
  rebranded = {
    files: result.changed.length,
    counts: result.counts,
    inventorySha256: createHash("sha256").update(inventory).digest("hex"),
  };
  console.log(
    `rebranded ${result.changed.length} files: ${result.counts.product} mentions of bb became 1ma; kept ${result.counts.command} commands, ${result.counts.code} code spans, ${result.counts.cloud} bb cloud mentions, ${result.counts.identifier} identifiers`,
  );
}

const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" });
const oneMaCommit = head.status === 0 ? head.stdout.trim() : "";
if (!/^[0-9a-f]{40}$/.test(oneMaCommit)) {
  throw new Error(`cannot read the 1ma commit to record in the provenance: ${head.stderr}`);
}
const provenance = {
  upstream,
  patches,
  rebrand: rebranded,
  oneMaCommit,
};
writeFileSync(path.join(out, "1ma-provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
console.log("wrote 1ma-provenance.json");
