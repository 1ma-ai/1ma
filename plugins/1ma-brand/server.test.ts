import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "./server";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("brand asset routes", () => {
  const host = createFakePluginHost({ pluginId: "1ma-brand" });

  afterEach(async () => {
    await host.harness.lifecycle.dispose();
  });

  it("serves the 1ma manifest, icons and wordmark without the bb brand", async () => {
    await plugin(host.bb);

    const manifest = await host.harness.behavior.fetchHttp("GET", "/manifest.webmanifest");
    expect(manifest.status).toBe(200);
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    const body = (await manifest.json()) as { name: string; icons: Array<{ src: string }> };
    expect(body.name).toBe("1ma");
    expect(body.icons[0]?.src).toBe("/api/v1/plugins/1ma-brand/http/icon-192.png");

    const icon = await host.harness.behavior.fetchHttp("GET", "/icon-32.png");
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await icon.arrayBuffer());
    expect(Array.from(bytes.slice(0, 8))).toEqual(PNG_MAGIC);

    const wordmark = await host.harness.behavior.fetchHttp("GET", "/wordmark.svg");
    expect(wordmark.headers.get("content-type")).toBe("image/svg+xml");
    const svg = await wordmark.text();
    expect(svg).toContain("<svg");
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain("bb");
  });
});
