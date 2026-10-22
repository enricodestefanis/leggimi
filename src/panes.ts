// The side panes: their widths, and whether they are shown.
//
// Widths. The current widths are also the minimums: a pane can be widened,
// never narrowed. Follows the idiom of prefs.ts and theme.ts — the absence of
// the localStorage key means "default". The stored width is what the user
// asked for; the applied width is that value clamped to the room available
// right now, so shrinking the window never destroys a choice — re-widening
// brings it back.
//
// Showing. Ctrl+B and Ctrl+I (and their toolbar buttons) hide and show a pane
// as the user's choice, stored as tree-hidden / toc-hidden. A window too
// narrow for a pane collapses it by itself (tree-auto / toc-auto: the outline
// goes first, then the files), which is never stored, so widening the window
// brings the pane back. A collapsed pane can still be called up: it then
// peeks over the text (tree-peek / toc-peek) until Escape, a click outside it
// or a pick puts it away. The classes live on #app, where layout.css reads them.

export type Pane = "tree" | "toc";

const DEFAULTS: Record<Pane, number> = { tree: 260, toc: 240 };
const MAX: Record<Pane, number> = { tree: 560, toc: 520 };
const CSS_VAR: Record<Pane, string> = { tree: "--tree-width", toc: "--toc-width" };
const KEY: Record<Pane, string> = { tree: "tree-width", toc: "toc-width" };
// the user's choice: the localStorage key and the class on #app share the name
const HIDDEN: Record<Pane, string> = { tree: "tree-hidden", toc: "toc-hidden" };
const PANES: Pane[] = ["tree", "toc"];
const MIN_CONTENT = 420; // the article must stay readable whatever happens
// Below this width left for the text, panes at their narrowest collapse: the
// outline first, then the files. Widened panes give their extra width back
// first (MIN_CONTENT above), so a pane never collapses for being wide.
const READ_MIN = 520;
// a shell narrower than this edits without the preview beside the editor
const NARROW = 760;

const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

let app: HTMLElement;
let shell: HTMLElement;
let elements: Record<Pane, HTMLElement>;
let handles: Record<Pane, HTMLElement>;
let buttons: Record<Pane, HTMLElement>;
const desired: Record<Pane, number> = { ...DEFAULTS };
const hidden: Record<Pane, boolean> = { tree: false, toc: false };
const auto: Record<Pane, boolean> = { tree: false, toc: false };
let peek: Pane | null = null;
// what had the focus before a peek opened, for when it closes from within
let returnFocus: HTMLElement | null = null;
let raf = 0;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function init(opts: {
  app: HTMLElement;
  shell: HTMLElement;
  panes: Record<Pane, HTMLElement>;
  handles: Record<Pane, HTMLElement>;
  /** the toolbar buttons that toggle the panes: a click there is no click outside a peek */
  buttons: Record<Pane, HTMLElement>;
}): void {
  app = opts.app;
  shell = opts.shell;
  elements = opts.panes;
  handles = opts.handles;
  buttons = opts.buttons;
  for (const p of PANES) {
    hidden[p] = localStorage.getItem(HIDDEN[p]) === "1";
    app.classList.toggle(HIDDEN[p], hidden[p]);
    desired[p] = read(p);
    wire(p);
    // Tab (or Shift+Tab) out of a peek puts it away: the focus would sit on
    // the text hidden under it. A menu or dialog opened from inside keeps it.
    elements[p].addEventListener("focusout", (e) => {
      if (peek !== p) return;
      const to = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null;
      if (!to || elements[p].contains(to) || buttons[p].contains(to)) return;
      if (to.closest(".menu, dialog, [popover]")) return;
      setPeek(null, "keep");
    });
  }
  // a narrower window shrinks the applied width without forgetting the stored one
  window.addEventListener("resize", refresh);
  // Before anything else sees them: a press outside a peek puts it away (even
  // where a click handler stops propagation), and Escape is the peek's first.
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  apply();
}

function read(p: Pane): number {
  const n = Number(localStorage.getItem(KEY[p]));
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS[p];
  return clamp(n, DEFAULTS[p], MAX[p]);
}

function persist(p: Pane): void {
  if (desired[p] === DEFAULTS[p]) localStorage.removeItem(KEY[p]);
  else localStorage.setItem(KEY[p], String(Math.round(desired[p])));
}

// in the grid beside the text: a peek floats over it and takes no room
const visible = (p: Pane): boolean => elements[p].offsetParent !== null && peek !== p;

