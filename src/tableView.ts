// The full-window preview of a table, opened by lightbox.ts: a reader for the
// table rather than a picture of it. A diagram or an image is looked at, so
// the preview zooms and pans it; a table is read, row after row, so here it
// sits in a real scroller:
//
//  - the wheel, the touchpad, the scrollbars and the keys scroll it; the text
//    can be selected; Ctrl+wheel, + and − change the text size (CSS zoom, laid
//    out again, so the text stays sharp at every size);
//  - its header row sticks to the top, and scrolls sideways with its columns
//    (one scroller for both directions); when the table scrolls sideways, its
//    first column sticks to the left, unless it would take too much room;
//  - a filter keeps the rows that contain every word typed (Ctrl+F);
//  - a click on a column's header sorts the rows by it, up, down, and back to
//    the document's order, reading numbers, amounts, percentages and dates as
//    such.
//
// It works on a copy (without the document's ids), which it reorders and
// filters as it likes: the document and the file never change. Copy for
// Excel copies what is shown: the rows left, in the order shown.

import { current as lang, t } from "./i18n";

export interface TableViewOpts {
  dialog: HTMLDialogElement;
  /** the preview's toolbar: the filter goes in after the caption */
  bar: HTMLElement;
  caption: HTMLElement;
  levelOut: HTMLElement;
  btnIn: HTMLButtonElement;
  btnOut: HTMLButtonElement;
  width: HTMLButtonElement;
  actual: HTMLButtonElement;
  /** closes the preview */
  close: () => void;
}

type Mode = "width" | "actual";

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
// Width never enlarges a table more than this: past it, a small table is
// only big text
const WIDTH_CAP = 1.5;
// the first column sticks only while it leaves most of the view to the rest
const FREEZE_SHARE = 0.35;
const FILTER_DELAY = 80;

let o: TableViewOpts;
let view: HTMLElement;
let filterBox: HTMLElement;
let filterSep: HTMLElement;
let input: HTMLInputElement;
let count: HTMLElement;

let source: HTMLTableElement | null = null;
let sheet: HTMLElement | null = null;
let shown: HTMLTableElement | null = null;
let empty: HTMLElement | null = null;
// the copy's links, each to the document's own: a click follows that one
let links = new WeakMap<Element, Element>();
// the body rows in the document's order, and their text for the filter
let rows: HTMLTableRowElement[] = [];
let texts: string[] = [];
let sortable = false;
let freezable = false;
let sort: { col: number; dir: 1 | -1 } | null = null;
let keys = new Map<number, Key[]>();
// the table's widths at 100%: as wide as it would go, as narrow as it can be
let natMax = 0;
let natMin = 0;
// the sheet's own border, around the table, at 100%
let frameW = 0;
let zoom = 1;
let mode: Mode | null = "actual";
let filterTimer: number | undefined;
let locked = false;
let pan: { id: number; x: number; y: number; left: number; top: number } | null = null;

export function init(opts: TableViewOpts): void {
  o = opts;
  view = document.createElement("div");
  view.id = "zoom-table-view";
  view.tabIndex = 0;
  view.setAttribute("role", "region");
  view.setAttribute("aria-label", t("zoom.tableViewport"));
  o.dialog.insertBefore(view, o.bar);

  filterBox = document.createElement("label");
  filterBox.className = "zoom-filter";
  filterBox.hidden = true;
  filterBox.innerHTML =
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/>' +
    '<line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
  input = document.createElement("input");
  input.id = "zoom-filter-input";
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.placeholder = t("zoom.filter");
  input.setAttribute("aria-label", t("zoom.filter"));
  input.setAttribute("aria-keyshortcuts", "Control+F");
  input.title = t("zoom.filterHint");
  count = document.createElement("span");
  count.id = "zoom-filter-count";
  count.setAttribute("aria-live", "polite");
  filterBox.append(input, count);
  filterSep = document.createElement("span");
  filterSep.className = "zoom-sep";
  filterSep.hidden = true;
  // after the caption and its separator
  const after = o.caption.nextElementSibling ?? o.caption;
  after.after(filterBox, filterSep);

  input.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = window.setTimeout(applyFilter, FILTER_DELAY);
  });

  view.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return; // the wheel scrolls; with Ctrl it sizes the text
      e.preventDefault();
      zoomAt(Math.min(2, Math.max(0.5, Math.exp(-e.deltaY * 0.0015))), e.clientX, e.clientY);
    },
    { passive: false },
  );

  // Escape with the focus outside the dialog's elements never reaches onKey:
  // the dialog asks to close all the same, and a filter is emptied first
  o.dialog.addEventListener("cancel", (e) => {
    if (!shown || !input.value) return;
    e.preventDefault();
    input.value = "";
    applyFilter();
  });

  view.addEventListener("click", onClick);
  view.addEventListener("auxclick", (e) => {
    if (e.button === 1) onClick(e);
  });
  wirePan();
}

