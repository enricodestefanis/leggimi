// How a table scrolls. Its box (.table-scroll, renderer.ts) is a sideways
// scroller, and position: sticky follows the nearest scroller: a header row
// told to stick would stick to that box, which never scrolls up or down. So a
// table that fits its box gets `fits`, and markdown.css clips the box instead
// of scrolling it: with no scroller in between, the header row sticks to the
// top of the pane while the rows go by, and leaves with the last one.
//
// A table still wider than its box keeps scrolling sideways. Its scrollbar
// sits under the last row, out of reach while the table is being read: the
// block gets `hscroll`, and a stand-in (.table-hbar) takes the scrollbar's
// place, sticks to the bottom of the pane while the table goes on below it,
// and scrolls in step with the table.
//
// Its header cannot stick (the box in between scrolls), so it is moved
// instead: markdown.css slides it down its table as the box crosses the top
// of the pane, an animation driven by the pane's scrolling (a view timeline,
// run by the compositor in step with it). It stays inside the box, so it
// scrolls sideways with its columns. What the animation cannot know is
// measured here: where the header starts, how far it can go.
//
// A table inside another table's cell keeps its plain scroller: its header
// would stick over the outer table's. Screen only: print.css hides the bar,
// and exports drop it and both marks (share.ts).

type Mode = "fits" | "hscroll" | null;

/**
 * Marks the tables of `root` (the article) that fit their box, and gives the
 * others their bar. Runs at the end of wide.markWide, once the blocks that
 * leave the column have their width: after every render, live-preview update
 * and Mermaid pass, and whenever the pane, the column or a table's content
 * changes size.
 */
export function update(root: HTMLElement): void {
  /* ---- reads ---- */
  const jobs: { block: HTMLElement; scroll: HTMLElement; mode: Mode }[] = [];
  for (const scroll of root.querySelectorAll<HTMLElement>(".table-block > .table-scroll")) {
    const block = scroll.parentElement as HTMLElement;
    const table = scroll.querySelector<HTMLTableElement>(":scope > table");
    let mode: Mode = null;
    if (table && !block.parentElement?.closest("table")) {
      // a pixel's slack: rounding, and the box would clip no more than that
      mode = table.getBoundingClientRect().width <= scroll.clientWidth + 1 ? "fits" : "hscroll";
    }
    jobs.push({ block, scroll, mode });
  }

  /* ---- writes ---- */
  const bars: { scroll: HTMLElement; rail: HTMLElement; track: HTMLElement }[] = [];
  for (const { block, scroll, mode } of jobs) {
    if (scroll.classList.contains("fits") !== (mode === "fits")) scroll.classList.toggle("fits");
    if (block.classList.contains("hscroll") !== (mode === "hscroll")) block.classList.toggle("hscroll");
    let bar = block.querySelector<HTMLElement>(":scope > .table-hbar");
    if (mode !== "hscroll") {
      bar?.remove();
      setHead(scroll, null);
      continue;
    }
    if (!bar) {
      bar = makeBar();
      scroll.after(bar);
    }
    const rail = bar.firstElementChild as HTMLElement;
    bars.push({ scroll, rail, track: rail.firstElementChild as HTMLElement });
  }

  // The bar's track as wide as the box's content, read once the box scrolls
  // (a box that has just stopped fitting was clipped until now): the two
  // then scroll exactly as far. A new bar starts at the left, and catches up
  // with a table already scrolled.
  const widths = bars.map(({ scroll }) => `${scroll.scrollWidth}px`);
  // and the header's way down, in the same layout
  const spans = bars.map(({ scroll }) => headSpan(scroll));
  bars.forEach(({ scroll, track }, i) => {
    if (track.style.width !== widths[i]) track.style.width = widths[i];
    setHead(scroll, spans[i]);
  });
  for (const { scroll, rail } of bars) follow(rail, scroll.scrollLeft);
}

interface HeadSpan {
  /** the header's top below the box's top edge (the frame, a caption) */
  from: number;
  /** how far it can go down: from its bottom to the table's */
  travel: number;
  /** the table's bottom below the box's top edge, where it has gone by */
  end: number;
}

// Read with the header's present shift taken out: its layout box, which the
// animation's translate does not move.
function headSpan(scroll: HTMLElement): HeadSpan | null {
  const table = scroll.querySelector<HTMLTableElement>(":scope > table");
  const head = table?.tHead;
  if (!table || !head) return null;
  const shift = parseFloat(getComputedStyle(head).translate.split(" ")[1] ?? "") || 0;
  const s = scroll.getBoundingClientRect();
  const t = table.getBoundingClientRect();
  const h = head.getBoundingClientRect();
  return {
    from: h.top - shift - s.top,
    travel: Math.max(0, t.bottom - (h.bottom - shift)),
    end: t.bottom - s.top,
  };
}

