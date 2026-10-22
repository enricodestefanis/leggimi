// Content too wide for the reading column leaves it. A table or a Mermaid
// diagram at the top level of the document that cannot fit the column gets
// the class `wide` and its natural width in `--tw`; markdown.css then widens
// it to that width, at most the pane's less the column's side padding,
// centred on the pane. A wide table is read whole instead of through a
// scroller, and a big diagram is drawn at its own size instead of shrunk.
//
// A table qualifies only when even its narrowest layout (min-content) does
// not fit: a prose table that can wrap keeps wrapping inside the column. Only
// direct children of the article break out: one inside a list, a quote or a
// callout keeps its scroller, as leaving the column would mean crossing that
// box's own edge. Screen only: print.css puts them back (preparePrint scales
// the tables that paper is too narrow for) and exports strip both marks.

let article: HTMLElement | null = null;
let pane: HTMLElement | null = null;
let raf = 0;

interface Widths {
  /** the table's narrowest layout, in px */
  min: number;
  /** its layout with no line wrapped */
  max: number;
}

// A table's intrinsic widths depend on its text and fonts, never on the
// column: they are kept per table so that a window resize does not lay every
// wide table out twice more per frame. A change of reader font or size starts
// over (fontKey), and so do late images and fonts (init).
let widths = new WeakMap<HTMLTableElement, Widths>();
let fontKey = "";

// A4 portrait less print.css's 16 mm side margins, in CSS px: the paper of
// Save as PDF (commands.rs), and the narrower of the usual print dialog ones
const PRINT_WIDTH = ((210 - 2 * 16) / 25.4) * 96;
// tables are never printed smaller than this (5 pt text from 16 px)
const PRINT_ZOOM_FLOOR = 0.3;

export function init(opts: { article: HTMLElement; pane: HTMLElement }): void {
  article = opts.article;
  pane = opts.pane;
  // the pane: the window, a side pane or edit mode changed its width; the
  // article: the column width setting, the text size, content reflowing
  const ro = new ResizeObserver(() => schedule());
  ro.observe(opts.pane);
  ro.observe(opts.article);
  // an image that arrives late widens its table (load does not bubble)
  opts.article.addEventListener(
    "load",
    (e) => {
      const table = (e.target as Element | null)?.closest?.("table");
      if (table) widths.delete(table);
      schedule();
    },
    true,
  );
  // a font arriving late (KaTeX's, in a table cell) changes every width
  document.fonts.addEventListener("loadingdone", () => {
    widths = new WeakMap();
    schedule();
  });
}

function schedule(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (article) markWide(article);
  });
}

interface Plan {
  el: HTMLElement;
  /** the natural width in px, or null: the block stays in the column */
  tw: number | null;
}

interface TableJob {
  el: HTMLElement;
  table: HTMLTableElement;
  /** the scroller's borders */
  frame: number;
  min?: number;
  max?: number;
}

/**
 * Marks the blocks of `root` (the article) that do not fit its column, and
 * unmarks those that fit again. Idempotent and cheap when nothing changed:
 * call it after every render, live-preview update and Mermaid pass.
 */
export function markWide(root: HTMLElement): void {
  const host = pane ?? root.parentElement;
  if (!host || !root.isConnected) return;

  /* ---- reads ---- */
  const blocks = [...root.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el.matches(".table-block, .mermaid-diagram"),
  );
  const outer = root.clientWidth;
  if (outer === 0 || host.clientWidth === 0) return; // hidden: nothing to measure
  const cs = getComputedStyle(root);
  const pad = parseFloat(cs.paddingLeft) || 0;
  const column = outer - pad - (parseFloat(cs.paddingRight) || 0);
  // what markdown.css allows: 100cqi (the pane's width, its scrollbar gutter
  // being stable) less the column's padding on both sides; none at all when
  // the column already fills the pane (a narrow pane, the Full width)
  const room = host.clientWidth - 2 * pad;
  const canLeave = room > column + 1;
  const key = `${cs.fontSize}|${cs.fontFamily}`;
  if (key !== fontKey) {
    fontKey = key;
    widths = new WeakMap();
  }

  const plans: Plan[] = [];
  const jobs: TableJob[] = [];
  for (const el of blocks) {
    if (!canLeave) {
      plans.push({ el, tw: null });
      continue;
    }
    if (el.classList.contains("mermaid-diagram")) {
      const svg = el.querySelector<SVGSVGElement>(":scope > svg");
      const w = svg ? naturalWidth(svg) : 0;
      plans.push({ el, tw: w > column + 0.5 ? w : null });
      continue;
    }
    const scroll = el.querySelector<HTMLElement>(":scope > .table-scroll");
    const table = scroll?.querySelector<HTMLTableElement>(":scope > table");
    if (!scroll || !table) {
      plans.push({ el, tw: null });
      continue;
    }
    const job: TableJob = { el, table, frame: scroll.offsetWidth - scroll.clientWidth, ...widths.get(table) };
    if (!el.classList.contains("wide")) {
      // In the column a table is as wide as the column, or as its
      // min-content when that is wider: an overflow gives it for free.
      const w = table.getBoundingClientRect().width;
      if (w <= scroll.clientWidth + 0.5) {
        plans.push({ el, tw: null });
        continue;
      }
      job.min = w;
    }
    jobs.push(job);
  }

  // The widths not known yet, each kind in one batch: the measuring class
  // goes on, one layout gives all the readings, the class comes off. Nothing
  // is painted in between.
  measure(
    jobs.filter((j) => j.min === undefined),
    "measure-min",
    (j, w) => (j.min = w),
  );
  measure(
    jobs.filter((j) => j.max === undefined),
    "measure-max",
    (j, w) => (j.max = w),
  );
  for (const j of jobs) {
    const min = j.min ?? 0;
    const max = Math.max(j.max ?? 0, min);
    widths.set(j.table, { min, max });
    plans.push({ el: j.el, tw: min + j.frame > column + 0.5 ? max + j.frame : null });
  }

  /* ---- writes ---- */
  for (const { el, tw } of plans) {
    if (tw === null) {
      if (el.classList.contains("wide")) el.classList.remove("wide");
      if (el.style.getPropertyValue("--tw")) el.style.removeProperty("--tw");
      if (el.getAttribute("style") === "") el.removeAttribute("style");
      continue;
    }
    const value = `${Math.ceil(tw)}px`;
    if (!el.classList.contains("wide")) el.classList.add("wide");
    if (el.style.getPropertyValue("--tw") !== value) el.style.setProperty("--tw", value);
  }
}