/** The table shown, for Copy for Excel: its rows as they are now. */
export function shownTable(): HTMLTableElement | null {
  return shown;
}

/** Fills the view with a copy of `from`; false when there is nothing to show. */
export function open(from: HTMLTableElement): boolean {
  reset();
  const copy = from.cloneNode(true) as HTMLTableElement;
  // a second element with a document id would answer its links and lookups
  for (const el of [copy, ...copy.querySelectorAll("[id]")]) el.removeAttribute("id");
  for (const el of copy.querySelectorAll("[data-source-line]")) el.removeAttribute("data-source-line");
  // a task box here would look like it ticks the file: it does not
  for (const box of copy.querySelectorAll("input")) box.disabled = true;
  const theirs = [...from.querySelectorAll("a[href], area[href]")];
  links = new WeakMap([...copy.querySelectorAll("a[href], area[href]")].map((a, i) => [a, theirs[i]]));

  sheet = document.createElement("div");
  sheet.className = "markdown-body zoom-table-sheet";
  empty = document.createElement("p");
  empty.className = "zoom-table-empty";
  empty.hidden = true;
  sheet.append(copy, empty);
  view.replaceChildren(sheet);
  source = from;
  shown = copy;

  rows = copy.tBodies.length ? [...copy.tBodies].flatMap((b) => [...b.rows]) : [];
  texts = rows.map((r) => fold([...r.cells].map((c) => c.textContent ?? "").join(" ")));
  sortable = makeSortable(copy);
  freezable = [...copy.rows].every((r) => !r.cells[0] || (r.cells[0].colSpan === 1 && r.cells[0].rowSpan === 1));

  filterBox.hidden = rows.length === 0;
  filterSep.hidden = filterBox.hidden;
  showCount();

  // the widths at 100%, before anything is scaled
  sheet.style.zoom = "1";
  copy.style.width = "max-content";
  natMax = copy.offsetWidth;
  copy.style.width = "min-content";
  natMin = copy.offsetWidth;
  copy.style.width = "";
  frameW = sheet.offsetWidth - sheet.clientWidth;
  if (natMax === 0) {
    reset();
    return false;
  }
  // a table that cannot fit the window at 100% opens at 100%, where it
  // scrolls sideways; one that fits opens at the window's width
  setMode(natMin + frame() > room() ? "actual" : "width");
  view.scrollTop = 0;
  view.scrollLeft = 0;
  return true;
}

/** Empties the view: the preview closed, or shows something else. */
export function reset(): void {
  clearTimeout(filterTimer);
  view?.replaceChildren();
  CSS.highlights?.delete("table-filter");
  source = sheet = shown = empty = null;
  rows = [];
  texts = [];
  keys = new Map();
  sort = null;
  locked = false;
  pan = null;
  if (input) input.value = "";
  if (filterBox) filterBox.hidden = filterSep.hidden = true;
}

export function focus(): void {
  view.focus({ preventScroll: true });
}

/* ---- size ---- */