// The other pane is measured from its stored width alone: clamping it here too
// would recurse, and its own clamp runs in the same pass anyway.
function maxFor(p: Pane): number {
  const other: Pane = p === "tree" ? "toc" : "tree";
  const taken = visible(other) ? clamp(desired[other], DEFAULTS[other], MAX[other]) : 0;
  const room = shell.clientWidth - MIN_CONTENT - taken;
  return Math.max(DEFAULTS[p], Math.min(MAX[p], room));
}

const effective = (p: Pane): number => clamp(desired[p], DEFAULTS[p], maxFor(p));

export function setDesired(p: Pane, px: number): void {
  desired[p] = clamp(px, DEFAULTS[p], maxFor(p));
  schedule();
}

export function reset(p: Pane): void {
  desired[p] = DEFAULTS[p];
  persist(p);
  apply();
}

/** Re-clamps both panes and re-decides what fits: the window resized, a pane
 *  was shown or hidden, the outline emptied, edit mode began or ended. */
export function refresh(): void {
  apply();
}

function schedule(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    apply();
  });
}

function apply(): void {
  fit();
  const root = document.documentElement;
  for (const p of PANES) {
    const w = effective(p);
    root.style.setProperty(CSS_VAR[p], `${Math.round(w)}px`);
    handles[p].setAttribute("aria-valuenow", String(Math.round(w)));
    handles[p].setAttribute("aria-valuemax", String(Math.round(maxFor(p))));
  }
}

/* ---- showing and collapsing ---- */

const editing = (): boolean => app.classList.contains("editing");
// an outline with no headings is not shown at all, so it never peeks either
const available = (p: Pane): boolean => p === "tree" || !app.classList.contains("no-headings");

// Which panes the window has room for. Each is measured at its narrowest:
// the outline collapses when the text would get less than READ_MIN beside
// both panes, the files when it would beside the files alone.
function fit(): void {
  const w = shell.clientWidth;
  if (w === 0) return; // minimised: keep the layout it had
  const wantTree = !hidden.tree;
  const wantToc = !hidden.toc && available("toc");
  const room = (tree: boolean, toc: boolean): number =>
    w - (tree ? DEFAULTS.tree : 0) - (toc ? DEFAULTS.toc : 0);
  auto.toc = wantToc && room(wantTree, true) < READ_MIN;
  auto.tree = wantTree && room(true, false) < READ_MIN;
  app.classList.toggle("tree-auto", auto.tree);
  app.classList.toggle("toc-auto", auto.toc);
  app.classList.toggle("is-narrow", w < NARROW);
  // a pane with room again docks, focus and all (in edit mode the editor
  // holds its place); an outline left without headings simply goes
  if (peek && (hidden[peek] || !available(peek) || (!auto[peek] && !editing()))) setPeek(null, "keep");
}

// a pane that wants to show and cannot dock: the window is too narrow for it,
// or (for show) edit mode has the editor where it would go
const collapsed = (p: Pane): boolean => !hidden[p] && available(p) && (auto[p] || editing());

/**
 * The toolbar button, Ctrl+B / Ctrl+I: flips the stored choice, or, for a pane
 * the window has no room for, opens or closes its peek. `focus` moves the
 * keys into a peek that opens (from the keyboard). In edit mode only the
 * choice flips, as before: the panes return with the reading view.
 */
export function toggle(p: Pane, opts: { focus?: boolean } = {}): void {
  if (peek === p) {
    setPeek(null, "restore"); // as Escape: the keys go back where they were
    return;
  }
  if (!editing() && collapsed(p)) {
    openPeek(p, opts.focus);
    return;
  }
  setHidden(p, !hidden[p]);
  // shown again in a window too narrow for it: it peeks, so the key did something
  if (!hidden[p] && !editing() && collapsed(p)) openPeek(p, opts.focus);
}

/**
 * The pane is wanted now (the folder search, a link to a folder): shown and
 * stored so, or peeking when it cannot dock, in edit mode too.
 */
export function show(p: Pane, opts: { focus?: boolean } = {}): void {
  if (hidden[p]) setHidden(p, false);
  if (collapsed(p)) openPeek(p, opts.focus);
}

/**
 * Puts a peek away after a pick in it (a file, a search hit, an outline
 * entry): the keys go to the document, where the pick leads. True when one
 * was open.
 */
export function closePeek(): boolean {
  if (!peek) return false;
  setPeek(null, "release");
  return true;
}

export function isPeeking(p?: Pane): boolean {
  return p ? peek === p : peek !== null;
}

