// Full-window preview for diagrams, images and tables, in the spirit of GitHub's.
//
// A diagram is always re-rendered, never cloned: a cloned Mermaid SVG
// duplicates every id in the document, so its url(#marker) references would
// resolve to the article's copy — and silently break the moment edit mode
// rebuilds that copy. Re-rendering also answers the theme switch for free.
// A table is cloned, without its ids: HTML refers to nothing by id the way
// SVG markers do, and the theme reaches the copy through the CSS variables.

import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as ipc from "./ipc";
import { renderMermaidSvg } from "./mermaid";
import { rasterizeSvg } from "./share";
import * as theme from "./theme";
import { t } from "./i18n";
import { handleMenuKey } from "./menuKeys";
import { tableToTsv } from "./tables";

export interface LightboxOpts {
  article: HTMLElement;
  pane: HTMLElement;
  hint: HTMLButtonElement;
  dialog: HTMLDialogElement;
  /** sticky bars that may sit where the hover hint wants to be */
  bars: HTMLElement[];
}

const SCALE_MAX = 8;
const SCALE_FLOOR = 0.2;
const STEP = 1.25;
const MARGIN = 40; // breathing room around the stage
const BAR_SPACE = 64; // the toolbar at the bottom of the viewport
const HINT_SIZE = 28;
const HINT_GAP = 8;
// a table is laid out as wide as the window allows, but never narrower than this
const TABLE_MIN_WIDTH = 480;

let o: LightboxOpts;
let viewport: HTMLElement;
let stage: HTMLElement;
let levelOut: HTMLElement;
let caption: HTMLElement;
let btnIn: HTMLButtonElement;
let btnOut: HTMLButtonElement;
let btnCopy: HTMLButtonElement;
let copyMenu: HTMLElement;
let modeButtons: Record<Mode, HTMLButtonElement>;

let kind: "mermaid" | "image" | "table" = "image";
let source = "";
// the document's table on screen, copied into the stage by build()
let table: HTMLTableElement | null = null;
let natW = 0;
let natH = 0;
let scale = 1;
let fit = 1;
let tx = 0;
let ty = 0;
// The view the last Fit / Width / 100% asked for, until a zoom leaves it
// (panning keeps it). Shown as the pressed button; a resize keeps fitting.
type Mode = "fit" | "width" | "actual";
let mode: Mode | null = "fit";
let shownMode: Mode | null | undefined;

let raf = 0;
let drag: { x: number; y: number; tx: number; ty: number } | null = null;
let dragged = false;
let hintTarget: HTMLElement | null = null;
let copyTimer: number | undefined;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function isOpen(): boolean {
  return o?.dialog.open === true;
}

