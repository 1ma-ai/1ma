import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BRAND_ASSETS, MANIFEST_FILE, MANIFEST_TYPE, assetBase, buildManifest } from "./brand";

const CACHE_CONTROL = "public, max-age=86400";

function assetsDirectory(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(here) === "dist"
    ? path.join(here, "..", "assets")
    : path.join(here, "assets");
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const directory = assetsDirectory();
  for (const asset of BRAND_ASSETS) {
    bb.http.route(
      "GET",
      `/${asset.file}`,
      async () => {
        const bytes = await readFile(path.join(directory, asset.file));
        return new Response(new Uint8Array(bytes), {
          headers: { "content-type": asset.type, "cache-control": CACHE_CONTROL },
        });
      },
      { auth: "none" },
    );
  }
  bb.http.route(
    "GET",
    `/${MANIFEST_FILE}`,
    () =>
      new Response(JSON.stringify(buildManifest(assetBase(bb.pluginId))), {
        headers: { "content-type": MANIFEST_TYPE, "cache-control": CACHE_CONTROL },
      }),
    { auth: "none" },
  );
}
