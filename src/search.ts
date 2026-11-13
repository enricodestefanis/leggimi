import { fmtNumber, t } from "./i18n";

interface SearchEls {
  root: HTMLElement; // the article to search in
  pane: HTMLElement; // the scroll container
  bar: HTMLElement;
  /** the notice bar, which floats at the top of the pane too (beside the find bar, or under it) */
  notice?: HTMLElement;
  input: HTMLInputElement;
  counter: HTMLElement;
  btnPrev: HTMLButtonElement;
  btnNext: HTMLButtonElement;
  btnClose: HTMLButtonElement;
  /** speaks a status message to screen readers (notices.announce) */
  say?: (text: string) => void;
}

let els: SearchEls;
let ranges: Range[] = [];
let idx = -1;
let sayTimer = 0;

/** How many matches, in words: "No matches", "1 result", "12 results". */
export function countWords(n: number): string {
  return n === 0 ? t("pane.noMatches") : n === 1 ? t("pal.countOne") : t("pal.count", { n: fmtNumber(n) });
}

// The count reaches a screen reader once typing pauses (WCAG 4.1.3), as the
// palette does: not at every key, and not when a reload of the file recounts.
function sayCountSoon(): void {
  clearTimeout(sayTimer);
  sayTimer = window.setTimeout(() => {
    if (!els.bar.hidden && els.input.value) els.say?.(countWords(ranges.length));
  }, 300);
}

export function init(elements: SearchEls): void {
  els = elements;
  els.input.addEventListener("input", () => {
    refresh();
    sayCountSoon();
  });
  els.input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  });
  els.btnNext.addEventListener("click", () => step(1));
  els.btnPrev.addEventListener("click", () => step(-1));
  els.btnClose.addEventListener("click", close);
}

export function open(): void {
  els.bar.hidden = false;
  els.input.focus();
  els.input.select();
  refresh();
}

// open the find bar pre-filled, e.g. to carry a folder-search query into
// the freshly opened document
export function openWith(query: string): void {
  els.input.value = query;
  open();
}

export function close(): void {
  clearTimeout(sayTimer);
  els.bar.hidden = true;
  ranges = [];
  idx = -1;
  paint();
}

/** The find bar of the tab in front, for it to take along when another comes forward. */
export function state(): { open: boolean; query: string } {
  return { open: !!els && !els.bar.hidden, query: els?.input.value ?? "" };
}

/** A tab's find bar comes back as it was, matches marked, without moving the page or the focus. */
export function restore(s: { open: boolean; query: string } | null): void {
  if (!els) return;
  if (!s?.open) {
    close();
    return;
  }
  els.input.value = s.query;
  els.bar.hidden = false;
  ranges = collect(s.query);
  idx = ranges.length > 0 ? 0 : -1;
  paint();
}

export function onContentChanged(): void {
  if (els && !els.bar.hidden) refresh();
}

function refresh(): void {
  ranges = collect(els.input.value);
  idx = ranges.length > 0 ? 0 : -1;
  paint();
  scrollToCurrent();
}

export function hasMatches(): boolean {
  return ranges.length > 0;
}

// n / N from the document step through the matches of the open find bar
export function step(dir: 1 | -1): void {
  if (ranges.length === 0) return;
  idx = (idx + dir + ranges.length) % ranges.length;
  paint();
  scrollToCurrent();
}

function collect(query: string): Range[] {
  const out: Range[] = [];
  const q = query.toLowerCase();
  if (!q) return out;
  const walker = document.createTreeWalker(els.root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const lower = (node.textContent ?? "").toLowerCase();
    let i = 0;
    while ((i = lower.indexOf(q, i)) !== -1) {
      const r = new Range();
      r.setStart(node, i);
      r.setEnd(node, i + q.length);
      out.push(r);
      i += q.length;
    }
  }
  return out;
}

// CSS Custom Highlight API: no DOM mutation, so mermaid SVGs and
// copy-button wiring survive highlighting.
function paint(): void {
  CSS.highlights.delete("find");
  CSS.highlights.delete("find-current");
  if (ranges.length > 0) {
    CSS.highlights.set("find", new Highlight(...ranges));
    if (idx >= 0) CSS.highlights.set("find-current", new Highlight(ranges[idx]));
  }
  if (!els) return;
  // nothing typed: no count; typed but absent: say so in words, not "0/0"
  const none = ranges.length === 0 && !!els.input.value && !els.bar.hidden;
  els.counter.textContent = ranges.length > 0 ? `${idx + 1}/${ranges.length}` : none ? t("pane.noMatches") : "";
  els.counter.classList.toggle("none", none);
}

function scrollToCurrent(): void {
  if (idx < 0) return;
  revealSideways(ranges[idx]);
  const r = ranges[idx].getBoundingClientRect();
  const p = els.pane.getBoundingClientRect();
  // the band at the top the bars float over: 60px with the find bar at its
  // usual 10px, more when they reach lower (under the section's path, or the
  // notice under the find bar: ui.css, bars.ts): 8px below the lowest of them
  let low = els.bar.getBoundingClientRect().bottom;
  if (els.notice && els.notice.offsetWidth > 0) low = Math.max(low, els.notice.getBoundingClientRect().bottom);
  const band = Math.max(60, low - p.top + 8);
  if (r.top < p.top + band || r.bottom > p.bottom - 60) {
    els.pane.scrollBy({ top: r.top - p.top - p.height / 2 });
  }
}

// A match in a part of a box that scrolls sideways (a wide table, a long
// code line) may sit out of sight to the left or right: that box scrolls it
// to its middle first, as the pane then does up and down.
function revealSideways(range: Range): void {
  const margin = 40;
  for (let el = range.startContainer.parentElement; el && el !== els.pane; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    const ov = getComputedStyle(el).overflowX;
    if (ov !== "auto" && ov !== "scroll") continue;
    const r = range.getBoundingClientRect();
    const left = el.getBoundingClientRect().left + el.clientLeft;
    if (r.left < left + margin || r.right > left + el.clientWidth - margin) {
      el.scrollLeft += r.left - left - (el.clientWidth - r.width) / 2;
    }
  }
}