export function init(opts: LightboxOpts): void {
  o = opts;
  const q = <T extends HTMLElement>(sel: string): T => opts.dialog.querySelector(sel) as T;
  viewport = q("#zoom-viewport");
  stage = q("#zoom-stage");
  levelOut = q("#zoom-level");
  caption = q("#zoom-caption");
  btnIn = q<HTMLButtonElement>("#zoom-in");
  btnOut = q<HTMLButtonElement>("#zoom-out");
  btnCopy = q<HTMLButtonElement>("#zoom-copy");
  copyMenu = q("#zoom-copy-menu");
  const btnFit = q<HTMLButtonElement>("#zoom-fit");
  modeButtons = {
    fit: btnFit,
    width: textButton("zoom-width", t("zoom.width"), t("zoom.widthLabel"), "W"),
    actual: textButton("zoom-actual", t("zoom.actual"), t("zoom.actualLabel"), "1"),
  };
  btnFit.after(modeButtons.width, modeButtons.actual);
  copyMenu.prepend(copyTableItem());

  btnIn.addEventListener("click", () => zoomBy(STEP));
  btnOut.addEventListener("click", () => zoomBy(1 / STEP));
  for (const m of ["fit", "width", "actual"] as const) modeButtons[m].addEventListener("click", () => setMode(m));
  q("#zoom-close").addEventListener("click", close);
  btnCopy.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCopyMenu();
  });
  copyMenu.addEventListener("click", (e) => {
    const action = (e.target as HTMLElement).closest<HTMLElement>("[data-action]")?.dataset.action;
    if (!action) return;
    e.stopPropagation();
    copyMenu.hidden = true;
    void runCopyAction(action);
  });
  // the keys every menu of the app has (menuKeys.ts); Escape and Tab put it
  // away and hand the focus back to its button, and none of its keys reaches
  // the pan and zoom below
  copyMenu.addEventListener("keydown", (e) => {
    handleMenuKey(e, copyMenu, () => {
      copyMenu.hidden = true;
      btnCopy.focus();
    });
  });
  opts.dialog.addEventListener("click", () => {
    if (!copyMenu.hidden) copyMenu.hidden = true;
  });
  // the focus elsewhere while the menu is open: Escape still closes the
  // menu first, not the whole preview
  opts.dialog.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !copyMenu.hidden) {
      e.preventDefault();
      e.stopPropagation();
      copyMenu.hidden = true;
    }
  });

  wireViewport();
  wireHint();

  opts.dialog.addEventListener("close", () => {
    // the event is queued, not synchronous: reopening on another diagram before
    // it lands would otherwise empty the stage that was just rebuilt
    if (opts.dialog.open) return;
    stage.replaceChildren();
    source = "";
    table = null;
    copyMenu.hidden = true;
  });
  // the backdrop and the empty space around the stage dismiss the preview; a
  // pan that happens to end on empty space must not, hence the dragged guard
  opts.dialog.addEventListener("click", (e) => {
    if (dragged) return;
    if (e.target === opts.dialog || e.target === viewport) close();
  });

  opts.article.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-zoomable]");
    if (!el) return;
    e.preventDefault();
    void openFor(el);
  });
  // a table's expand button (renderer.ts leaves it to this delegation)
  opts.article.addEventListener("click", (e) => {
    const block = (e.target as HTMLElement | null)?.closest(".table-expand")?.closest<HTMLElement>(".table-block");
    if (!block) return;
    e.preventDefault();
    void openFor(block);
  });

  theme.onChange(() => {
    if (!isOpen() || kind !== "mermaid") return;
    const keep = { scale, tx, ty };
    void build().then((ok) => {
      if (!ok) return;
      scale = keep.scale;
      tx = keep.tx;
      ty = keep.ty;
      fit = computeFit();
      schedule();
    });
  });

  window.addEventListener("resize", () => {
    if (isOpen()) refit();
    if (hintTarget) positionHint(hintTarget);
  });
}

// Width and 100% sit beside Fit, made like it: the label names the button,
// the title says what it does and its key.
function textButton(id: string, title: string, label: string, key: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = id;
  b.type = "button";
  b.className = "zoom-text-btn";
  b.title = title;
  b.textContent = label;
  b.setAttribute("aria-keyshortcuts", key);
  return b;
}

// the one thing a table offers: its text for a spreadsheet
function copyTableItem(): HTMLButtonElement {
  const item = document.createElement("button");
  item.type = "button";
  item.className = "menu-item";
  item.setAttribute("role", "menuitem");
  item.dataset.action = "copy-table";
  item.dataset.kind = "table";
  const title = document.createElement("span");
  title.className = "menu-title";
  title.textContent = t("render.copyTable");
  item.append(title);
  return item;
}

/* ---- marking the article ---- */

// Idempotent: edit mode rebuilds the article every ~200 ms, so this runs often.
// It only adds attributes — no wrappers, no new nodes — which is what keeps the
// scroll-sync anchors and the positional diagram index in share.ts intact.
// Tables are not marked: a role of button would hide them from screen
// readers, so they open from their own expand button.
export function markAll(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>(
    ".mermaid-diagram[data-mmd-source]:not([data-zoomable])",
  )) {
    mark(el, t("zoom.diagramOpen"));
  }
  for (const img of root.querySelectorAll<HTMLImageElement>(
    "img:not(.img-missing):not([data-zoomable])",
  )) {
    const alt = (img.getAttribute("alt") ?? "").trim();
    mark(img, t("zoom.imageOpen", { alt: alt || t("zoom.image") }));
  }
}

export function unmark(el: HTMLElement): void {
  el.removeAttribute("data-zoomable");
  el.removeAttribute("tabindex");
  el.removeAttribute("role");
  el.removeAttribute("aria-label");
}

function mark(el: HTMLElement, label: string): void {
  el.dataset.zoomable = "";
  el.tabIndex = 0;
  el.setAttribute("role", "button");
  el.setAttribute("aria-label", label);
}

/* ---- opening ---- */

// A table's block, the table, or anything in them (the expand button): the
// document's table to show.
function tableIn(el: HTMLElement): HTMLTableElement | null {
  const block = el.closest<HTMLElement>(".table-block");
  if (block) return block.querySelector<HTMLTableElement>(":scope > .table-scroll > table");
  return el.closest("table");
}

