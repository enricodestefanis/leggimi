// The command palette (Ctrl+K, Ctrl+Shift+P): one box that finds the app's
// commands, the headings of the document, the window's other tabs, the files
// of the folder and the recent ones. main.ts loads this module the first time
// the palette opens and hands it what to list through a PaletteHost; the
// palette builds its own <dialog> then. Matching is fuzzy.ts's: no accents,
// no case, the letters of a word in order.
//
// The keys stay inside while it is open: arrows, Page Up/Down and Enter are
// its own, the text box keeps its editing keys, and every other shortcut is
// held back, so nothing acts on the window behind the dialog (and WebView2
// does not print, save or zoom the page). F1 goes through, for main.ts.

import "./styles/palette.css";
import * as fuzzy from "./fuzzy";
import { current as uiLang, fmtNumber, keyLabel, relativeTime, t, type Dict } from "./i18n";
import { isInside } from "./paths";
import { whereFrom, whereFromKeys, type Where } from "./where";

/* ---- what main.ts provides ---- */

export interface PaletteCommand {
  /** stable across versions: the recently used ones are remembered by it */
  id: string;
  label: string;
  /** more words that find it (in the other languages, the English label) */
  keywords?: string;
  /** its shortcut, written the US way ("Ctrl+Shift+E"); shown in the words of the UI */
  keys?: string;
  /** inner SVG markup on a 24×24 stroke grid, or a short glyph ("Aa") */
  icon?: string;
  /** a setting: a ticked box when true, an empty one when false, none when absent */
  checked?: boolean;
  /** "editor": one of the editor's own commands, tagged so */
  group?: "app" | "editor";
  run(): void;
}

export interface PaletteHeading {
  el: HTMLElement;
  text: string;
  /** 1–4 */
  level: number;
  /** the sections it is in, as one line ("Install › Windows"), "" at the top */
  path: string;
  /** the one being read */
  current: boolean;
}

export interface PaletteTab {
  key: string;
  title: string;
  detail: string;
  kind: "file" | "pasted" | "start";
  activate(): void;
}

export interface PaletteFile {
  path: string;
  name: string;
  /** its folder, as folderDetail() writes it */
  detail: string;
  /** a recent file: when it was last opened */
  openedAt?: number;
}

export interface PaletteHost {
  /** the commands that can be run now, in the order to suggest them */
  commands(): PaletteCommand[];
  headings(): PaletteHeading[];
  /** the other tabs of this window, most recently shown first */
  tabs(): PaletteTab[];
  /** the pane's tree and the recent files, without the files open in tabs */
  files(): Promise<PaletteFile[]>;
  openFile(path: string, where: Where): void;
  jumpTo(el: HTMLElement): void;
  findInDoc(q: string): void;
  searchFolder(q: string): void;
  hasFolder(): boolean;
  hasDocument(): boolean;
}

/**
 * A file's folder as the palette shows it: relative to the file pane's
 * folder when the file is inside it ("" right in it), else its last two
 * folders ("…\Projects\notes").
 */
export function folderDetail(path: string, root: string | null): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  parts.pop();
  if (root && isInside(root, path)) {
    return parts.slice(root.split(/[\\/]+/).filter(Boolean).length).join("\\");
  }
  return parts.length > 2 ? `…\\${parts.slice(-2).join("\\")}` : parts.join("\\");
}

/* ---- what is listed ---- */

type Kind = "command" | "heading" | "tab" | "file" | "search";

interface Entry {
  kind: Kind;
  /** the same thing from one list to the next, so the highlight can stay on it */
  key: string;
  label: string;
  /** muted, after the label: a heading's sections, a file's folder */
  detail: string;
  /** more words that find it: keywords, the sections, the folder */
  extra: string;
  icon: string;
  /** the shortcut, in the words of the UI */
  keys: string;
  checked?: boolean;
  /** a chip after the label ("Editor") */
  tag: string;
  /** headings: how deep in the outline, and whether it is the one being read */
  depth: number;
  current: boolean;
  /** recent files: when they were last opened (0: not recent) */
  openedAt: number;
  /** after the score: recent use, document order, recency */
  order: number;
  target: fuzzy.Target | null;
  score: number;
  hits: number[];
  act(where: Where): void;
}

