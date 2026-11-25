// bb's scripts/check-source-nul.mjs, applied to the 1ma plugins that 1ma Desktop
// embeds: bb's check reads only bb's own tracked files.
//
//   node desktop/scripts/check-plugin-nul.mjs [1ma checkout]
//
// A tracked file with a literal NUL byte is named with the line of its first
// NUL, and the check fails. Binary assets are left out by extension, as in bb.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BINARY_EXTENSIONS = new Set([".png", ".jpg", ".webp", ".icns", ".mp4"]);

function trackedFiles(repo, dir) {
  const result = spawnSync("git", ["ls-files", "-z", "--", dir], {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`git ls-files failed in ${repo}\n${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

export function literalNuls(repo) {
  const embedded = JSON.parse(
    readFileSync(path.join(repo, "desktop", "embedded-plugins.json"), "utf8"),
  );
  const found = [];
  let checked = 0;
  for (const name of embedded)
    for (const file of trackedFiles(repo, path.posix.join("plugins", name))) {
      if (BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())) continue;
      const bytes = readFileSync(path.join(repo, file));
      checked += 1;
      const at = bytes.indexOf(0);
      if (at !== -1)
        found.push({ file, line: bytes.subarray(0, at).toString().split("\n").length });
    }
  return { checked, found };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const repo = path.resolve(
    process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../.."),
  );
  const { checked, found } = literalNuls(repo);
  for (const { file, line } of found)
    console.error(
      `${JSON.stringify(file)}:${line}: Literal NUL byte makes this file binary. Use an escape such as \\u0000 in strings; binary assets need an extension listed in desktop/scripts/check-plugin-nul.mjs.`,
    );
  console.log(
    `Checked ${checked} tracked files of the embedded 1ma plugins for literal NUL bytes.`,
  );
  if (found.length > 0) process.exitCode = 1;
}