/** Opens the preview on a diagram, an image, or a table (its block, or anything in it). */
export async function openFor(el: HTMLElement): Promise<void> {
  if (isOpen()) return;
  if (el instanceof HTMLImageElement) {
    if (!el.naturalWidth) {
      if (el.complete) return; // broken image: nothing to show
      try {
        await el.decode();
      } catch {
        return;
      }
      if (!el.naturalWidth) return;
    }
    kind = "image";
    source = el.currentSrc || el.src;
    natW = el.naturalWidth;
    natH = el.naturalHeight;
    caption.textContent = (el.getAttribute("alt") ?? "").trim() || t("zoom.image");
  } else if (el.dataset.mmdSource !== undefined) {
    const src = el.dataset.mmdSource;
    if (!src) return;
    kind = "mermaid";
    source = src;
    caption.textContent = t("zoom.diagram");
  } else {
    const found = tableIn(el);
    if (!found) return;
    kind = "table";
    table = found;
    source = "";
    caption.textContent = t("zoom.table");
  }
  positionHint(null);
  o.dialog.showModal();
  if (!(await build())) {
    close();
    return;
  }
  // a table is read from its top, across the window's width
  setMode(kind === "table" ? "width" : "fit");
  viewport.focus();
}

export function close(): void {
  if (isOpen()) o.dialog.close();
}

// Fills the stage and gives it the content's intrinsic box. Scaling is then
// done purely by transform: no reflow, and vectors stay crisp at any zoom.
async function build(): Promise<boolean> {
  if (kind === "mermaid") {
    let markup: string;
    try {
      markup = await renderMermaidSvg(source, theme.isDark());
    } catch {
      return false;
    }
    stage.innerHTML = markup;
    const svg = stage.querySelector("svg");
    if (!svg) return false;
    svg.setAttribute("aria-hidden", "true");
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    // mermaid keeps max-width — and sometimes background-color — in the style
    // attribute, so override the properties instead of dropping the attribute
    svg.style.setProperty("max-width", "none");
    svg.style.setProperty("width", "100%");
    svg.style.setProperty("height", "100%");
    const box = svg.viewBox.baseVal;
    natW = Math.round(box?.width || svg.getBoundingClientRect().width || 800);
    natH = Math.round(box?.height || svg.getBoundingClientRect().height || 600);
  } else if (kind === "table") {
    if (!table?.isConnected) return false;
    if (!buildTable(table)) return false;
  } else {
    const img = document.createElement("img");
    img.src = source;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    stage.replaceChildren(img);
  }
  stage.style.width = `${natW}px`;
  stage.style.height = `${natH}px`;
  // revealed by the first applyNow, which is what places and scales it
  stage.style.visibility = "hidden";
  stage.setAttribute("aria-label", caption.textContent ?? t("zoom.dialog"));
  return true;
}

// The copy sits on a sheet with the document's styles (markdown-body), laid
// out as wide as the window allows: a table that fits wraps no more than it
// must, and its own width becomes the stage's. Measured in layout pixels,
// which the stage's transform does not touch.
function buildTable(from: HTMLTableElement): boolean {
  const copy = from.cloneNode(true) as HTMLTableElement;
  // a second element with a document id would answer its links and lookups
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  const sheet = document.createElement("div");
  sheet.className = "markdown-body zoom-table";
  // a picture of the table: nothing in it takes the focus or a click
  sheet.inert = true;
  sheet.append(copy);
  stage.style.width = "";
  stage.style.height = "";
  stage.replaceChildren(sheet);
  sheet.style.width = `${Math.max(TABLE_MIN_WIDTH, Math.floor(area().w))}px`;
  const frame = sheet.offsetWidth - sheet.clientWidth;
  natW = copy.offsetWidth + frame;
  if (natW <= frame) return false;
  sheet.style.width = `${natW}px`;
  natH = sheet.offsetHeight;
  return natH > 0;
}

/* ---- zoom and pan ---- */

// The box the content is fitted into and centred in, in viewport coordinates:
// the viewport less a margin, and less the toolbar that floats over its bottom
// edge. Centring is arithmetic here rather than CSS alignment because the
// stage keeps the content's full natural size — often thousands of pixels —
// and an oversized grid item gets clamped to the start edge instead of being
// centred, which pushed part of a large diagram out of reach of any pan.
//
// clientWidth/Height rather than a client rect: the open animation scales the
// viewport, and a rect measured mid-animation would bake that scale into the fit.
function area(): { x: number; y: number; w: number; h: number } {
  const vw = viewport.clientWidth || window.innerWidth;
  const vh = viewport.clientHeight || window.innerHeight;
  const w = Math.max(80, vw - MARGIN * 2);
  const h = Math.max(80, vh - MARGIN * 2 - BAR_SPACE);
  return { x: (vw - w) / 2, y: Math.max(0, (vh - BAR_SPACE - h) / 2), w, h };
}

