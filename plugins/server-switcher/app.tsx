import { useEffect, useState } from "react";
import { definePluginApp, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

type Choice = { id: string; name: string; active: boolean };
type Desktop = {
  getServerChoices(): Promise<Choice[]>;
  onServerChoicesChange(listener: (choices: Choice[]) => void): () => void;
  selectServer(id: string): void;
};

function ServerSwitcher() {
  const desktop = (window as unknown as { bbDesktop?: Desktop }).bbDesktop;
  const [choices, setChoices] = useState<Choice[]>([]);
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);
  const [position, setPosition] = useState({ left: 190, top: 10 });
  useEffect(() => {
    const place = () => {
      const toggle = document.querySelector<HTMLElement>(
        'button[aria-label^="Toggle sidebar"], button[title^="Toggle sidebar"]',
      );
      if (!toggle) return;
      const box = toggle.getBoundingClientRect();
      if (!box.width) return;
      const next = { left: box.right + 10, top: box.top };
      setPosition((old) => (old.left === next.left && old.top === next.top ? old : next));
    };
    place();
    const observer = new MutationObserver(place);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, []);
  useEffect(() => {
    if (!desktop?.getServerChoices || !desktop.selectServer) return;
    let live = true;
    const refresh = () => {
      void desktop
        .getServerChoices()
        .then((items) => {
          if (live) {
            setChoices(items);
            setSwitching(false);
            setFailed(false);
          }
        })
        .catch(() => {
          if (live) setFailed(true);
        });
    };
    refresh();
    const unsubscribe = desktop.onServerChoicesChange(refresh);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
    };
  }, [desktop]);
  useEffect(() => {
    if (!switching) return;
    const timer = window.setTimeout(() => {
      setSwitching(false);
      setFailed(true);
    }, 15000);
    return () => window.clearTimeout(timer);
  }, [switching]);
  if (!desktop || choices.length < 2) return null;
  const current = choices.find((item) => item.active);
  if (!current) return null;
  return (
    <div
      style={
        {
          position: "fixed",
          ...position,
          zIndex: 40,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
      className="flex items-center gap-1 text-xs text-muted-foreground"
    >
      <div className="relative flex h-7 items-center rounded-md hover:bg-accent hover:text-accent-foreground focus-within:bg-accent">
        <select
          aria-label="Mac / Linux server"
          aria-busy={switching}
          title={
            switching
              ? "Connecting…"
              : failed
                ? "Switch failed. Retry or use Desktop Settings."
                : "Switch BB server; running tasks continue"
          }
          className="h-full cursor-pointer rounded-md bg-transparent py-0 pl-2 pr-6 text-xs text-inherit disabled:opacity-50"
          style={{
            appearance: "none",
            WebkitAppearance: "none",
            border: "none",
            boxShadow: "none",
            outline: "none",
            fontFamily: "inherit",
            fontWeight: 500,
          }}
          value={current.id}
          disabled={switching}
          onChange={(event) => {
            const target = choices.find((item) => item.id === event.target.value);
            if (!target || target.active) return;
            setSwitching(true);
            setFailed(false);
            desktop.selectServer(target.id);
          }}
        >
          {choices.map((item) => (
            <option key={item.id} value={item.id}>
              {/linux/i.test(item.name) ? "Linux" : /mac/i.test(item.name) ? "Mac" : item.name}
            </option>
          ))}
        </select>
        <Icon
          name={switching ? "LoaderCircle" : failed ? "CircleAlert" : "ChevronDown"}
          aria-hidden
          className={`pointer-events-none absolute right-1.5 size-3 opacity-60${switching ? " animate-spin" : ""}`}
        />
        <span role="status" className="sr-only">
          {switching
            ? "Connecting…"
            : failed
              ? "Connection failed. Retry or use Desktop Settings."
              : ""}
        </span>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "server-switcher", component: ServerSwitcher });
});
