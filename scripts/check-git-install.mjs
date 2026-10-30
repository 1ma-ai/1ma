import { cpSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collection = JSON.parse(readFileSync(path.join(root, ".bb/plugins.json"), "utf8"));
const bbBin = path.join(root, "node_modules/.bin/bb");
const only = process.argv.slice(2);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "pipe", encoding: "utf8", shell: false });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

let failed = 0;
for (const entry of collection.plugins) {
  if (only.length > 0 && !only.includes(entry.name)) continue;
  const source = path.join(root, entry.source);
  const copy = mkdtempSync(path.join(tmpdir(), `1ma-git-install-${entry.name}-`));
  try {
    cpSync(source, copy, {
      recursive: true,
      filter: (file) => !/(^|\/)(node_modules|dist)(\/|$)/.test(file),
    });
    const install = run(
      "npm",
      ["install", "--omit=dev", "--omit=optional", "--ignore-scripts", "--no-audit", "--no-fund"],
      copy,
    );
    if (!install.ok) {
      failed += 1;
      console.error(
        `✗ ${entry.name}: npm install (as bb does for git installs) failed\n${install.output}`,
      );
      continue;
    }
    const build = run(bbBin, ["plugin", "build"], copy);
    if (!build.ok || !existsSync(path.join(copy, "dist/server.js"))) {
      failed += 1;
      console.error(
        `✗ ${entry.name}: bb plugin build failed after a production-only install\n${build.output}`,
      );
      continue;
    }
    console.log(`✓ ${entry.name}: installs and builds the way bb installs it from git`);
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
}
if (failed > 0) {
  console.error(`${failed} plugin(s) cannot be installed from git`);
  process.exit(1);
}