const centre = (a: { x: number; y: number; w: number; h: number }): { x: number; y: number } => ({
  x: a.x + a.w / 2,
  y: a.y + a.h / 2,
});

// How far fitting may enlarge. A diagram is a vector, so filling the window
// costs nothing and is the whole point of opening it; a raster image is
// capped at 1:1, where upscaling only adds blur; a table's text grows a
// little, no more.
const fitCap = (): number => (kind === "mermaid" ? 4 : kind === "table" ? 2 : 1);

function computeFit(): number {
  const a = area();
  return Math.min(a.w / natW, a.h / natH, fitCap());
}

const widthScale = (): number => Math.min(area().w / natW, fitCap());

// Fit (0): all of it, centred. Width (W): the window's width, from the top.
// 100% (1): the natural size, around what is in the middle of the view; a
// table from its top-left corner, where its rows and columns start.
function setMode(m: Mode): void {
  fit = computeFit();
  const a = area();
  if (m === "fit") {
    scale = fit;
    tx = 0;
    ty = 0;
  } else if (m === "width") {
    scale = widthScale();
    tx = 0;
    ty = (scale * natH - a.h) / 2; // applyNow clamps it: the top edge, or centred when it all fits
  } else if (kind === "table") {
    scale = 1;
    tx = (natW - a.w) / 2;
    ty = (natH - a.h) / 2;
  } else {
    const c = centre(a);
    const r = viewport.getBoundingClientRect();
    zoomAt(1 / scale, r.left + c.x, r.top + c.y);
  }
  mode = m;
  // synchronously: the stage carries its own centring in the transform, so
  // until that lands it would flash at full size in the top-left corner
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  applyNow();
}

// The window resized: Fit and Width fit again (Width keeps the place being
// read); a zoom of the user's own stays as it is.
function refit(): void {
  fit = computeFit();
  if (mode === "fit") {
    setMode("fit");
    return;
  }
  if (mode === "width") {
    const next = widthScale();
    tx = 0;
    ty *= next / scale;
    scale = next;
  }
  schedule();
}

const scaleMin = (): number => Math.min(fit, SCALE_FLOOR);

// keeps the content point under px,py (client coordinates) fixed while the
// scale changes. tx,ty are offsets from the centre of the area, so the anchor
// has to be measured from that same centre.
function zoomAt(k: number, px: number, py: number): void {
  const next = clamp(scale * k, scaleMin(), SCALE_MAX);
  const r = viewport.getBoundingClientRect();
  const c = centre(area());
  const factor = next / scale;
  tx = (1 - factor) * (px - r.left - c.x) + factor * tx;
  ty = (1 - factor) * (py - r.top - c.y) + factor * ty;
  scale = next;
  mode = null;
  schedule();
}

function zoomBy(k: number): void {
  const r = viewport.getBoundingClientRect();
  const c = centre(area());
  zoomAt(k, r.left + c.x, r.top + c.y);
}

function schedule(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    applyNow();
  });
}

function applyNow(): void {
  const a = area();
  const w = scale * natW;
  const h = scale * natH;
  // an axis that already fits has nothing to pan: lock it centred. Panning the
  // other one stops when that edge of the content meets that edge of the area,
  // which is reachable precisely because the content is centred at tx,ty = 0.
  tx = w <= a.w ? 0 : clamp(tx, -(w - a.w) / 2, (w - a.w) / 2);
  ty = h <= a.h ? 0 : clamp(ty, -(h - a.h) / 2, (h - a.h) / 2);
  const x = a.x + (a.w - w) / 2 + tx;
  const y = a.y + (a.h - h) / 2 + ty;
  stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  stage.style.visibility = "visible";
  levelOut.textContent = `${Math.round(scale * 100)}%`;
  viewport.classList.toggle("fitted", w <= a.w + 0.5 && h <= a.h + 0.5);
  btnOut.disabled = scale <= scaleMin() + 1e-6;
  btnIn.disabled = scale >= SCALE_MAX - 1e-6;
  if (mode !== shownMode) {
    shownMode = mode;
    for (const m of ["fit", "width", "actual"] as const) {
      modeButtons[m].setAttribute("aria-pressed", String(mode === m));
    }
  }
}