const room = (): number => view.clientWidth;
const frame = (): number => frameW;
const clampZoom = (z: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// Width: the size at which the table fills the window's width, if it is
// narrower (never above WIDTH_CAP), or fits in it, if it is wider (never below
// ZOOM_MIN); a table that fits by wrapping its cells stays at 100%.
function widthZoom(): number {
  const w = room();
  const f = frame();
  if (natMax + f <= w) return Math.min(WIDTH_CAP, w / (natMax + f));
  if (natMin + f > w) return clampZoom(w / (natMin + f));
  return 1;
}

export function setMode(m: Mode): void {
  if (!shown) return;
  mode = m;
  apply(m === "width" ? widthZoom() : 1);
}

export function zoomBy(k: number): void {
  const r = view.getBoundingClientRect();
  zoomAt(k, r.left + r.width / 2, r.top + r.height / 2);
}

// keeps the point under (x, y) where it is while the text changes size
function zoomAt(k: number, x: number, y: number): void {
  if (!shown) return;
  const next = clampZoom(zoom * k);
  if (Math.abs(next - zoom) < 1e-3) return;
  const r = view.getBoundingClientRect();
  const px = x - r.left;
  const py = y - r.top;
  const cx = (view.scrollLeft + px) / zoom;
  const cy = (view.scrollTop + py) / zoom;
  mode = null;
  apply(next);
  view.scrollLeft = cx * next - px;
  view.scrollTop = cy * next - py;
}

/** The window resized: Width fits again; a size of the reader's own stays. */
export function refit(): void {
  if (!shown) return;
  if (mode === "width") apply(widthZoom());
  else refreeze();
}

function apply(z: number): void {
  if (!sheet) return;
  zoom = z;
  sheet.style.zoom = String(z);
  o.levelOut.textContent = `${Math.round(z * 100)}%`;
  o.btnOut.disabled = z <= ZOOM_MIN + 1e-3;
  o.btnIn.disabled = z >= ZOOM_MAX - 1e-3;
  o.width.setAttribute("aria-pressed", String(mode === "width"));
  o.actual.setAttribute("aria-pressed", String(mode === "actual"));
  refreeze();
}

// The first column sticks while the table scrolls sideways, if it takes no
// more than its share of the view and no cell spans into or across it.
function refreeze(): void {
  if (!shown) return;
  shown.classList.remove("zt-freeze");
  if (!freezable) return;
  const over = view.scrollWidth > view.clientWidth + 1;
  const cell = (rows.find((r) => !r.hidden) ?? shown.rows[0])?.cells[0];
  const w = cell ? cell.getBoundingClientRect().width : 0;
  shown.classList.toggle("zt-freeze", over && w > 0 && w <= view.clientWidth * FREEZE_SHARE);
}

/* ---- keys ---- */

const isLetter = (e: KeyboardEvent, l: string): boolean =>
  e.key.toLowerCase() === l || (!/^[\x20-\x7e]$/.test(e.key) && e.code === `Key${l.toUpperCase()}`);
const isDigit = (e: KeyboardEvent, d: string): boolean => e.key === d || e.code === `Digit${d}`;

/**
 * The preview's keys while a table is shown (lightbox.ts hands them all
 * here). The arrows, Page Up/Down, Home/End and Space scroll the view on
 * their own; Escape is the dialog's, once the filter is empty.
 */
export function onKey(e: KeyboardEvent): void {
  if (e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey && isLetter(e, "f")) {
    e.preventDefault();
    if (filterBox.hidden) return;
    input.focus();
    input.select();
    return;
  }
  // The first Escape empties the filter, wherever the focus is; the next one
  // closes the preview. A menu open over it (the copy menu) closes first.
  if (e.key === "Escape" && input.value && !e.defaultPrevented && !e.ctrlKey && !e.altKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    input.value = "";
    applyFilter();
    return;
  }
  if (e.target === input) {
    if (e.key === "Enter" || (e.key === "ArrowDown" && !e.altKey)) {
      e.preventDefault();
      focus();
    }
    return;
  }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if ((e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]")) return;
  let done = true;
  if (e.key === "+" || e.key === "=") zoomBy(1.25);
  else if (e.key === "-" || e.key === "_") zoomBy(1 / 1.25);
  else if (isDigit(e, "0") || isDigit(e, "1")) setMode("actual");
  else if (isLetter(e, "w")) setMode("width");
  else done = false;
  if (done) e.preventDefault();
}

/* ---- the middle button drags the table about, as in the document ---- */

function wirePan(): void {
  view.addEventListener("pointerdown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // no autoscroll icon
    // on a link, the middle button opens it (onClick), as in the document
    if ((e.target as Element).closest("a[href], area[href]")) return;
    pan = { id: e.pointerId, x: e.clientX, y: e.clientY, left: view.scrollLeft, top: view.scrollTop };
    view.setPointerCapture(e.pointerId);
    view.classList.add("panning");
  });
  view.addEventListener("pointermove", (e) => {
    if (!pan || e.pointerId !== pan.id) return;
    if (!(e.buttons & 4)) {
      endPan();
      return;
    }
    view.scrollLeft = pan.left - (e.clientX - pan.x);
    view.scrollTop = pan.top - (e.clientY - pan.y);
  });
  const endPan = (): void => {
    if (!pan) return;
    pan = null;
    view.classList.remove("panning");
  };
  view.addEventListener("pointerup", endPan);
  view.addEventListener("pointercancel", endPan);
  view.addEventListener("lostpointercapture", endPan);
}

/* ---- clicks: links, and the headers that sort ---- */

function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const a = target.closest("a[href], area[href]");
  if (a && view.contains(a)) {
    // the link is the document's: the preview steps aside, and the
    // document's own link takes the click, with its keys and button
    e.preventDefault();
    const theirs = links.get(a);
    const alive = theirs?.isConnected && source?.isConnected;
    o.close();
    if (alive && theirs) {
      theirs.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          button: e.button,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        }),
      );
    }
    return;
  }
  if (e.button !== 0) return;
  const th = target.closest<HTMLElement>("th[data-col]");
  if (!th || !shown?.contains(th)) return;
  // the end of a selection of the header's text is not a click on it
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && th.contains(sel.anchorNode)) return;
  sortBy(Number(th.dataset.col));
}

