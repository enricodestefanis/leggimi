// Full-window preview for diagrams and images, in the spirit of GitHub's.
//
// The content is always re-rendered, never cloned: a cloned Mermaid SVG
// duplicates every id in the document, so its url(#marker) references would
// resolve to the article's copy — and silently break the moment edit mode
// rebuilds that copy. Re-rendering also answers the theme switch for free.

import { renderMermaidSvg } from "./mermaid";
import { rasterizeSvg } from "./share";
import * as theme from "./theme";

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

let o: LightboxOpts;
let viewport: HTMLElement;
let stage: HTMLElement;
let levelOut: HTMLElement;
let caption: HTMLElement;
let btnIn: HTMLButtonElement;
let btnOut: HTMLButtonElement;
let btnCopy: HTMLButtonElement;

let kind: "mermaid" | "image" = "image";
let source = "";
let natW = 0;
let natH = 0;
let scale = 1;
let fit = 1;
let tx = 0;
let ty = 0;

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

  btnIn.addEventListener("click", () => zoomBy(STEP));
  btnOut.addEventListener("click", () => zoomBy(1 / STEP));
  q("#zoom-fit").addEventListener("click", resetFit);
  q("#zoom-close").addEventListener("click", close);
  btnCopy.addEventListener("click", () => void copyAsImage());

  wireViewport();
  wireHint();

  opts.dialog.addEventListener("close", () => {
    stage.replaceChildren();
    source = "";
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
    if (isOpen()) {
      fit = computeFit();
      schedule();
    }
    if (hintTarget) positionHint(hintTarget);
  });
}

/* ---- marking the article ---- */

// Idempotent: edit mode rebuilds the article every ~200 ms, so this runs often.
// It only adds attributes — no wrappers, no new nodes — which is what keeps the
// scroll-sync anchors and the positional diagram index in share.ts intact.
export function markAll(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>(
    ".mermaid-diagram[data-mmd-source]:not([data-zoomable])",
  )) {
    mark(el, "Diagram — open preview");
  }
  for (const img of root.querySelectorAll<HTMLImageElement>(
    "img:not(.img-missing):not([data-zoomable])",
  )) {
    const alt = (img.getAttribute("alt") ?? "").trim();
    mark(img, `${alt || "Image"} — open preview`);
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
    caption.textContent = (el.getAttribute("alt") ?? "").trim() || "Image";
  } else {
    const src = el.dataset.mmdSource;
    if (!src) return;
    kind = "mermaid";
    source = src;
    caption.textContent = "Diagram";
  }
  positionHint(null);
  o.dialog.showModal();
  if (!(await build())) {
    close();
    return;
  }
  resetFit();
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
      markup = await renderMermaidSvg(source, theme.current() === "dark");
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
  } else {
    const img = document.createElement("img");
    img.src = source;
    img.alt = "";
    img.setAttribute("aria-hidden", "true");
    stage.replaceChildren(img);
  }
  stage.style.width = `${natW}px`;
  stage.style.height = `${natH}px`;
  stage.setAttribute("aria-label", caption.textContent ?? "Preview");
  return true;
}

/* ---- zoom and pan ---- */

function avail(): { w: number; h: number } {
  return {
    w: Math.max(80, window.innerWidth - MARGIN * 2),
    h: Math.max(80, window.innerHeight - MARGIN * 2 - BAR_SPACE),
  };
}

// A diagram is a vector, so filling the window costs nothing and is the whole
// point of opening it; a raster image is capped at 1:1, where upscaling only
// adds blur.
function computeFit(): number {
  const a = avail();
  return Math.min(a.w / natW, a.h / natH, kind === "mermaid" ? 4 : 1);
}

function resetFit(): void {
  fit = computeFit();
  scale = fit;
  tx = 0;
  ty = 0;
  schedule();
}

const scaleMin = (): number => Math.min(fit, SCALE_FLOOR);

// keeps the content point under px,py fixed while the scale changes
function zoomAt(k: number, px: number, py: number): void {
  const next = clamp(scale * k, scaleMin(), SCALE_MAX);
  const r = viewport.getBoundingClientRect();
  const factor = next / scale;
  tx = (1 - factor) * (px - (r.left + r.width / 2)) + factor * tx;
  ty = (1 - factor) * (py - (r.top + r.height / 2)) + factor * ty;
  scale = next;
  schedule();
}

function zoomBy(k: number): void {
  const r = viewport.getBoundingClientRect();
  zoomAt(k, r.left + r.width / 2, r.top + r.height / 2);
}

function schedule(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    applyNow();
  });
}

function applyNow(): void {
  const a = avail();
  const w = scale * natW;
  const h = scale * natH;
  // an axis that already fits has nothing to pan: lock it centred
  tx = w <= a.w ? 0 : clamp(tx, -(w - a.w) / 2, (w - a.w) / 2);
  ty = h <= a.h ? 0 : clamp(ty, -(h - a.h) / 2, (h - a.h) / 2);
  stage.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  levelOut.textContent = `${Math.round(scale * 100)}%`;
  viewport.classList.toggle("fitted", w <= a.w + 0.5 && h <= a.h + 0.5);
  btnOut.disabled = scale <= scaleMin() + 1e-6;
  btnIn.disabled = scale >= SCALE_MAX - 1e-6;
}

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
    const pan = e.shiftKey ? 160 : 40;
    if (e.key === "+" || e.key === "=") zoomBy(STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(1 / STEP);
    else if (e.key === "0") resetFit();
    else if (e.key === "ArrowLeft") tx += pan;
    else if (e.key === "ArrowRight") tx -= pan;
    else if (e.key === "ArrowUp") ty += pan;
    else if (e.key === "ArrowDown") ty -= pan;
    else return;
    e.preventDefault();
    schedule();
  });
}

/* ---- copy as image ---- */

async function copyAsImage(): Promise<void> {
  try {
    const blob = await toPng();
    if (!blob) return;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    btnCopy.classList.add("done");
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => btnCopy.classList.remove("done"), 1200);
  } catch {
    /* clipboard unavailable: nothing useful to say here */
  }
}

async function toPng(): Promise<Blob | null> {
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
      return dataUrlToBlob((await rasterizeSvg(svg)).dataUrl);
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

// One shared button, declared outside #app: .doc-enter animates a transform on
// #article, which would otherwise become the containing block of a fixed child.
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