// A digit by its key on the top row as well, where a French keyboard needs
// Shift for it; a letter by its place only where the key types no Latin
// character (Greek, Cyrillic), as main.ts's keyIs does.
const isDigit = (e: KeyboardEvent, d: string): boolean => e.key === d || e.code === `Digit${d}`;
const isLetter = (e: KeyboardEvent, l: string): boolean =>
  e.key.toLowerCase() === l || (!/^[\x20-\x7e]$/.test(e.key) && e.code === `Key${l.toUpperCase()}`);

function wireViewport(): void {
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    dragged = false;
    drag = { x: e.clientX, y: e.clientY, tx, ty };
    viewport.setPointerCapture(e.pointerId);
    viewport.classList.add("panning");
  });
  viewport.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
    tx = drag.tx + dx;
    ty = drag.ty + dy;
    schedule();
  });
  const endDrag = (): void => {
    if (!drag) return;
    drag = null;
    viewport.classList.remove("panning");
  };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);
  viewport.addEventListener("lostpointercapture", endDrag);

  // plain wheel zooms here, like GitHub; preventDefault also keeps WebView2's
  // own page zoom out of the preview when Ctrl is held
  viewport.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(clamp(Math.exp(-e.deltaY * 0.0015), 0.5, 2), e.clientX, e.clientY);
    },
    { passive: false },
  );

  o.dialog.addEventListener("keydown", (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    // the copy menu has the keys while it has the focus (menuKeys.ts)
    if (copyMenu.contains(e.target as Node)) return;
    const pan = e.shiftKey ? 160 : 40;
    if (e.key === "+" || e.key === "=") zoomBy(STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / STEP);
    else if (isDigit(e, "0")) setMode("fit");
    else if (isLetter(e, "w")) setMode("width");
    else if (isDigit(e, "1")) setMode("actual");
    else if (e.key === "ArrowLeft") tx += pan;
    else if (e.key === "ArrowRight") tx -= pan;
    else if (e.key === "ArrowUp") ty += pan;
    else if (e.key === "ArrowDown") ty -= pan;
    else return;
    e.preventDefault();
    schedule();
  });
}

/* ---- copy / save: PNG, PNG 2x, SVG; a table's text ---- */

function toggleCopyMenu(): void {
  if (!copyMenu.hidden) {
    copyMenu.hidden = true;
    return;
  }
  // SVG only exists for diagrams; a table offers its text alone, no picture
  for (const el of copyMenu.querySelectorAll<HTMLElement>(":scope > .menu-item, :scope > .menu-sep")) {
    const only = el.dataset.kind;
    el.hidden = only ? only !== kind : kind === "table";
  }
  const r = btnCopy.getBoundingClientRect();
  copyMenu.style.left = `${Math.max(8, r.right - 250)}px`;
  copyMenu.style.bottom = `${window.innerHeight - r.top + 8}px`;
  copyMenu.hidden = false;
  copyMenu.querySelector<HTMLButtonElement>(".menu-item:not([hidden])")?.focus();
}

async function runCopyAction(action: string): Promise<void> {
  try {
    switch (action) {
      case "copy-table": {
        const shown = stage.querySelector("table");
        if (shown) await navigator.clipboard.writeText(tableToTsv(shown));
        break;
      }
      case "copy-png":
        await copyPng(2);
        break;
      case "copy-png-4x":
        await copyPng(4);
        break;
      case "copy-svg": {
        const text = await toSvgText();
        if (text) await navigator.clipboard.writeText(text);
        break;
      }
      case "save-png":
        await savePng();
        break;
      case "save-svg":
        await saveSvg();
        break;
    }
    flashDone();
  } catch {
    /* clipboard or dialog unavailable: nothing useful to say here */
  }
}

function flashDone(): void {
  btnCopy.classList.add("done");
  clearTimeout(copyTimer);
  copyTimer = window.setTimeout(() => btnCopy.classList.remove("done"), 1200);
}

async function copyPng(scale: number): Promise<void> {
  const blob = await toPng(scale);
  if (blob) await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}