interface Group {
  title: string;
  entries: Entry[];
}

// start: nothing typed; all: something typed; commands: after ">"; outline:
// a bare "#", every heading in order; headings: "#" and words
type Mode = "start" | "all" | "commands" | "outline" | "headings";

interface View {
  mode: Mode;
  groups: Group[];
  /** the entry to highlight first */
  best: number;
  /** "Nothing matches …", or "" */
  empty: string;
  /** how many entries were found (the Search group not counted) */
  results: number;
}

const CAP = { commands: 6, headings: 6, tabs: 5, files: 8 };
const START_CAP = { commands: 6, tabs: 5, files: 5 };
const OUTLINE_CAP = 200;
const RECENT_KEY = "palette-recent";
const RECENT_MAX = 8;
const ROW_H = 36;
// the list's own padding: an entry brought into view clears it
const EDGE = 6;
const OPT_ID = "palette-opt-";
const GROUP_ID = "palette-g-";
const LOCALE = uiLang();

// 24-px stroke icons, drawn at 16 px like the menus'
const ICON = {
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  folderSearch:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="12" cy="13.5" r="2.5"/><line x1="16" y1="17.5" x2="14" y2="15.5"/>',
  heading:
    '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  tab: '<rect x="2" y="6" width="20" height="15" rx="2"/><path d="M2 10h20"/><path d="M7 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>',
  pasted:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  start: '<path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><polyline points="9 21 9 13 15 13 15 21"/>',
  command: '<polyline points="9 18 15 12 9 6"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
};

const svg = (paths: string, size = 16): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

function el(tag: string, cls = "", text = ""): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/* ---- state ---- */

interface Ui {
  dialog: HTMLDialogElement;
  input: HTMLInputElement;
  none: HTMLElement;
  list: HTMLElement;
  status: HTMLElement;
}

let host: PaletteHost | null = null;
let ui: Ui | null = null;

// one opening: what it lists, what is on screen, where the highlight is
let opened = false;
let session = 0;
let commands: Entry[] = [];
let headings: Entry[] = [];
let tabs: Entry[] = [];
let files: Entry[] = [];
let canFind = false;
let canSearchFolder = false;
let returnFocus: HTMLElement | null = null;
// the text selected in the page as it opened: the box takes the selection with the focus
let returnRange: Range | null = null;
let view: View | null = null;
let shown: Entry[] = [];
let optionEls: HTMLElement[] = [];
// the index in `shown` of each group's first entry
let starts: number[] = [];
let active = -1;
// the highlight was moved (keys, pointer) since the text last changed: a
// list that grows meanwhile (the files arriving) keeps it where it is
let chosen = false;
let composing = false;
let pointer = { x: Number.NaN, y: Number.NaN };
let downOutside = false;
let announceTimer = 0;

/* ---- the API ---- */

export function init(h: PaletteHost): void {
  host = h;
}

export function isOpen(): boolean {
  return !!ui?.dialog.open;
}

export function open(): void {
  if (!host || isOpen()) return;
  const u = (ui ??= build());
  const focused = document.activeElement;
  returnFocus = focused instanceof HTMLElement && focused !== document.body ? focused : null;
  // a text field or the editor keeps its own selection, and gets it back with the focus
  const sel = document.getSelection();
  const typing =
    focused instanceof HTMLInputElement ||
    focused instanceof HTMLTextAreaElement ||
    (focused instanceof HTMLElement && focused.isContentEditable);
  returnRange = !typing && sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0).cloneRange() : null;
  opened = true;
  const my = ++session;
  const recent = readRecent();
  commands = host.commands().map((c, i) => commandEntry(c, i, recent));
  const heads = host.headings();
  const top = Math.min(...heads.map((h) => h.level));
  headings = heads.map((h, i) => headingEntry(h, i, top));
  tabs = host.tabs().map(tabEntry);
  files = [];
  canFind = host.hasDocument();
  canSearchFolder = host.hasFolder();
  u.input.value = "";
  u.status.textContent = "";
  composing = false;
  chosen = false;
  pointer = { x: Number.NaN, y: Number.NaN };
  u.dialog.showModal();
  u.input.focus();
  refresh(false);
  warm(my);
  // the folder's files take a moment (the recent ones are checked on disk):
  // they join the list when they come
  const h = host;
  Promise.resolve()
    .then(() => h.files())
    .then(
      (list) => {
        if (my !== session) return;
        files = fileEntries(list);
        refresh(true);
        warm(my);
      },
      () => {},
    );
}