function setHidden(p: Pane, value: boolean): void {
  hidden[p] = value;
  app.classList.toggle(HIDDEN[p], value);
  localStorage.setItem(HIDDEN[p], value ? "1" : "0");
  apply(); // the other pane may now have room to reach its stored width
}

function openPeek(p: Pane, focus = false): void {
  if (peek !== p) {
    if (peek) setPeek(null, "keep");
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnFocus = active && active !== document.body && !elements[p].contains(active) ? active : null;
    setPeek(p, "keep");
  }
  if (focus) focusInto(p);
}

// Where the keys go when a peek closes with the focus inside it (the pane is
// about to vanish under it): "restore" gives it back to what had it before
// the peek (Escape, the toggle), "release" leaves it to the document (a
// pick), "keep" does nothing (a click outside moves it to what was clicked).
// No width changes: a peeking pane takes no room, and once put away it is
// still collapsed.
function setPeek(p: Pane | null, focus: "restore" | "release" | "keep"): void {
  const was = peek;
  if (was === p) return;
  peek = p;
  for (const q of PANES) app.classList.toggle(`${q}-peek`, q === p);
  if (was && focus !== "keep" && elements[was].contains(document.activeElement)) {
    if (focus === "restore") returnFocus?.focus({ preventScroll: true });
    // nothing to return to, or it cannot take the focus any more
    if (elements[was].contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  }
  if (!p) returnFocus = null;
}

// The keys go to what is current in the pane: the open file's row (or the
// tree's tabbable one), the outline's active entry, else its first row, else
// its first control.
function focusInto(p: Pane): void {
  const el = elements[p];
  const shown = (sel: string): HTMLElement | undefined =>
    [...el.querySelectorAll<HTMLElement>(sel)].find((n) => n.getClientRects().length > 0);
  const target =
    shown('[aria-current="true"], .tree-row.active, .toc-item.active') ??
    shown('.tree-row[tabindex="0"]') ??
    shown(".tree-row, .search-file, .toc-item") ??
    shown("button:not(:disabled), input, [tabindex]:not([tabindex='-1'])");
  target?.focus();
}

function onPointerDown(e: PointerEvent): void {
  if (!peek) return;
  const t = e.target as Node | null;
  // its own toolbar button closes it on the click that follows (toggle)
  if (t && (elements[peek].contains(t) || buttons[peek].contains(t))) return;
  setPeek(null, "keep");
}

function onKeyDown(e: KeyboardEvent): void {
  if (!peek || e.key !== "Escape" || e.defaultPrevented) return;
  if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
  const t = e.target instanceof HTMLElement ? e.target : null;
  // what sits above the peek closes first: a dialog, a popover, a menu
  if (t?.closest("dialog") || document.querySelector(":popover-open") || menuOpen()) return;
  // the pane's own search or filter box with text in it clears first
  // (main.ts), and the next Escape closes the pane
  if (t instanceof HTMLInputElement && t.value !== "" && elements[peek].contains(t)) return;
  e.preventDefault();
  e.stopPropagation();
  setPeek(null, "restore");
}

const menuOpen = (): boolean =>
  [...document.querySelectorAll<HTMLElement>(".menu")].some((m) => !m.hidden && m.getClientRects().length > 0);

/* ---- resizing ---- */

function wire(p: Pane): void {
  const h = handles[p];
  // the tree grows as the handle moves right, the outline as it moves left
  const dir = p === "tree" ? 1 : -1;
  let origin: { x: number; w: number } | null = null;

  h.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no focus flicker
    origin = { x: e.clientX, w: effective(p) };
    h.setPointerCapture(e.pointerId);
    h.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  h.addEventListener("pointermove", (e) => {
    if (!origin) return;
    setDesired(p, origin.w + dir * (e.clientX - origin.x));
  });
  const end = (): void => {
    if (!origin) return;
    origin = null;
    h.classList.remove("dragging");
    document.body.classList.remove("resizing");
    persist(p); // one write per drag, not one per frame
  };
  h.addEventListener("pointerup", end);
  h.addEventListener("pointercancel", end);
  h.addEventListener("lostpointercapture", end);
  h.addEventListener("dblclick", () => reset(p));

  h.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    if (e.key === "ArrowLeft") setDesired(p, effective(p) - dir * step);
    else if (e.key === "ArrowRight") setDesired(p, effective(p) + dir * step);
    else if (e.key === "Home") desired[p] = DEFAULTS[p];
    else if (e.key === "End") desired[p] = maxFor(p);
    else return;
    e.preventDefault(); // and keep the arrows from scrolling the pane
    apply();
    persist(p);
  });
}
