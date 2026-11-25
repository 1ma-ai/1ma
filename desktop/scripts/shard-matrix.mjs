import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The test matrix out of what bb's CI planner printed. A plan without shards is
// refused here: GitHub would skip the tests job of an empty matrix, and nothing
// of bb would have been tested.
export function shardMatrix(selection) {
  const include = selection?.tests?.include;
  if (!Array.isArray(include) || include.length === 0)
    throw new Error("bb's planner named no test shards");
  for (const entry of include)
    if (typeof entry?.shard !== "string" || entry.shard === "")
      throw new Error(`bb's planner named a shard without a name: ${JSON.stringify(entry)}`);
  return { ...selection.tests, include };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const matrix = shardMatrix(JSON.parse(readFileSync(process.argv[2], "utf8")));
  console.log(matrix.include.map((entry) => entry.shard).join("\n"));
  appendFileSync(process.env.GITHUB_OUTPUT, `tests=${JSON.stringify(matrix)}\n`);
}