/* ---- filter ---- */

// what a word matches: letters without their accents, in lower case
function fold(s: string): string {
  return s.normalize("NFD").replace(/\p{M}+/gu, "").toLocaleLowerCase(lang());
}

function plural(n: number): Intl.LDMLPluralRule {
  try {
    return new Intl.PluralRules(lang()).select(n);
  } catch {
    return n === 1 ? "one" : "other";
  }
}

const num = (n: number): string => n.toLocaleString(lang());

function showCount(shownRows = rows.length, filtered = false): void {
  count.textContent = filtered
    ? t("zoom.rowsOf", { n: num(shownRows), total: num(rows.length) })
    : t(plural(rows.length) === "one" ? "zoom.rowsOne" : "zoom.rows", { n: num(rows.length) });
}

function applyFilter(): void {
  clearTimeout(filterTimer);
  if (!shown || !empty) return;
  const words = fold(input.value).split(/\s+/).filter(Boolean);
  if (words.length && !locked) lockWidths();
  let left = 0;
  rows.forEach((r, i) => {
    const keep = words.every((w) => texts[i].includes(w));
    if (r.hidden === keep) r.hidden = !keep;
    if (keep) left++;
  });
  if (!words.length && locked) unlockWidths();
  showCount(left, words.length > 0);
  empty.hidden = left > 0 || !words.length;
  empty.textContent = t("zoom.noRows", { q: input.value.trim() });
  highlight(words);
  refreeze();
}

// While the filter hides rows, the columns keep the widths they had with all
// of them: the table does not jump about with every letter typed.
function lockWidths(): void {
  // a table with columns of its own keeps them
  if (!shown || shown.querySelector(":scope > colgroup, :scope > col")) return;
  const n = Math.max(0, ...[...shown.rows].map((r) => r.cells.length));
  const model = [...shown.rows].find((r) => r.cells.length === n && [...r.cells].every((c) => c.colSpan === 1));
  if (!model) return;
  // in the sheet's own px, which its zoom then scales like everything else
  const widths = [...model.cells].map((c) => c.getBoundingClientRect().width / zoom);
  const cols = document.createElement("colgroup");
  cols.className = "zt-lock";
  for (const w of widths) {
    const col = document.createElement("col");
    col.style.width = `${w}px`;
    cols.append(col);
  }
  shown.style.width = `${shown.getBoundingClientRect().width / zoom}px`;
  shown.style.tableLayout = "fixed";
  if (shown.caption) shown.caption.after(cols);
  else shown.prepend(cols);
  locked = true;
}

function unlockWidths(): void {
  shown?.querySelector(":scope > colgroup.zt-lock")?.remove();
  shown?.style.removeProperty("width");
  shown?.style.removeProperty("table-layout");
  if (shown?.getAttribute("style") === "") shown.removeAttribute("style");
  locked = false;
}

