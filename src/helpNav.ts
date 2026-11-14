// The help's sections and search (2.4). The help was one long column with the
// Store rating at its end; now its own headings (<h3>, in each language's
// page) become a list of sections beside the text, the one being read
// lit up, and a search narrows the text to the sections that hold the
// words, marks them, and steps through them (Enter, Shift+Enter, F3, the
// arrows beside the field), as Find does on the page.

import { fmtNumber, t } from "./i18n";
import { countWords } from "./search";

interface HelpEls {
  dialog: HTMLDialogElement;
  /** the help's text, as loaded (i18n.loadHelp) */
  text: HTMLElement;
  /** the text's scroll container */
  body: HTMLElement;
  toc: HTMLElement;
  search: HTMLInputElement;
  count: HTMLElement;
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
  none: HTMLElement;
  about: HTMLElement;
  /** speaks a status message to screen readers (notices.announce) */
  say?: (text: string) => void;
}

let els: HelpEls;
let intro: HTMLElement | null = null;
let sections: HTMLElement[] = [];
let items: HTMLButtonElement[] = [];
let ranges: Range[] = [];
let idx = -1;
let typingTimer = 0;
let sayTimer = 0;

/** Accents and case set aside: "perche" finds "Perché". One string per character of the text. */
const foldChar = (ch: string): string => ch.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

export function init(elements: HelpEls): void {
  els = elements;
  els.search.addEventListener("input", () => {
    clearTimeout(typingTimer);
    typingTimer = window.setTimeout(run, 120);
  });
  els.search.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === "F3") {
      e.preventDefault();
      if (typingTimer) run();
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === "ArrowDown" && !e.altKey) {
      // into the list of sections
      const first = items.find((i) => !i.hidden);
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  els.prev.addEventListener("click", () => step(-1));
  els.next.addEventListener("click", () => step(1));
  // Esc with words in the field empties it first; the next Esc closes the help
  els.dialog.addEventListener("cancel", (e) => {
    if (!els.search.value) return;
    e.preventDefault();
    els.search.value = "";
    run();
    els.search.focus();
  });
  els.dialog.addEventListener("keydown", (e) => {
    if ((e.ctrlKey && !e.altKey && e.key.toLowerCase() === "f") || (e.key === "F3" && e.target !== els.search)) {
      e.preventDefault();
      if (e.key === "F3" && ranges.length) step(e.shiftKey ? -1 : 1);
      else {
        els.search.focus();
        els.search.select();
      }
    }
  });
  els.toc.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const shown = items.filter((i) => !i.hidden);
    const at = shown.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) els.search.focus();
    else shown[Math.max(0, Math.min(shown.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))].focus();
  });
  els.body.addEventListener("scroll", spy, { passive: true });
}

/**
 * The text just loaded (or already there): its headings become sections and
 * the list beside it, once per page of text.
 */
export function prepare(): void {
  if (els.text.dataset.sections !== "1") {
    els.text.dataset.sections = "1";
    wrap();
  }
  spy();
}

/** The help opened (laid out now): the section in sight lit up, the field ready for a search. */
export function focusSearch(): void {
  spy();
  els.search.focus();
  els.search.select();
}

