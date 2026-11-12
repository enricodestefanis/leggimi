// The path of the section being read (2.2). While the outline is out of
// sight, a thin line held at the top of the text names the section and the
// ones it sits under, "2. Decisioni › 2.1 Budget", without the document's
// title (sections.ts). A click on a part goes there exactly as a click in
// the outline does (toc.jumpTo): a place for Back, the glide, the landing.
//
// It shows only where it hides nothing the reader needs:
// - the section's own heading has gone out at the top;
// - no heading is in the band at the top: one arriving, or one just jumped
//   to (24 px down), owns the top, so every jump to a heading lands where it
//   always has;
// - no table header holds the top, or is about to (tableScroll.headCover);
// - no element with the keyboard's focus is under it.
// A jump to anything else (a footnote, an anchor, --line) leaves room for it
// (reserve, which main.ts's jumpTop adds).
//
// It is a shortcut for the mouse, out of the tab order and hidden from
// screen readers: the outline, the "." and "," keys, the palette's "#" and a
// screen reader's own heading navigation do the same work. So the parts are
// plain spans: nothing in it can take the focus.
//
// One update a frame at most. The headings are measured in one pass (after a
// build, or when the article changes size), relative to the article's top,
// so a frame reads two edges and the scroll position and searches the
// numbers; the DOM is written only when what it shows changes, after the
// reads.

import * as toc from "./toc";
import { outline, pathOf, type Outline } from "./sections";

export interface SectionLineOpts {
  /** #app, whose classes say where the outline is (panes.ts) and whether editing */
  app: HTMLElement;
  /** the document pane, the scroller */
  pane: HTMLElement;
  article: HTMLElement;
  /** #section-line, with its .sl-path */
  line: HTMLElement;
  /** reading mode, a document shown, no error card */
  readable: () => boolean;
  /** how much of the pane's top a stuck table header would cover over the content at y (tableScroll.headCover) */
  headCover: (y: number) => number;
}

/** its height: section-line.css's --section-line-h */
const LINE_H = 30;
// a heading whose box reaches this far into the top owns the top
const BAND = 56;
// a heading whose bottom is no lower than this has gone (the hairline of an
// H2's rule, a fraction of a pixel)
const GONE = 4;
// how far a focus ring reaches outside its element (base.css: 2px outline
// at a 2px offset)
const RING = 4;
// Faster than this, in px per ms, the page is flying by (a jump's glide, a
// fling, Page Down): rather than flash the path of every section passed,
// the line waits until the page settles,
const FAST = 2.4;
// which it has once it has gone no faster for this long: a path new on
// screen (or the line coming back) waits that long, so a fling that is
// only picking up speed flashes nothing either
const SETTLE_MS = 120;
// After a jump through the outline it stays away until the glide is over:
// this long after the last scroll event (toc.ts settles the same way).
// Chromium's smooth scroll holds still for its first frames (motion.ts).
const HOLD_MS = 250;
// how long after a click its double click's second press can come
// (Windows' default double-click time)
const DOUBLE_MS = 500;
const HEADINGS = "h1, h2, h3, h4, h5, h6";

let opts: SectionLineOpts | null = null;
let path: HTMLElement | null = null;

/* ---- measured, relative to the article's top edge ---- */

// The toc build the measures are for, and whether something has moved since.
// Relative to the article, a bar opening above it (find, notices) moves
// nothing measured.
let measuredFor: readonly HTMLElement[] | null = null;
let dirty = true;
// the outline's headings in sight (none in a closed <details>), their tops
// and their tree
let heads: HTMLElement[] = [];
let tops: number[] = [];
let tree: Outline = outline([]);
// every heading in sight, h1–h6: its top, and the lowest bottom up to it
let bandTops: number[] = [];
let bandReach: number[] = [];
// every table in sight, likewise: headCover is asked only when one spans
// the line's lower edge (it searches the whole document)
let tableTops: number[] = [];
let tableReach: number[] = [];

/* ---- on screen ---- */