// What matching needs of each entry (its folded label), made in idle moments
// while nothing is typed yet: with 2000 files the first keystroke would
// otherwise pay for all of it (14 ms in the harness, 2-4 ms the next ones).
// A throwaway match of each also gets the matching code compiled before that
// first keystroke runs it. One typed sooner makes the rest itself.
const WARM = ["e"];

function warm(my: number): void {
  const todo = [commands, headings, tabs, files].flat().filter((e) => !e.target);
  let i = 0;
  const step = (deadline: IdleDeadline): void => {
    if (my !== session) return;
    // the idle time left, or a few ms when the browser had none for a while
    const until = performance.now() + Math.max(deadline.timeRemaining() - 1, deadline.didTimeout ? 4 : 0);
    do {
      const e = todo[i++];
      e.target ??= fuzzy.target(e.label, e.extra || null, LOCALE);
      fuzzy.score(WARM, e.target);
    } while (i < todo.length && performance.now() < until);
    if (i < todo.length) requestIdleCallback(step, { timeout: 100 });
  };
  if (todo.length > 0) requestIdleCallback(step, { timeout: 100 });
}

export function close(): void {
  if (!ui) return;
  if (ui.dialog.open) ui.dialog.close();
  finish();
}

// The palette is gone, closed here or by main.ts (dialog.close()): its lists
// go, and the focus goes back where it was, before any picked action runs.
function finish(): void {
  if (!opened || !ui) return;
  opened = false;
  session++;
  clearTimeout(announceTimer);
  ui.list.replaceChildren();
  ui.none.hidden = true;
  ui.status.textContent = "";
  ui.input.removeAttribute("aria-activedescendant");
  commands = [];
  headings = [];
  tabs = [];
  files = [];
  shown = [];
  optionEls = [];
  starts = [];
  view = null;
  active = -1;
  const back = returnFocus;
  const range = returnRange;
  returnFocus = null;
  returnRange = null;
  if (back?.isConnected) back.focus({ preventScroll: true });
  // nothing had it (the page itself), or what had it can take it no more (a
  // menu hidden as the palette opened): the hidden box lets it go now, not at
  // the browser's next frame, so a picked action never runs with the focus in
  // a closed dialog
  if (document.activeElement === ui.input) ui.input.blur();
  // the text that was selected comes back too (unless the page was drawn anew
  // meanwhile): Find and Search the folder look for it, as Ctrl+F does
  if (range?.startContainer.isConnected && range.endContainer.isConnected) {
    const sel = document.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }
}

/* ---- the entries ---- */

function entry(kind: Kind, key: string, label: string, act: (where: Where) => void, more: Partial<Entry> = {}): Entry {
  return {
    kind,
    key,
    label,
    detail: "",
    extra: "",
    icon: ICON.command,
    keys: "",
    tag: "",
    depth: 0,
    current: false,
    openedAt: 0,
    order: 0,
    target: null,
    score: 0,
    hits: [],
    act,
    ...more,
  };
}

function commandEntry(c: PaletteCommand, i: number, recent: readonly string[]): Entry {
  const r = recent.indexOf(c.id);
  return entry(
    "command",
    `c:${c.id}`,
    c.label,
    () => {
      remember(c.id);
      c.run();
    },
    {
      extra: c.keywords ?? "",
      icon: c.icon || ICON.command,
      keys: c.keys ? keyLabel(c.keys) : "",
      checked: c.checked,
      tag: c.group === "editor" ? t("pal.editor") : "",
      // the recently used first, then in the host's order
      order: r >= 0 ? r : RECENT_MAX + i,
    },
  );
}

