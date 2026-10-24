// The window's own title bar. The toolbar is where the window is grabbed
// (Tauri's drag region: a press on its empty parts moves the window, a
// double click maximizes it; buttons and tabs keep their clicks), and its
// right end holds Minimize, Maximize/Restore and Close. On Windows 11 native
// zones over those buttons (src-tauri/src/caption.rs) bring the Snap layouts
// to Maximize, and keep the buttons working under a modal dialog: they need
// the buttons' place, and the strip's, which this module keeps Rust told of.

import { getCurrentWindow } from "@tauri-apps/api/window";
import * as ipc from "../ipc";
import { t } from "../i18n";
import * as strip from "./strip";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

export function init(): void {
  const toolbar = $("#toolbar");
  const caption = $("#caption");
  const zoom = $<HTMLDialogElement>("#zoom-dialog");
  const buttons = {
    min: $<HTMLButtonElement>("#cap-min"),
    max: $<HTMLButtonElement>("#cap-max"),
    close: $<HTMLButtonElement>("#cap-close"),
  };
  toolbar.setAttribute("data-tauri-drag-region", "deep");

  caption.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".cap-btn");
    const win = getCurrentWindow();
    if (btn === buttons.min) void win.minimize().catch(() => {});
    else if (btn === buttons.max) void win.toggleMaximize().catch(() => {});
    // the same way out as Alt+F4: the question about unsaved edits still comes
    else if (btn === buttons.close) void win.close().catch(() => {});
  });

  // A right-click on the empty title bar: the window's own menu, as Windows
  // shows it on a title bar of its own (the tab strip has its menu: strip.ts)
  toolbar.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement;
    if (target !== toolbar && !target.matches(".spacer, .tabbar-fill, .toolbar-sep")) return;
    e.preventDefault();
    const dpr = devicePixelRatio;
    void getCurrentWindow()
      .innerPosition()
      .then((o) => ipc.showSystemMenu(Math.round(o.x + e.clientX * dpr), Math.round(o.y + e.clientY * dpr)))
      .catch(() => {});
  });

  // Maximize turns into Restore on a maximized window, as Windows' own does
  const syncMax = (): void => {
    getCurrentWindow()
      .isMaximized()
      .then((maxed) => {
        caption.classList.toggle("maxed", !!maxed);
        buttons.max.title = t(maxed ? "caption.restore" : "caption.maximize");
        buttons.max.setAttribute("aria-label", buttons.max.title);
      })
      .catch(() => {});
  };
  syncMax();

  // Windows greys the caption of the window that is not in front
  window.addEventListener("blur", () => document.documentElement.classList.add("win-blur"));
  window.addEventListener("focus", () => document.documentElement.classList.remove("win-blur"));

  // the native zones own the pointer over the buttons: they say when it is there
  void ipc
    .onCaptionHover((which) => {
      for (const [kind, btn] of Object.entries(buttons)) btn.classList.toggle("hover", kind === which);
    })
    .catch(() => {});

  // Where the buttons and the strip are, once a frame at most. The preview
  // covers the whole window: the zones step aside while it is open (an
  // invisible Close over a picture would be a trap).
  let frame = 0;
  const report = (): void => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const layout = (Object.entries(buttons) as ["min" | "max" | "close", HTMLButtonElement][]).map(([kind, btn]) => {
        const r = btn.getBoundingClientRect();
        return { kind, x: r.left, y: r.top, w: r.width, h: r.height };
      });
      void ipc.setCaption({ buttons: layout, visible: !zoom.open }).catch(() => {});
      const s = strip.rect();
      void ipc.setStrip(s.left, s.top, s.width, s.height).catch(() => {});
    });
  };
  new ResizeObserver(report).observe(toolbar);
  new MutationObserver(report).observe(zoom, { attributes: true, attributeFilter: ["open"] });
  window.addEventListener("resize", () => {
    syncMax();
    report();
  });
  report();
}