let shown = false;
let shownHeads: HTMLElement[] = [];
let shownTexts: string[] = [];

let raf = 0;
// the scroll position at the last update, and when: the page's speed
let lastTop = Number.NaN;
let lastAt = 0;
let holding = false;
let holdTimer = 0;
// the path waiting to be shown (SETTLE_MS), since when
let pending: HTMLElement[] | null = null;
let pendingAt = 0;
let settleTimer = 0;

export function init(o: SectionLineOpts): void {
  opts = o;
  let p = o.line.querySelector<HTMLElement>(".sl-path");
  if (!p) {
    p = document.createElement("div");
    p.className = "sl-path";
    o.line.append(p);
  }
  path = p;
  o.pane.addEventListener("scroll", onScroll, { passive: true });
  // a picture loaded, a diagram drawn, a <details> opened or closed, the
  // window or the reading width changed: the headings have moved
  new ResizeObserver(() => {
    dirty = true;
    schedule();
  }).observe(o.article);
  // the outline shown, hidden, folded away or peeking; editing; no headings
  new MutationObserver(schedule).observe(o.app, { attributes: true, attributeFilter: ["class"] });
  // the keyboard's focus may have come to (or left) the place under the line
  o.article.addEventListener("focusin", schedule);
  o.article.addEventListener("focusout", schedule);
  // a press keeps the focus and the selection where they are
  o.line.addEventListener("mousedown", (e) => e.preventDefault());
  o.line.addEventListener("click", onClick);
  // Every jump through the outline (a click here or there, Enter in its
  // filter, the "." and "," keys, the palette) glides to a heading that will
  // take the top: the line goes at once, and stays away until the page has
  // landed. Otherwise a peek put away by its pick would let the old path
  // show while the glide has not yet started.
  toc.onGlide(() => {
    hold();
    show(null);
  });
}

/** The article has a new outline (after every toc.build): measured again. */
export function rebuild(): void {
  dirty = true;
  lastTop = Number.NaN; // another document's scroll position is no speed
  pending = null;
  schedule();
}

/** Something the line depends on has changed: updated at the next frame. */
export function refresh(): void {
  schedule();
}

/**
 * How much further down a jump to `el` must land for the line not to cover
 * it: its height when it is on and el sits in a section it would name, so it
 * will be there once the jump lands. Nothing for a heading (the line steps
 * aside for one at the top), for what comes before the first section (or
 * under the title alone), and for a place in a table whose header will be
 * holding the top (the line steps aside for that too).
 */
export function reserve(el: Element): number {
  const o = opts;
  if (!o || !enabled(o) || !o.article.contains(el) || el.closest(HEADINGS)) return 0;
  if (dirty || measuredFor !== toc.headings()) measure(o);
  // the last heading in sight before el, in document order
  let lo = 0;
  let hi = heads.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (heads[mid].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) lo = mid + 1;
    else hi = mid;
  }
  if (pathOf(tree, lo - 1).length === 0) return 0;
  const y = o.pane.scrollTop + el.getBoundingClientRect().top - o.pane.getBoundingClientRect().top;
  return o.headCover(y) > 0 ? 0 : LINE_H;
}

/** Gone at once, without the fade: the tab leaving the front, editing beginning. */
export function hideNow(): void {
  const o = opts;
  if (!o) return;
  clearTimeout(holdTimer);
  clearTimeout(settleTimer);
  holding = false;
  pending = null;
  dirty = true;
  lastTop = Number.NaN;
  shown = false;
  o.line.hidden = true;
  // the fade the change starts (or one still running) ends here
  for (const a of o.line.getAnimations()) a.finish();
}

/* ---- updating ---- */

function schedule(): void {
  if (!raf) raf = requestAnimationFrame(update);
}

function onScroll(): void {
  if (holding) hold(); // the jump's glide goes on
  schedule();
}