function headingEntry(h: PaletteHeading, i: number, top: number): Entry {
  const go = (): void => {
    const el = h.el.isConnected ? h.el : redrawn(h, i);
    if (el) host?.jumpTo(el);
  };
  return entry("heading", `h:${i}`, h.text, go, {
    detail: h.path,
    extra: h.path,
    icon: ICON.heading,
    depth: Math.max(0, h.level - top),
    current: h.current,
    order: i,
  });
}

// The document was drawn again while the palette was open (its file changed
// on disk, the editor's preview caught up): the same heading in the new
// drawing, the one of that text nearest its old place.
function redrawn(h: PaletteHeading, i: number): HTMLElement | null {
  const now = host?.headings() ?? [];
  let best: HTMLElement | null = null;
  let gap = Infinity;
  for (let k = 0; k < now.length; k++) {
    if (now[k].text === h.text && Math.abs(k - i) < gap) {
      gap = Math.abs(k - i);
      best = now[k].el;
    }
  }
  return best;
}

function tabEntry(tab: PaletteTab, i: number): Entry {
  return entry("tab", `t:${tab.key}`, tab.title, () => tab.activate(), {
    detail: tab.detail,
    extra: tab.detail,
    icon: tab.kind === "pasted" ? ICON.pasted : tab.kind === "start" ? ICON.start : ICON.tab,
    order: i,
  });
}

// one entry per file: the tree and the recent files may both list it
function fileEntries(list: readonly PaletteFile[]): Entry[] {
  const byPath = new Map<string, Entry>();
  list.forEach((f, i) => {
    const key = f.path.toLowerCase();
    const at = f.openedAt ?? 0;
    const had = byPath.get(key);
    if (had) {
      if (at > had.openedAt) {
        had.openedAt = at;
        had.order = -at;
      }
      return;
    }
    byPath.set(
      key,
      entry("file", `f:${key}`, f.name, (where) => host?.openFile(f.path, where), {
        detail: f.detail,
        extra: f.detail,
        icon: ICON.file,
        openedAt: at,
        // the recent ones first, the latest first; then the tree's order
        order: at > 0 ? -at : i,
      }),
    );
  });
  return [...byPath.values()];
}

/* ---- recently used commands ---- */