// every match of every word in the rows left, as one highlight
function highlight(words: string[]): void {
  const hl = CSS.highlights;
  if (!hl) return;
  if (!words.length) {
    hl.delete("table-filter");
    return;
  }
  const ranges: Range[] = [];
  for (const row of rows) {
    if (row.hidden) continue;
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.nodeValue ?? "";
      // the folded text, and for each of its characters where it came from
      let folded = "";
      const from: number[] = [];
      for (let i = 0; i < text.length; ) {
        const ch = String.fromCodePoint(text.codePointAt(i) ?? 0);
        const f = fold(ch);
        for (let k = 0; k < f.length; k++) from.push(i);
        folded += f;
        i += ch.length;
      }
      from.push(text.length);
      for (const w of words) {
        for (let at = folded.indexOf(w); at >= 0; at = folded.indexOf(w, at + w.length)) {
          const r = new Range();
          r.setStart(n, from[at]);
          r.setEnd(n, from[at + w.length] ?? text.length);
          ranges.push(r);
        }
      }
    }
  }
  hl.set("table-filter", new Highlight(...ranges));
}

/* ---- sort ---- */

type Key = number | string | null;

// The header cells that sort a column: in the header's last row (or above,
// for a cell spanning the rows below it) the one cell over each column, when
// it is over that column alone. Not for a body whose cells span rows or
// columns, which reordering would tear apart.
function makeSortable(table: HTMLTableElement): boolean {
  const head = table.tHead;
  if (!head || head.rows.length === 0 || table.tBodies.length !== 1 || rows.length < 2) return false;
  if (rows.some((r) => [...r.cells].some((c) => c.colSpan > 1 || c.rowSpan > 1))) return false;
  // the header's grid: which cell covers each column, row by row
  const grid: (HTMLTableCellElement | null)[][] = [];
  [...head.rows].forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of row.cells) {
      while (grid[r][c]) c++;
      for (let dr = 0; dr < cell.rowSpan && r + dr < head.rows.length; dr++) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cell.colSpan; dc++) grid[r + dr][c + dc] = cell;
      }
      c += cell.colSpan;
    }
  });
  const last = grid[grid.length - 1] ?? [];
  let any = false;
  last.forEach((cell, col) => {
    if (!cell || cell.colSpan !== 1 || cell.dataset.col !== undefined) return;
    // a header with a link or a control of its own keeps its own clicks
    if (cell.querySelector("a, button, input, select, textarea")) return;
    cell.dataset.col = String(col);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "zt-sort";
    button.title = t("zoom.sortHint");
    button.append(...cell.childNodes);
    const arrow = document.createElement("span");
    arrow.className = "zt-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.innerHTML =
      '<svg viewBox="0 0 10 14" width="9" height="13" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path class="zt-up" d="M1.5 5.5 5 2l3.5 3.5"/>' +
      '<path class="zt-down" d="M1.5 8.5 5 12l3.5-3.5"/></svg>';
    button.append(arrow);
    cell.append(button);
    any = true;
  });
  return any;
}

/** Up, down, and back to the document's order, one column at a time. */
function sortBy(col: number): void {
  if (!shown || !sortable) return;
  const dir: 1 | -1 | 0 = !sort || sort.col !== col ? 1 : sort.dir === 1 ? -1 : 0;
  sort = dir === 0 ? null : { col, dir };
  let order = rows;
  if (dir !== 0) {
    let k = keys.get(col);
    if (!k) {
      k = columnKeys(col);
      keys.set(col, k);
    }
    const ks = k;
    const collator = new Intl.Collator(lang(), { numeric: true, sensitivity: "base" });
    const idx = rows.map((_, i) => i);
    idx.sort((a, b) => {
      const x = ks[a];
      const y = ks[b];
      // empty cells at the bottom either way, then words after numbers
      if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
      if (typeof x !== typeof y) return typeof x === "number" ? -1 : 1;
      const c = typeof x === "number" ? x - (y as number) : collator.compare(x, y as string);
      return c * dir;
    });
    order = idx.map((i) => rows[i]);
  }
  shown.tBodies[0].append(...order);
  for (const th of shown.querySelectorAll<HTMLElement>("th[data-col]")) {
    const on = sort !== null && Number(th.dataset.col) === sort.col;
    if (on && sort) th.setAttribute("aria-sort", sort.dir === 1 ? "ascending" : "descending");
    else th.removeAttribute("aria-sort");
  }
  // the moves collapsed the highlight's ranges: find them again
  highlight(fold(input.value).split(/\s+/).filter(Boolean));
}