// The outline out of sight: hidden by the reader, or folded away for want of
// room and not peeking over the text. Never while editing, nor without
// headings (panes.ts, layout.css).
function enabled(o: SectionLineOpts): boolean {
  const c = o.app.classList;
  return (
    (c.contains("toc-hidden") || c.contains("toc-auto")) &&
    !c.contains("toc-peek") &&
    !c.contains("no-headings") &&
    !c.contains("editing") &&
    o.readable()
  );
}

function update(): void {
  raf = 0;
  const o = opts;
  if (!o) return;
  if (!enabled(o)) {
    lastTop = Number.NaN;
    pending = null;
    show(null);
    return;
  }
  if (dirty || measuredFor !== toc.headings()) measure(o);

  /* ---- reads ---- */
  const scrollTop = o.pane.scrollTop;
  const now = performance.now();
  const paneTop = o.pane.getBoundingClientRect().top;
  // the article's top edge below the pane's: where the measures start from
  const off = o.article.getBoundingClientRect().top - paneTop;
  const want = holding ? null : wanted(o, off, scrollTop, paneTop);
  // no speed without a previous position (NaN compares false)
  const fast = Math.abs(scrollTop - lastTop) / Math.max(1, now - lastAt) > FAST;
  lastTop = scrollTop;
  lastAt = now;

  /* ---- writes ---- */
  if (!want) {
    pending = null;
    show(null);
    return;
  }
  // the path on screen stays, flying by or not
  if (shown && same(want, shownHeads)) {
    pending = null;
    return;
  }
  // Another path, or the line coming back, waits until the page has gone
  // slowly for SETTLE_MS with that path wanted all along (a fast frame starts
  // the wait again); a path no longer right goes at once.
  if (fast || !pending || !same(pending, want)) {
    pending = want;
    pendingAt = now;
  }
  const left = SETTLE_MS - (now - pendingAt);
  if (left > 0) {
    show(null);
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(schedule, left + 1);
    return;
  }
  pending = null;
  show(want);
}

// The headings of the path to show now, or null when the line must not be there.
function wanted(o: SectionLineOpts, off: number, scrollTop: number, paneTop: number): HTMLElement[] | null {
  // the section being read: the last heading whose top has passed the pane's top edge
  const cur = countBelow(tops, -off) - 1;
  const p = pathOf(tree, cur);
  if (p.length === 0) return null;
  // a heading reaching into the band at the top owns it: the next one
  // arriving, or this section's own, not yet gone (in normal flow the tops
  // come in order; the bottoms are kept as the lowest so far)
  const k = countBelow(bandTops, BAND - off);
  if (k > 0 && off + bandReach[k - 1] > GONE) return null;
  // a table's header holding the top, or about to, would be under the line:
  // asked only when a table spans the line's lower edge
  const edge = LINE_H - off;
  const t = countBelow(tableTops, edge);
  if (t > 0 && tableReach[t - 1] > edge && o.headCover(scrollTop + LINE_H) > 0) return null;
  if (focusUnder(o.article, paneTop)) return null;
  return p.map((i) => heads[i]);
}

// An element of the document with the keyboard's focus, its ring where the line would be.
function focusUnder(article: HTMLElement, paneTop: number): boolean {
  const f = document.activeElement;
  if (!f || f === article || !article.contains(f) || !f.matches(":focus-visible")) return false;
  const r = f.getBoundingClientRect();
  return r.bottom > paneTop - RING && r.top < paneTop + LINE_H + RING;
}