function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function remember(id: string): void {
  try {
    const next = [id, ...readRecent().filter((x) => x !== id)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* no storage: the suggestions stay the defaults */
  }
}

/* ---- the list for what is typed ---- */

// The entries that match every word, best first; equals keep their order
// (recent use, the document's, recency), then the shorter label.
function ranked(entries: readonly Entry[], ws: readonly string[], cap = Infinity): Entry[] {
  const out: Entry[] = [];
  for (const e of entries) {
    e.target ??= fuzzy.target(e.label, e.extra || null, LOCALE);
    const m = fuzzy.score(ws, e.target);
    if (!m) continue;
    e.score = m.score;
    e.hits = m.hits;
    out.push(e);
  }
  out.sort((a, b) => b.score - a.score || a.order - b.order || a.label.length - b.label.length);
  return out.slice(0, cap);
}

function unranked(entries: readonly Entry[]): Entry[] {
  for (const e of entries) {
    e.score = 0;
    e.hits = [];
  }
  return [...entries];
}

const byOrder = (entries: readonly Entry[]): Entry[] => unranked(entries).sort((a, b) => a.order - b.order);

// The whole outline, or for a longer one the part around the heading being
// read (the first ones would leave it out of a long changelog's list)
function around(entries: readonly Entry[]): Entry[] {
  const cur = Math.max(0, entries.findIndex((e) => e.current));
  const from = Math.max(0, Math.min(cur - OUTLINE_CAP / 2, entries.length - OUTLINE_CAP));
  return unranked(entries.slice(from, from + OUTLINE_CAP));
}

function compute(raw: string): View {
  const lead = raw.trimStart();
  const prefix = lead[0] === ">" || lead[0] === "#" ? lead[0] : "";
  const q = (prefix ? lead.slice(1) : raw).trim();
  const ws = q ? fuzzy.words(q, LOCALE) : [];
  const groups: Group[] = [];
  const add = (key: keyof Dict, entries: Entry[]) => {
    if (entries.length > 0) groups.push({ title: t(key), entries });
  };
  let mode: Mode;
  if (prefix === ">") {
    mode = "commands";
    add("pal.gCommands", ws.length ? ranked(commands, ws) : byOrder(commands));
  } else if (prefix === "#") {
    mode = ws.length ? "headings" : "outline";
    add("pal.gHeadings", ws.length ? ranked(headings, ws, OUTLINE_CAP) : around(headings));
  } else if (ws.length === 0) {
    mode = "start";
    add("pal.gCommands", byOrder(commands).slice(0, START_CAP.commands));
    add("pal.gTabs", unranked(tabs.slice(0, START_CAP.tabs)));
    add("pal.gFiles", byOrder(files.filter((f) => f.openedAt > 0)).slice(0, START_CAP.files));
  } else {
    mode = "all";
    add("pal.gCommands", ranked(commands, ws, CAP.commands));
    add("pal.gHeadings", ranked(headings, ws, CAP.headings));
    add("pal.gTabs", ranked(tabs, ws, CAP.tabs));
    add("pal.gFiles", ranked(files, ws, CAP.files));
  }

  // the highlight starts on the best of all: the top of the group whose top
  // scores most (the earlier group of equals); in the outline, the heading
  // being read
  let best = 0;
  let bestScore = -Infinity;
  let results = 0;
  for (const g of groups) {
    if (mode === "all" && g.entries[0].score > bestScore) {
      bestScore = g.entries[0].score;
      best = results;
    }
    results += g.entries.length;
  }
  if (mode === "outline") best = Math.max(0, groups[0]?.entries.findIndex((e) => e.current) ?? 0);

  if (mode === "all") {
    const search: Entry[] = [];
    if (canFind) {
      search.push(entry("search", "s:doc", t("pal.findInDoc", { q }), () => host?.findInDoc(q), { icon: ICON.search }));
    }
    if (canSearchFolder) {
      search.push(
        entry("search", "s:folder", t("pal.searchFolder", { q }), () => host?.searchFolder(q), { icon: ICON.folderSearch }),
      );
    }
    if (search.length > 0) groups.push({ title: t("pal.gSearch"), entries: search });
  }
  const empty = results === 0 && (q || prefix) ? t("pal.none", { q: q || prefix }) : "";
  // nothing found: the first of the searches, when there are any
  return { mode, groups, best: results > 0 ? best : 0, empty, results };
}

/* ---- drawing ---- */

function refresh(keep: boolean): void {
  if (!ui) return;
  const keepKey = keep && chosen && active >= 0 ? shown[active]?.key : undefined;
  view = compute(ui.input.value);
  render(view, keep);
  let next = view.best;
  if (keepKey !== undefined) {
    const i = shown.findIndex((e) => e.key === keepKey);
    if (i >= 0) next = i;
    else chosen = false;
  }
  setActive(next, { reveal: !(keep && chosen), center: view.mode === "outline" });
}

function render(v: View, keepScroll: boolean): void {
  const u = ui!;
  const scroll = u.list.scrollTop;
  shown = [];
  optionEls = [];
  starts = [];
  active = -1;
  const frag = document.createDocumentFragment();
  v.groups.forEach((g, gi) => {
    const group = el("div", "pal-group");
    group.setAttribute("role", "group");
    group.setAttribute("aria-labelledby", `${GROUP_ID}${gi}`);
    const title = el("div", "pal-gtitle", g.title);
    title.id = `${GROUP_ID}${gi}`;
    title.setAttribute("role", "presentation");
    group.append(title);
    starts.push(shown.length);
    for (const e of g.entries) {
      const opt = option(e, shown.length, v.mode);
      shown.push(e);
      optionEls.push(opt);
      group.append(opt);
    }
    frag.append(group);
  });
  u.list.replaceChildren(frag);
  u.list.scrollTop = keepScroll ? scroll : 0;
  u.none.textContent = v.empty;
  u.none.hidden = !v.empty;
  u.input.setAttribute("aria-expanded", String(shown.length > 0));
  u.input.removeAttribute("aria-activedescendant");
}

function iconHtml(icon: string): string {
  if (icon.startsWith("<")) return svg(icon);
  return el("span", "pal-glyph", icon).outerHTML;
}

function labelEl(text: string, hits: readonly number[]): HTMLElement {
  const label = el("span", "pal-label");
  if (hits.length === 0) {
    label.textContent = text;
    return label;
  }
  for (const r of fuzzy.runs(text, hits)) label.append(r.hit ? el("span", "pal-hit", r.text) : r.text);
  return label;
}

function option(e: Entry, i: number, mode: Mode): HTMLElement {
  const opt = el("div", "pal-opt");
  opt.id = `${OPT_ID}${i}`;
  opt.setAttribute("role", "option");
  opt.setAttribute("aria-selected", "false");
  opt.dataset.i = String(i);
  if (e.checked !== undefined) opt.setAttribute("aria-checked", String(e.checked));
  // the whole outline shows its shape; a list of matches does not need it
  if (mode === "outline" && e.depth > 0) opt.style.setProperty("--depth", String(e.depth));
  const icon = el("span", "pal-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML = iconHtml(e.icon);
  const text = el("span", "pal-text");
  text.append(labelEl(e.label, e.hits));
  const tag = mode === "outline" && e.current ? t("pal.current") : e.tag;
  if (tag) text.append(el("span", "pal-tag", tag));
  if (e.detail && mode !== "outline") text.append(el("span", "pal-detail", e.detail));
  opt.append(icon, text);
  if (e.checked !== undefined) {
    const box = el("span", "pal-check");
    box.setAttribute("aria-hidden", "true");
    if (e.checked) box.innerHTML = svg(ICON.check, 11);
    opt.append(box);
  }
  // nothing typed: a recent file says when it was opened, as on the start page
  const side = e.keys || (mode === "start" && e.openedAt > 0 ? relativeTime(e.openedAt) : "");
  if (side) opt.append(el("span", "pal-kbd", side));
  return opt;
}

function setActive(i: number, opts: { reveal?: boolean; center?: boolean } = {}): void {
  const u = ui!;
  optionEls[active]?.setAttribute("aria-selected", "false");
  active = i >= 0 && i < shown.length ? i : -1;
  const opt = optionEls[active];
  if (!opt) {
    u.input.removeAttribute("aria-activedescendant");
    return;
  }
  opt.setAttribute("aria-selected", "true");
  u.input.setAttribute("aria-activedescendant", opt.id);
  if (opts.reveal !== false) reveal(active, opts.center === true);
}

// Scrolls the list just enough to show entry i: the first entry of a group
// brings the group's title along, the very first one the top of the list.
function reveal(i: number, center: boolean): void {
  const list = ui!.list;
  const opt = optionEls[i];
  if (!opt) return;
  if (i === 0) {
    list.scrollTop = 0;
    return;
  }
  const box = list.getBoundingClientRect();
  const r = opt.getBoundingClientRect();
  if (center) {
    list.scrollTop += r.top - box.top - (box.height - r.height) / 2;
    return;
  }
  const title = starts.includes(i) ? opt.parentElement?.firstElementChild : null;
  const top = title ? title.getBoundingClientRect().top : r.top;
  if (top < box.top + EDGE) list.scrollTop -= box.top + EDGE - top;
  else if (r.bottom > box.bottom - EDGE) list.scrollTop += r.bottom - (box.bottom - EDGE);
}

/* ---- picking ---- */

// The palette closes and the focus goes back first; the action runs after
// the event that picked it, so what it focuses (the find bar, the editor)
// keeps the focus, and a menu it opens is not closed by that same click.
function pick(i: number, where: Where): void {
  const e = shown[i];
  if (!e) return;
  close();
  window.setTimeout(() => e.act(where), 0);
}

function step(dir: 1 | -1): void {
  const n = shown.length;
  if (n === 0) return;
  chosen = true;
  setActive(active < 0 ? (dir > 0 ? 0 : n - 1) : (active + dir + n) % n);
}

// Page Down: the next group's first entry (the last entry, in the last
// group); Page Up: the start of this group, or of the one before. A list of
// one group (the outline) moves a page at a time.
function stepPage(dir: 1 | -1): void {
  const n = shown.length;
  if (n === 0) return;
  const cur = Math.max(0, active);
  let next: number;
  if (starts.length > 1) {
    let g = 0;
    while (g + 1 < starts.length && starts[g + 1] <= cur) g++;
    if (dir > 0) next = g + 1 < starts.length ? starts[g + 1] : n - 1;
    else next = cur > starts[g] ? starts[g] : starts[Math.max(0, g - 1)];
  } else {
    const rows = Math.max(1, Math.floor(ui!.list.clientHeight / ROW_H) - 1);
    next = Math.max(0, Math.min(n - 1, cur + dir * rows));
  }
  chosen = true;
  setActive(next);
}

/* ---- keys ---- */

// a letter by the character it types, by its place only on layouts whose
// letters are not Latin (Ctrl+C is Ctrl+C on a Russian keyboard too)
const keyName = (e: KeyboardEvent): string =>
  /^[\x20-\x7e]$/.test(e.key) ? e.key.toLowerCase() : (/^Key([A-Z])$/.exec(e.code)?.[1].toLowerCase() ?? e.key.toLowerCase());

const isPaletteKey = (e: KeyboardEvent): boolean =>
  e.ctrlKey && !e.altKey && !e.metaKey && keyName(e) === (e.shiftKey ? "p" : "k");

// the text box's own keys with Ctrl: select all, the clipboard, undo, moving
// and deleting by words
const TEXT_KEYS = new Set([
  "a", "c", "v", "x", "z", "y", "backspace", "delete", "arrowleft", "arrowright", "home", "end", "insert",
  "control", "shift", "meta",
]);

// What the app or WebView2 would do behind the palette: print or save the
// page, zoom it, find in it, the tab keys. AltGr (Ctrl+Alt on Windows) types
// @, #, [, € on many layouts, so it is left alone.
function heldBack(e: KeyboardEvent): boolean {
  if (/^F(?:[2-9]|1\d|2[0-4])$/.test(e.key)) return true;
  if (e.altKey && !e.ctrlKey) return e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home";
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  return !TEXT_KEYS.has(keyName(e));
}

// true when the key was the palette's own
function ownKey(e: KeyboardEvent): boolean {
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
      step(e.key === "ArrowDown" ? 1 : -1);
      return true;
    case "PageDown":
    case "PageUp":
      // Ctrl+Page Up/Down are the tab keys: held back, nothing more
      if (!e.ctrlKey) stepPage(e.key === "PageDown" ? 1 : -1);
      return true;
    case "Enter":
      // Ctrl: a tab behind; Ctrl+Shift: a tab in front; Shift: a window (files)
      if (!e.repeat && active >= 0) pick(active, whereFromKeys(e));
      return true;
    case "Tab":
      return true;
    case "Escape":
      close();
      return true;
  }
  // a fresh press only: held down, the key that opened it would close it at
  // its first repeat
  if (isPaletteKey(e)) {
    if (!e.repeat) close();
    return true;
  }
  return false;
}

function onKey(e: KeyboardEvent): void {
  // an IME composing (Chinese, Japanese): its keys are the IME's
  if (e.isComposing || e.keyCode === 229) return;
  if (ownKey(e)) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  // the help: main.ts closes the palette and opens it
  if (e.key === "F1") return;
  if (heldBack(e)) e.preventDefault();
  e.stopPropagation();
}

/* ---- the screen reader's count ---- */

// After the typing pauses: the count, or that nothing matches. The app's own
// live regions are inert behind a modal dialog, hence this one inside it.
function announceSoon(): void {
  clearTimeout(announceTimer);
  announceTimer = window.setTimeout(() => {
    const u = ui;
    if (!u || !view) return;
    u.status.textContent = "";
    announceTimer = window.setTimeout(() => {
      if (!view) return;
      const n = view.results;
      u.status.textContent = view.empty || (n === 1 ? t("pal.countOne") : t("pal.count", { n: fmtNumber(n) }));
    }, 60);
  }, 300);
}

function onQuery(): void {
  chosen = false;
  refresh(false);
  announceSoon();
}

/* ---- the dialog ---- */

const indexAt = (target: EventTarget | null): number => {
  const opt = target instanceof Element ? target.closest<HTMLElement>(".pal-opt") : null;
  return opt ? Number(opt.dataset.i) : -1;
};

function build(): Ui {
  const dialog = document.createElement("dialog");
  dialog.id = "palette";
  dialog.setAttribute("aria-label", t("pal.title"));

  const head = el("div", "pal-head");
  const glass = el("span", "pal-glass");
  glass.innerHTML = svg(ICON.search, 18);
  const input = document.createElement("input");
  input.id = "palette-input";
  input.type = "text";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = t("pal.placeholder");
  input.setAttribute("autocapitalize", "off");
  input.setAttribute("enterkeyhint", "go");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-label", t("pal.title"));
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-expanded", "false");
  input.setAttribute("aria-controls", "palette-list");
  input.setAttribute("aria-describedby", "palette-help");
  head.append(glass, input);

  const none = el("div", "pal-none");
  none.hidden = true;
  const list = el("div", "pal-list");
  list.id = "palette-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-label", t("pal.results"));
  // the keys are said by the description (pal.help); the footer is for the eyes
  const foot = el("div", "pal-foot");
  foot.setAttribute("aria-hidden", "true");
  foot.innerHTML = t("pal.foot");
  const help = el("div", "", t("pal.help"));
  help.id = "palette-help";
  help.hidden = true;
  const status = el("div", "sr-only");
  status.id = "palette-status";
  status.setAttribute("role", "status");
  dialog.append(head, none, list, foot, help, status);
  document.body.append(dialog);

  dialog.addEventListener("keydown", onKey);
  // Escape from elsewhere than the keys above (it is handled there)
  dialog.addEventListener("cancel", (e) => {
    e.preventDefault();
    if (!composing) close();
  });
  dialog.addEventListener("close", () => {
    if (!dialog.open) finish();
  });
  // a press and release both on the backdrop closes it (not a drag that ends there)
  const outside = (e: MouseEvent): boolean => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dialog.addEventListener("pointerdown", (e) => {
    downOutside = outside(e);
  });
  dialog.addEventListener("click", (e) => {
    if (downOutside && outside(e)) close();
    downOutside = false;
  });
  // no right-click menu on the entries (the document's would open); the text
  // box keeps WebView2's own, for cut, copy and paste
  dialog.addEventListener("contextmenu", (e) => {
    if (e.target !== input) e.preventDefault();
    e.stopPropagation();
  });
  // Ctrl+V in the box pastes text into it: no new document from the clipboard
  dialog.addEventListener("paste", (e) => e.stopPropagation());

  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    onQuery();
  });
  input.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing || composing) return;
    onQuery();
  });

  // a press must not take the focus from the text box (nor start the middle
  // button's autoscroll)
  list.addEventListener("mousedown", (e) => e.preventDefault());
  // the pointer moves the highlight only when it really moves: a list drawn
  // anew, or scrolled, under a pointer at rest leaves the keys' choice alone
  list.addEventListener("pointermove", (e) => {
    const moved = e.clientX !== pointer.x || e.clientY !== pointer.y;
    pointer = { x: e.clientX, y: e.clientY };
    if (!moved || (e.movementX === 0 && e.movementY === 0)) return;
    const i = indexAt(e.target);
    if (i < 0 || i === active) return;
    chosen = true;
    setActive(i, { reveal: false });
  });
  list.addEventListener("click", (e) => {
    const i = indexAt(e.target);
    if (i >= 0) pick(i, whereFrom(e));
  });
  // the middle button: a file in a tab behind, as everywhere in the app
  list.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const i = indexAt(e.target);
    if (i >= 0 && shown[i].kind === "file") pick(i, "tab");
  });

  return { dialog, input, none, list, status };
}