function measure(jobs: TableJob[], cls: string, set: (j: TableJob, w: number) => void): void {
  if (jobs.length === 0) return;
  for (const j of jobs) j.el.classList.add(cls);
  for (const j of jobs) set(j, j.table.getBoundingClientRect().width);
  for (const j of jobs) j.el.classList.remove(cls);
}

// Mermaid draws at 100% of its box, capped by an inline max-width that is the
// diagram's own width (useMaxWidth); without one, a fixed width attribute or
// the viewBox says it.
function naturalWidth(svg: SVGSVGElement): number {
  const capped = svg.style.maxWidth;
  if (capped.endsWith("px")) return parseFloat(capped) || 0;
  const attr = svg.getAttribute("width")?.trim() ?? "";
  if (/^\d+(\.\d+)?(px)?$/.test(attr)) return parseFloat(attr);
  const box = svg.viewBox?.baseVal;
  return box && box.width > 0 ? box.width : 0;
}

/**
 * Before printing or saving a PDF: tables wider than the paper (measured with
 * the paper's text settings, header cells wrapping) get `--print-zoom`, which
 * print.css applies as CSS zoom so that they fit instead of being cut at the
 * page edge. Returns the undo, for after the print.
 */
export function preparePrint(root: HTMLElement): () => void {
  // a table inside another table's cell scales with that one
  const blocks = [...root.querySelectorAll<HTMLElement>(".table-block")].filter(
    (b) => !b.parentElement?.closest("table"),
  );
  if (blocks.length === 0 || !root.isConnected) return () => {};
  const html = document.documentElement;
  html.classList.add("print-measure");
  const r = root.getBoundingClientRect();
  const cs = getComputedStyle(root);
  const left = r.left + (parseFloat(cs.paddingLeft) || 0);
  const right = r.right - (parseFloat(cs.paddingRight) || 0);
  const measure = (b: HTMLElement): number => {
    const scroll = b.querySelector<HTMLElement>(":scope > .table-scroll");
    const table = scroll?.querySelector<HTMLTableElement>(":scope > table");
    if (!scroll || !table) return 1;
    const br = b.getBoundingClientRect();
    // the indentation of a table in a list or a callout is the same on paper
    const inset = Math.max(0, br.left - left) + Math.max(0, right - br.right);
    const min = table.getBoundingClientRect().width; // print-measure: min-content
    const avail = PRINT_WIDTH - inset - (scroll.offsetWidth - scroll.clientWidth);
    return min > avail ? avail / min : 1;
  };
  const zooms = blocks.map(measure);
  // Below the smallest legible scale a table would still be cut: its cells
  // may then break their long words, which narrows it, and it is measured
  // again (all marked first, so the layout is redone once).
  const broken = blocks.filter((_, i) => zooms[i] < PRINT_ZOOM_FLOOR);
  for (const b of broken) b.classList.add("print-break");
  for (const b of broken) zooms[blocks.indexOf(b)] = measure(b);
  html.classList.remove("print-measure");
  const zoomed: HTMLElement[] = [];
  blocks.forEach((b, i) => {
    // a hair under the exact ratio, so that rounding never tips it over the edge
    if (zooms[i] < 1) {
      const zoom = Math.max(PRINT_ZOOM_FLOOR, zooms[i]);
      b.style.setProperty("--print-zoom", (Math.floor(zoom * 1000) / 1000 - 0.002).toFixed(3));
      zoomed.push(b);
    }
  });
  return () => {
    for (const b of broken) b.classList.remove("print-break");
    for (const b of zoomed) {
      b.style.removeProperty("--print-zoom");
      if (b.getAttribute("style") === "") b.removeAttribute("style");
    }
  };
}