async function savePng(): Promise<void> {
  const target = await saveDialog({
    defaultPath: `${(caption.textContent || "image").replace(/[\\/:*?"<>|]+/g, "-")}.png`,
    filters: [{ name: t("filter.png"), extensions: ["png"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  const blob = await toPng(2);
  if (!blob) return;
  await ipc.exportBinary(target, await blobToBase64(blob));
}

async function saveSvg(): Promise<void> {
  const target = await saveDialog({
    defaultPath: "diagram.svg",
    filters: [{ name: t("filter.svg"), extensions: ["svg"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  const text = await toSvgText();
  if (text) await ipc.exportFile(target, text);
}

// a standalone SVG of the diagram, always in the light palette so it reads
// on any background, with an intrinsic size
async function toSvgText(): Promise<string | null> {
  if (kind !== "mermaid") return null;
  const holder = document.createElement("div");
  holder.innerHTML = await renderMermaidSvg(source, false);
  const svg = holder.querySelector("svg");
  if (!svg) return null;
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  svg.setAttribute("width", String(natW));
  svg.setAttribute("height", String(natH));
  svg.style.removeProperty("max-width");
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(svg)}\n`;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).slice((reader.result as string).indexOf(",") + 1));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function toPng(scale: number): Promise<Blob | null> {
  if (kind === "table") return null;
  if (kind === "mermaid") {
    const svg = stage.querySelector("svg");
    if (!svg) return null;
    // rasterizeSvg serializes the element, and a standalone SVG needs an
    // intrinsic size rather than the 100% that only means something inside the
    // stage. The stage box equals the natural size, so nothing moves on screen.
    svg.style.removeProperty("width");
    svg.style.removeProperty("height");
    svg.setAttribute("width", String(natW));
    svg.setAttribute("height", String(natH));
    try {
      return dataUrlToBlob((await rasterizeSvg(svg, scale)).dataUrl);
    } finally {
      svg.removeAttribute("width");
      svg.removeAttribute("height");
      svg.style.setProperty("width", "100%");
      svg.style.setProperty("height", "100%");
    }
  }
  const blob = await (await fetch(source)).blob();
  if (blob.type === "image/png") return blob;
  // the clipboard only takes PNG; a blob-backed bitmap never taints the canvas
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// decoded by hand rather than through fetch(): the app CSP allows data: for
// img-src but not for connect-src, so fetching one would be blocked
function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(",", 2);
  const type = /:(.*?);/.exec(head)?.[1] ?? "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

/* ---- hover affordance ---- */

// One shared button, declared outside #app: the reading pane contains its
// layout (layout.css), so a fixed child there would be placed against the pane.
function wireHint(): void {
  o.pane.addEventListener("pointerover", (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-zoomable]") ?? null;
    if (el !== hintTarget) positionHint(el);
  });
  o.pane.addEventListener("pointerleave", (e) => {
    if (e.relatedTarget === o.hint) return; // the pointer moved onto the hint
    positionHint(null);
  });
  o.hint.addEventListener("pointerleave", (e) => {
    const to = e.relatedTarget as Node | null;
    if (to && o.pane.contains(to)) return; // the pane handler takes it from here
    positionHint(null);
  });
  o.pane.addEventListener("focusin", (e) => {
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>("[data-zoomable]") ?? null;
    if (el) positionHint(el);
  });
  o.pane.addEventListener(
    "scroll",
    () => {
      if (hintTarget) positionHint(hintTarget);
    },
    { passive: true },
  );
  o.hint.addEventListener("click", () => {
    if (hintTarget) void openFor(hintTarget);
  });
}

function positionHint(el: HTMLElement | null): void {
  // the article is rebuilt under us in edit mode: a detached target is stale
  if (!el || !el.isConnected) {
    hintTarget = null;
    o.hint.hidden = true;
    return;
  }
  hintTarget = el;
  const r = el.getBoundingClientRect();
  const p = o.pane.getBoundingClientRect();
  const left = Math.min(r.right, p.right) - HINT_GAP - HINT_SIZE;
  let top = Math.max(r.top + HINT_GAP, p.top + 6);
  for (const bar of o.bars) {
    if (bar.hidden) continue;
    const b = bar.getBoundingClientRect();
    if (b.height > 0 && b.left < left + HINT_SIZE && b.right > left) {
      top = Math.max(top, b.bottom + 6);
    }
  }
  const offPane = r.bottom < p.top || r.top > p.bottom || left < p.left;
  if (offPane || top + HINT_SIZE > r.bottom || top + HINT_SIZE > p.bottom) {
    o.hint.hidden = true;
    return;
  }
  o.hint.style.left = `${Math.round(left)}px`;
  o.hint.style.top = `${Math.round(top)}px`;
  o.hint.hidden = false;
}
