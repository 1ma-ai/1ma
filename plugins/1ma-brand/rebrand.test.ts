// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountBrand } from "./rebrand";

const BASE = "/api/v1/plugins/1ma-brand/http";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mountBrand", () => {
  let controller: AbortController;

  beforeEach(() => {
    controller = new AbortController();
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as unknown as HTMLCanvasElement["getContext"];
    document.head.innerHTML = [
      "<title>bb</title>",
      '<link rel="icon" sizes="32x32" href="/favicon-32x32.png" id="favicon-32">',
      '<link rel="icon" sizes="16x16" href="/favicon-16x16.png" id="favicon-16">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png" id="apple-touch-icon">',
      '<link rel="manifest" href="/manifest.webmanifest" id="app-manifest">',
    ].join("");
    document.body.innerHTML = [
      '<img src="/assets/bb-logo-Ab12Cd.svg" alt="bb" class="h-5 dark:invert">',
      '<img src="/assets/user-photo.png" alt="me">',
    ].join("");
  });

  afterEach(() => {
    controller.abort();
  });

  it("rebrands the title, favicon links, install links and the bb logo on mount", async () => {
    mountBrand({ pluginId: "1ma-brand", signal: controller.signal, document });
    await flush();
    expect(document.title).toBe("1ma");
    expect(document.getElementById("favicon-32")?.getAttribute("href")).toBe(`${BASE}/icon-32.png`);
    expect(document.getElementById("favicon-16")?.getAttribute("href")).toBe(`${BASE}/icon-16.png`);
    expect(document.getElementById("app-manifest")?.getAttribute("href")).toBe(
      `${BASE}/manifest.webmanifest`,
    );
    expect(document.getElementById("apple-touch-icon")?.getAttribute("href")).toBe(
      `${BASE}/apple-touch-icon.png`,
    );
    const [logo, photo] = document.querySelectorAll("img");
    expect(logo?.getAttribute("src")).toBe(`${BASE}/mark.svg`);
    expect(logo?.getAttribute("alt")).toBe("1ma");
    expect(logo?.className).toBe("h-5 dark:invert");
    expect(photo?.getAttribute("src")).toBe("/assets/user-photo.png");
  });

  it("wins again every time bb rewrites the title, the favicon or mounts a new logo", async () => {
    mountBrand({ pluginId: "1ma-brand", signal: controller.signal, document });
    await flush();
    document.title = "Settings";
    await flush();
    expect(document.title).toBe("Settings");
    document.title = "bb";
    await flush();
    expect(document.title).toBe("1ma");

    document.getElementById("favicon-32")?.setAttribute("href", "/favicon-32x32-dark.png");
    await flush();
    await flush();
    expect(document.getElementById("favicon-32")?.getAttribute("href")).toBe(`${BASE}/icon-32.png`);

    const late = document.createElement("img");
    late.setAttribute("src", "/assets/bb-logo-Zz99.svg");
    document.body.append(late);
    await flush();
    expect(late.getAttribute("src")).toBe(`${BASE}/mark.svg`);
  });

  it("leaves bb's logo in an official plugin's author avatar, where it credits the bb team", async () => {
    const avatar =
      '<span role="img" aria-label="bb\'s GitHub avatar"><span><img src="/assets/bb-logo-Ab12Cd.svg" class="size-4/5"></span></span>';
    document.body.insertAdjacentHTML("beforeend", avatar);
    mountBrand({ pluginId: "1ma-brand", signal: controller.signal, document });
    await flush();
    const credited = document.querySelector('[role="img"] img');
    expect(credited?.getAttribute("src")).toBe("/assets/bb-logo-Ab12Cd.svg");

    document.body.insertAdjacentHTML("beforeend", avatar);
    await flush();
    const added = document.querySelectorAll('[role="img"] img');
    expect(added[1]?.getAttribute("src")).toBe("/assets/bb-logo-Ab12Cd.svg");
    expect(document.querySelector("img")?.getAttribute("src")).toBe(`${BASE}/mark.svg`);
  });

  it("stops and restores bb's own assets once disposed", async () => {
    const dispose = mountBrand({ pluginId: "1ma-brand", signal: controller.signal, document });
    await flush();
    dispose();
    expect(document.getElementById("favicon-32")?.getAttribute("href")).toBe("/favicon-32x32.png");
    expect(document.getElementById("app-manifest")?.getAttribute("href")).toBe(
      "/manifest.webmanifest",
    );
    expect(document.querySelector("img")?.getAttribute("src")).toBe("/assets/bb-logo-Ab12Cd.svg");
    document.title = "bb";
    await flush();
    expect(document.title).toBe("bb");
  });
});
