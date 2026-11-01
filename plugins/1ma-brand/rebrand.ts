import {
  APPLE_TOUCH_ICON_LINK_ID,
  AUTHOR_AVATAR_SELECTOR,
  BB_BRAND,
  BRAND,
  FAVICON_COLOR_VALUES,
  FAVICON_LINK_IDS,
  FAVICON_SIZES,
  MANIFEST_FILE,
  MANIFEST_LINK_ID,
  UNREAD_BADGE_FILL,
  assetBase,
  faviconFile,
  isBbLogoSource,
  logoReplacement,
  looksLikeBadge,
  readFaviconColor,
  rebrandTitle,
  unreadBadgeDot,
} from "./brand";

export interface MountBrandOptions {
  pluginId: string;
  signal: AbortSignal;
  document: Document;
}

interface FaviconRender {
  base: string;
  color: string | null;
  badge: boolean;
}

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function supportsCanvas(doc: Document): boolean {
  try {
    return doc.createElement("canvas").getContext("2d") !== null;
  } catch {
    return false;
  }
}

function loadImage(doc: Document, src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = doc.createElement("img");
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error(`brand: failed to load ${src}`)), {
      once: true,
    });
    image.src = src;
  });
}

async function detectBadge(doc: Document, href: string): Promise<boolean> {
  if (!href.startsWith("data:") || !supportsCanvas(doc)) return false;
  const image = await loadImage(doc, href).catch(() => null);
  if (!image) return false;
  const canvas = doc.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0) return false;
  context.drawImage(image, 0, 0);
  const dot = unreadBadgeDot(canvas.width, canvas.height);
  return looksLikeBadge(
    context.getImageData(Math.round(dot.centerX), Math.round(dot.centerY), 1, 1).data,
  );
}

function tint(context: CanvasRenderingContext2D, width: number, height: number, hex: string): void {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  const pixels = context.getImageData(0, 0, width, height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3] ?? 0;
    if (alpha === 0) continue;
    const luma =
      0.2126 * (data[index] ?? 0) +
      0.7152 * (data[index + 1] ?? 0) +
      0.0722 * (data[index + 2] ?? 0);
    if (luma >= 128) continue;
    data[index] = red;
    data[index + 1] = green;
    data[index + 2] = blue;
  }
  context.putImageData(pixels, 0, 0);
}

async function renderFavicon(doc: Document, render: FaviconRender): Promise<string> {
  if ((render.color === null && !render.badge) || !supportsCanvas(doc)) return render.base;
  const image = await loadImage(doc, render.base).catch(() => null);
  if (!image) return render.base;
  const canvas = doc.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context || canvas.width === 0) return render.base;
  context.drawImage(image, 0, 0);
  if (render.color !== null) {
    const hex = FAVICON_COLOR_VALUES[render.color];
    if (hex !== undefined) tint(context, canvas.width, canvas.height, hex);
  }
  if (render.badge) {
    const dot = unreadBadgeDot(canvas.width, canvas.height);
    context.beginPath();
    context.arc(dot.centerX, dot.centerY, dot.radius, 0, Math.PI * 2);
    context.fillStyle = UNREAD_BADGE_FILL;
    context.fill();
  }
  return canvas.toDataURL("image/png");
}