// One read pass: where every heading sits below the article's top, those
// out of sight in a closed <details> left out (they have no place on the
// page to name, nor to jump to). The outline's own make the tree.
function measure(o: SectionLineOpts): void {
  dirty = false;
  measuredFor = toc.headings();
  const tracked = new Set(measuredFor);
  const base = o.article.getBoundingClientRect().top;
  const levels: number[] = [];
  heads = [];
  tops = [];
  bandTops = [];
  bandReach = [];
  let reach = -Infinity;
  for (const h of o.article.querySelectorAll<HTMLElement>(HEADINGS)) {
    if (!h.checkVisibility()) continue;
    const r = h.getBoundingClientRect();
    if (r.height === 0) continue;
    const top = r.top - base;
    reach = Math.max(reach, r.bottom - base);
    bandTops.push(top);
    bandReach.push(reach);
    if (!tracked.has(h)) continue;
    heads.push(h);
    tops.push(top);
    levels.push(Number(h.tagName[1]));
  }
  tree = outline(levels);
  tableTops = [];
  tableReach = [];
  let far = -Infinity;
  for (const t of o.article.querySelectorAll<HTMLElement>(".table-block > .table-scroll > table")) {
    if (!t.checkVisibility()) continue;
    const r = t.getBoundingClientRect();
    far = Math.max(far, r.bottom - base);
    tableTops.push(r.top - base);
    tableReach.push(far);
  }
}

// The DOM follows: the parts rewritten only when their text changes, the
// line faded in or out (section-line.css) only when that changes.
function show(want: HTMLElement[] | null): void {
  const o = opts;
  if (!o || !path) return;
  if (!want) {
    if (shown) {
      shown = false;
      o.line.hidden = true;
    }
    return;
  }
  if (!same(want, shownHeads)) {
    // the same names for new elements (the document read again): only the
    // clicks need to know
    const texts = want.map(textOf);
    if (!same(texts, shownTexts)) render(path, texts);
    shownTexts = texts;
    shownHeads = want;
  }
  if (!shown) {
    shown = true;
    o.line.hidden = false;
  }
}

function render(into: HTMLElement, texts: readonly string[]): void {
  const parts: HTMLElement[] = [];
  texts.forEach((text, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "sl-sep";
      sep.textContent = "›";
      parts.push(sep);
    }
    const seg = document.createElement("span");
    seg.className = "sl-seg";
    seg.dataset.i = String(i);
    // a heading in a right-to-left script reads (and is cut short) its own way
    seg.dir = "auto";
    seg.textContent = text;
    seg.title = text;
    parts.push(seg);
  });
  into.replaceChildren(...parts);
}

// A heading's name as the outline shows it, on one line; a heading that is
// only a picture goes by its alt text
function textOf(h: HTMLElement): string {
  const text = (h.textContent ?? "").replace(/\s+/g, " ").trim();
  if (text) return text;
  const alt = [...h.querySelectorAll("img")].map((img) => img.alt.trim()).filter(Boolean);
  return alt.join(" ") || "§";
}

function onClick(e: MouseEvent): void {
  const seg = e.target instanceof Element ? e.target.closest<HTMLElement>(".sl-seg") : null;
  const h = seg ? shownHeads[Number(seg.dataset.i)] : undefined;
  if (!h || !opts) return;
  const place = opts.line.getBoundingClientRect();
  // as a click in the outline: the line steps aside as the glide starts (onGlide)
  if (toc.jumpTo(h)) swallowSecondPress(place);
}

// The line goes as its click jumps, and Chromium stops hitting it as its
// fade begins: the second press of a double click on a part would land on
// the text under it, selecting a word or following a link. Where the line
// was, a press, a click or a double click that soon after is swallowed, so a
// double click jumps once and leaves one place for Back.
function swallowSecondPress(place: DOMRect): void {
  const until = performance.now() + DOUBLE_MS;
  const types = ["mousedown", "click", "dblclick"] as const;
  const swallow = (e: MouseEvent): void => {
    if (performance.now() > until) return;
    if (e.clientX < place.left || e.clientX > place.right || e.clientY < place.top || e.clientY > place.bottom) return;
    e.preventDefault();
    e.stopPropagation();
  };
  for (const t of types) window.addEventListener(t, swallow, true);
  window.setTimeout(() => {
    for (const t of types) window.removeEventListener(t, swallow, true);
  }, DOUBLE_MS);
}

function hold(): void {
  holding = true;
  clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    holding = false;
    schedule();
  }, HOLD_MS);
}

/* ---- helpers ---- */

// how many of the values (in increasing order) are below x
function countBelow(values: readonly number[], x: number): number {
  let lo = 0;
  let hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function same<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
