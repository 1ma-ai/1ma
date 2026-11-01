// bb derives a plugin's id from its package name: the last path segment
// without the bb-plugin- prefix, lowercased, other characters folded into dashes.
export function pluginId(packageName) {
  const last = packageName.split("/").pop() ?? packageName;
  const stripped = last.startsWith("bb-plugin-") ? last.slice("bb-plugin-".length) : last;
  return stripped
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