const px = (v: number): string => `${Math.round(v * 100) / 100}px`;

function setHead(scroll: HTMLElement, span: HeadSpan | null): void {
  for (const [name, v] of [
    ["--head-from", span?.from],
    ["--head-travel", span?.travel],
    ["--head-end", span?.end],
  ] as const) {
    if (v === undefined) {
      if (scroll.style.getPropertyValue(name)) scroll.style.removeProperty(name);
    } else if (scroll.style.getPropertyValue(name) !== px(v)) {
      scroll.style.setProperty(name, px(v));
    }
  }
  if (scroll.getAttribute("style") === "") scroll.removeAttribute("style");
}

function makeBar(): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "table-hbar";
  // a stand-in for the table's own scrollbar, which the keys already move
  bar.setAttribute("aria-hidden", "true");
  const rail = document.createElement("div");
  rail.className = "table-hbar-scroll";
  rail.tabIndex = -1;
  const track = document.createElement("div");
  track.className = "table-hbar-track";
  rail.append(track);
  bar.append(rail);
  return bar;
}

// The position last written to each side, to tell its echo (the scroll event
// the write fires, a frame later) from the reader's own scrolling. Writing
// back on an echo would stop the other side's smooth scroll on its way.
const written = new WeakMap<Element, number>();

function follow(el: HTMLElement, left: number): void {
  if (Math.abs(el.scrollLeft - left) < 1) return;
  const before = el.scrollLeft;
  el.scrollLeft = left;
  // as the browser kept it (clamped to the range): no event when unmoved
  if (el.scrollLeft !== before) written.set(el, el.scrollLeft);
}

function onScroll(e: Event): void {
  const el = e.target;
  if (!(el instanceof HTMLElement)) return;
  let other: HTMLElement | null = null;
  if (el.classList.contains("table-hbar-scroll")) {
    other = el.closest(".table-block")?.querySelector<HTMLElement>(":scope > .table-scroll") ?? null;
  } else if (el.classList.contains("table-scroll") && el.parentElement?.classList.contains("hscroll")) {
    other = el.parentElement.querySelector<HTMLElement>(":scope > .table-hbar > .table-hbar-scroll");
  }
  if (!other) return;
  const echo = written.get(el);
  written.delete(el);
  if (echo !== undefined && Math.abs(el.scrollLeft - echo) < 1) return;
  follow(other, el.scrollLeft);
}

export function init(article: HTMLElement): void {
  // scroll does not bubble, but the capture phase sees every scroller inside
  article.addEventListener("scroll", onScroll, { capture: true, passive: true });
}

/**
 * How much of the pane's top a stuck header would cover over the content at
 * `y` (pane content coordinates, as scrollTop counts them) once `y` is
 * scrolled up there: what a jump to `y` must leave above it, besides its own
 * margin. Over a table's rows, its whole header: scrolled to anywhere inside
 * the table, the header is still all there at the top (it is pushed out only
 * once the table's bottom passes it). Across the header itself it grows from
 * nothing to all of it, so a jump to the table shows the header whole, in its
 * place, with the first row under it.
 *
 * Past the table's bottom nothing is covered any more: the rest of a header
 * on its way out never reaches below the bottom. `after` (the editor's scroll
 * sync) lets the cover fade over one header height there instead, so that a
 * position moving down out of a table moves its scroll target smoothly, not
 * with a jump the height of the header.
 */
export function headCover(pane: HTMLElement, root: HTMLElement, y: number, after = false): number {
  const origin = pane.getBoundingClientRect().top - pane.scrollTop;
  let cover = 0;
  for (const table of root.querySelectorAll<HTMLTableElement>(
    ".table-scroll.fits > table, .table-block.hscroll > .table-scroll > table",
  )) {
    const r = table.getBoundingClientRect();
    const top = r.top - origin;
    if (top >= y) break; // in document order: the rest start further down
    // A table in a closed <details> holds no header anywhere, though asked
    // for its box Chromium lays the hidden content out and answers as if open
    if (!table.tHead || !table.checkVisibility()) continue;
    const head = table.tHead.getBoundingClientRect().height;
    const bottom = r.bottom - origin;
    const c = y < bottom ? Math.min(y - top, head) : after ? head - (y - bottom) : 0;
    if (c > cover) cover = c;
  }
  return cover;
}