export function mountBrand({ pluginId, signal, document: doc }: MountBrandOptions): () => void {
  const win = doc.defaultView;
  const base = assetBase(pluginId);
  const assetUrl = (file: string): string => `${base}/${file}`;
  const observers: MutationObserver[] = [];
  const restores: Array<() => void> = [];
  let disposed = false;

  const applyTitle = (): void => {
    const next = rebrandTitle(doc.title);
    if (next !== doc.title) doc.title = next;
  };
  applyTitle();
  // The title lives in <head>; watching the whole page would run this on every
  // streamed token in the chat.
  const titleObserver = new MutationObserver(applyTitle);
  titleObserver.observe(doc.head ?? doc.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
  observers.push(titleObserver);

  const swappedImages = new Map<
    HTMLImageElement,
    { src: string; alt: string | null; width: string }
  >();
  const swapLogo = (image: HTMLImageElement): void => {
    const src = image.getAttribute("src") ?? "";
    if (!isBbLogoSource(src) || image.closest(AUTHOR_AVATAR_SELECTOR) !== null) return;
    const original = swappedImages.get(image) ?? {
      src,
      alt: image.getAttribute("alt"),
      width: image.style.width,
    };
    swappedImages.set(image, original);
    const replacement = logoReplacement(original.alt);
    image.setAttribute("src", assetUrl(replacement.file));
    if (original.alt === BB_BRAND) image.setAttribute("alt", BRAND);
    if (replacement.widthAuto) image.style.width = "auto";
  };
  const scanImages = (root: ParentNode): void => {
    for (const image of root.querySelectorAll("img")) swapLogo(image);
  };
  scanImages(doc);
  const imageObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (
        record.type === "attributes" &&
        isElement(record.target) &&
        record.target.tagName === "IMG"
      ) {
        swapLogo(record.target as HTMLImageElement);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!isElement(node)) continue;
        if (node.tagName === "IMG") swapLogo(node as HTMLImageElement);
        else scanImages(node);
      }
    }
  });
  imageObserver.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["src"],
  });
  observers.push(imageObserver);
  restores.push(() => {
    for (const [image, original] of swappedImages) {
      image.setAttribute("src", original.src);
      if (original.alt !== null) image.setAttribute("alt", original.alt);
      image.style.width = original.width;
    }
  });

  const linkById = (id: string): HTMLLinkElement | null => {
    const element = doc.getElementById(id);
    return element !== null && element.tagName === "LINK" ? (element as HTMLLinkElement) : null;
  };
  const pinnedHrefs = new Map<string, string>();
  const originalHrefs = new Map<string, string | null>();
  const setHref = (link: HTMLLinkElement, href: string): void => {
    if (!originalHrefs.has(link.id)) originalHrefs.set(link.id, link.getAttribute("href"));
    pinnedHrefs.set(link.id, href);
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  };
  const isOwnHref = (link: HTMLLinkElement): boolean =>
    pinnedHrefs.get(link.id) === (link.getAttribute("href") ?? "");

  const applyInstallLinks = (): void => {
    const manifest = linkById(MANIFEST_LINK_ID);
    if (manifest && !isOwnHref(manifest)) setHref(manifest, assetUrl(MANIFEST_FILE));
    const apple = linkById(APPLE_TOUCH_ICON_LINK_ID);
    if (apple && !isOwnHref(apple)) setHref(apple, assetUrl("apple-touch-icon.png"));
  };

  let renderToken = 0;
  const applyFavicon = async (): Promise<void> => {
    const token = ++renderToken;
    if (win?.matchMedia?.("(display-mode: standalone)").matches) return;
    const color = readFaviconColor((key) => win?.localStorage.getItem(key) ?? null);
    const rendered = await Promise.all(
      FAVICON_SIZES.map(async (size) => {
        const link = linkById(FAVICON_LINK_IDS[size]);
        if (!link) return null;
        const badge = await detectBadge(doc, link.getAttribute("href") ?? "");
        const href = await renderFavicon(doc, {
          base: assetUrl(faviconFile(size)),
          color,
          badge,
        });
        return { link, href };
      }),
    );
    if (token !== renderToken || disposed) return;
    for (const entry of rendered) {
      if (entry) setHref(entry.link, entry.href);
    }
  };

  applyInstallLinks();
  void applyFavicon();
  const linkObserver = new MutationObserver((records) => {
    let faviconChanged = false;
    for (const record of records) {
      if (!isElement(record.target) || record.target.tagName !== "LINK") continue;
      const link = record.target as HTMLLinkElement;
      if (isOwnHref(link)) continue;
      if (link.id === MANIFEST_LINK_ID || link.id === APPLE_TOUCH_ICON_LINK_ID) applyInstallLinks();
      else if (link.id === FAVICON_LINK_IDS[32] || link.id === FAVICON_LINK_IDS[16])
        faviconChanged = true;
    }
    if (faviconChanged) void applyFavicon();
  });
  linkObserver.observe(doc.head, { subtree: true, attributes: true, attributeFilter: ["href"] });
  observers.push(linkObserver);
  restores.push(() => {
    for (const [id, href] of originalHrefs) {
      const link = linkById(id);
      if (!link) continue;
      if (href === null) link.removeAttribute("href");
      else link.setAttribute("href", href);
    }
  });

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    renderToken += 1;
    for (const observer of observers) observer.disconnect();
    for (const restore of restores) restore();
  };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