function wrap(): void {
  const nodes = [...els.text.childNodes];
  intro = document.createElement("div");
  intro.className = "help-intro";
  sections = [];
  let into: HTMLElement = intro;
  const used = new Set<string>();
  for (const node of nodes) {
    if (node instanceof HTMLHeadingElement && node.tagName === "H3") {
      into = document.createElement("section");
      into.className = "help-sec";
      const base = "help-" + (node.textContent ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
      let id = base;
      for (let n = 1; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      into.id = id;
      into.setAttribute("aria-labelledby", `${id}-h`);
      node.id = `${id}-h`;
      sections.push(into);
    }
    into.append(node);
  }
  els.text.replaceChildren(intro, ...sections);
  items = sections.map((sec) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "help-toc-item";
    b.dataset.target = sec.id;
    b.append(sec.querySelector("h3")?.textContent ?? "");
    b.addEventListener("click", () => go(sec));
    return b;
  });
  els.toc.replaceChildren(...items);
}

// a jump, not a glide: across a long help a smooth scroll lights up every
// section on its way and lands late
function go(sec: HTMLElement): void {
  const top = sec.getBoundingClientRect().top - els.body.getBoundingClientRect().top + els.body.scrollTop - 6;
  els.body.scrollTo({ top, behavior: "instant" });
  mark(sec.id);
}

function mark(id: string | null): void {
  for (const item of items) item.classList.toggle("active", item.dataset.target === id);
}

// the section being read: the last one whose heading is above the top of the text, near it
function spy(): void {
  const top = els.body.getBoundingClientRect().top + 40;
  let current: string | null = null;
  for (const sec of sections) {
    if (sec.hidden) continue;
    if (sec.getBoundingClientRect().top <= top || !current) current = sec.id;
    else break;
  }
  // scrolled to the bottom, the last section is the one being read, however short
  if (els.body.scrollTop > 0 && els.body.scrollTop + els.body.clientHeight >= els.body.scrollHeight - 2) {
    const last = [...sections].reverse().find((s) => !s.hidden);
    if (last) current = last.id;
  }
  mark(current);
}

// every match of `q` (folded) in the text nodes under `root`
function collect(root: HTMLElement, q: string): Range[] {
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const text = node.data;
    let folded = "";
    const at: number[] = [];
    let offset = 0;
    for (const ch of text) {
      const f = foldChar(ch);
      for (let k = 0; k < f.length; k++) at.push(offset);
      folded += f;
      offset += ch.length;
    }
    at.push(text.length);
    for (let i = folded.indexOf(q); i >= 0; i = folded.indexOf(q, i + q.length)) {
      const r = document.createRange();
      r.setStart(node, at[i]);
      r.setEnd(node, at[i + q.length] ?? text.length);
      out.push(r);
    }
  }
  return out;
}

function run(): void {
  clearTimeout(typingTimer);
  typingTimer = 0;
  const raw = els.search.value.trim();
  const q = [...raw].map(foldChar).join("");
  ranges = [];
  if (!q) {
    if (intro) intro.hidden = false;
    for (const sec of sections) sec.hidden = false;
    for (const item of items) {
      item.hidden = false;
      item.querySelector(".help-toc-n")?.remove();
    }
    els.none.hidden = true;
  } else {
    if (intro) {
      const found = collect(intro, q);
      intro.hidden = !found.length;
      ranges.push(...found);
    }
    sections.forEach((sec, i) => {
      const found = collect(sec, q);
      sec.hidden = !found.length;
      items[i].hidden = !found.length;
      let n = items[i].querySelector<HTMLElement>(".help-toc-n");
      if (!n) {
        n = document.createElement("span");
        n.className = "help-toc-n";
        n.setAttribute("aria-hidden", "true");
        items[i].prepend(n);
      }
      n.textContent = fmtNumber(found.length);
      ranges.push(...found);
    });
    els.none.hidden = ranges.length > 0;
    els.none.textContent = ranges.length ? "" : t("help.noResults", { q: raw });
  }
  idx = ranges.length ? 0 : -1;
  paint();
  if (idx >= 0) reveal();
  else els.body.scrollTop = 0;
  // the count reaches a screen reader once typing pauses, as Find's does
  clearTimeout(sayTimer);
  if (q) sayTimer = window.setTimeout(() => els.say?.(countWords(ranges.length)), 300);
  spy();
}

function step(dir: 1 | -1): void {
  if (!ranges.length) return;
  idx = (idx + dir + ranges.length) % ranges.length;
  paint();
  reveal();
}

function paint(): void {
  const has = ranges.length > 0;
  els.count.textContent = has ? `${fmtNumber(idx + 1)}/${fmtNumber(ranges.length)}` : "";
  els.prev.disabled = els.next.disabled = !has;
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  if (has) {
    CSS.highlights.set("help-find", new Highlight(...ranges));
    CSS.highlights.set("help-find-current", new Highlight(ranges[idx]));
  } else {
    CSS.highlights.delete("help-find");
    CSS.highlights.delete("help-find-current");
  }
}

// the current match a third of the way down the text
function reveal(): void {
  const r = ranges[idx]?.getBoundingClientRect();
  if (!r) return;
  const box = els.body.getBoundingClientRect();
  if (r.top >= box.top + 24 && r.bottom <= box.bottom - 24) return;
  els.body.scrollTo({ top: els.body.scrollTop + r.top - box.top - box.height / 3, behavior: "instant" });
}

/** The help closed: the search starts over next time, and its marks go. */
export function closed(): void {
  clearTimeout(sayTimer);
  if (els.search.value) {
    els.search.value = "";
    run();
  }
  paint();
}

/** Licence and source code: the paragraph at the end of the text. */
export function showAbout(): void {
  els.about.scrollIntoView({ block: "center", behavior: "instant" });
}
