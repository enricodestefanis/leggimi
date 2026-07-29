interface SearchEls {
  root: HTMLElement; // the article to search in
  pane: HTMLElement; // the scroll container
  bar: HTMLElement;
  input: HTMLInputElement;
  counter: HTMLElement;
  btnPrev: HTMLButtonElement;
  btnNext: HTMLButtonElement;
  btnClose: HTMLButtonElement;
}

let els: SearchEls;
let ranges: Range[] = [];
let idx = -1;

export function init(elements: SearchEls): void {
  els = elements;
  els.input.addEventListener("input", refresh);
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

export function close(): void {
  els.bar.hidden = true;
  ranges = [];
  idx = -1;
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

function step(dir: 1 | -1): void {
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
  if (els) els.counter.textContent = ranges.length > 0 ? `${idx + 1}/${ranges.length}` : "0/0";
}

function scrollToCurrent(): void {
  if (idx < 0) return;
  const r = ranges[idx].getBoundingClientRect();
  const p = els.pane.getBoundingClientRect();
  if (r.top < p.top + 60 || r.bottom > p.bottom - 60) {
    els.pane.scrollBy({ top: r.top - p.top - p.height / 2 });
  }
}