const cellText = (row: HTMLTableRowElement, col: number): string =>
  (row.cells[col]?.textContent ?? "").replace(/\s+/g, " ").trim();

// A column reads as numbers, or as dates, when at least 4 in 5 of its
// filled cells do; otherwise as text.
function columnKeys(col: number): Key[] {
  const raw = rows.map((r) => cellText(r, col));
  const filled = raw.filter(Boolean);
  const need = Math.max(1, Math.ceil(filled.length * 0.8));
  const dec = decimalMark(filled);
  const asNum = raw.map((s) => (s ? toNumber(s, dec) : null));
  if (asNum.filter((v) => v !== null).length >= need) return raw.map((s, i) => (s ? (asNum[i] ?? s) : null));
  const order = dateOrder(filled);
  const asDate = raw.map((s) => (s ? toDate(s, order) : null));
  if (asDate.filter((v) => v !== null).length >= need) return raw.map((s, i) => (s ? (asDate[i] ?? s) : null));
  return raw.map((s) => s || null);
}

// what is left of a number once its currency, percent sign, short unit and
// spaces (thousands in French) are off
function bare(s: string): string {
  return s
    .replace(/[\s  ]/g, "")
    .replace(/^[€$£¥]|[€$£¥]$/g, "")
    .replace(/%$/, "")
    .replace(/(?<=\d)[a-zA-Z]{1,3}$/, "")
    .replace(/^[−–]/, "-");
}

// The column's decimal mark, from the cells that say it without doubt
// (1.234,56 and 12,5 say comma; 1,234.56 and 12.5 say point); none of them
// does: the app's language decides.
function decimalMark(cells: string[]): "," | "." {
  let comma = 0;
  let point = 0;
  for (const c of cells) {
    const s = bare(c);
    if (!/^[+-]?\d[\d.,]*$/.test(s)) continue;
    const lastC = s.lastIndexOf(",");
    const lastP = s.lastIndexOf(".");
    if (lastC >= 0 && lastP >= 0) {
      if (lastC > lastP) comma++;
      else point++;
    } else if (lastC >= 0 && !/^[+-]?\d{1,3}(,\d{3})+$/.test(s)) comma++;
    else if (lastP >= 0 && !/^[+-]?\d{1,3}(\.\d{3})+$/.test(s)) point++;
  }
  if (comma !== point) return comma > point ? "," : ".";
  return lang() === "en" || lang() === "zh-CN" ? "." : ",";
}

function toNumber(s: string, dec: "," | "."): number | null {
  const b = bare(s);
  const thousands = dec === "," ? "." : ",";
  const re = dec === "," ? /^[+-]?(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/ : /^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
  if (!re.test(b)) return null;
  const v = Number(b.split(thousands).join("").replace(dec, "."));
  return Number.isFinite(v) ? v : null;
}

// day before month, unless a cell proves otherwise (a first number over 12
// is a day, a second one a month's day) or the language is American English
function dateOrder(cells: string[]): "dmy" | "mdy" {
  let dmy = 0;
  let mdy = 0;
  for (const c of cells) {
    const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(c);
    if (!m) continue;
    if (Number(m[1]) > 12) dmy++;
    else if (Number(m[2]) > 12) mdy++;
  }
  if (dmy !== mdy) return dmy > mdy ? "dmy" : "mdy";
  return navigator.language === "en-US" && lang() === "en" ? "mdy" : "dmy";
}

function toDate(s: string, order: "dmy" | "mdy"): number | null {
  let y: number;
  let m: number;
  let d: number;
  let iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?$/.exec(s);
  if (iso) {
    [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  } else {
    iso = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/.exec(s);
    if (!iso) return null;
    const a = Number(iso[1]);
    const b = Number(iso[2]);
    [d, m] = order === "dmy" ? [a, b] : [b, a];
    y = Number(iso[3]);
    if (iso[3].length === 2) y += y < 70 ? 2000 : 1900;
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return Date.UTC(y, m - 1, d);
}
