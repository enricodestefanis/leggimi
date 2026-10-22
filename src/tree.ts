import type { TreeNode } from "./ipc";
import { t } from "./i18n";
import { isInside, samePath } from "./paths";

const CHEVRON =
  '<svg class="tree-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

// Collapsed dirs survive rebuilds (file selection, watcher refreshes) and app
// restarts. Only collapsed paths are stored: expanded is the default, so new
// folders on disk need no entry and stale entries are simply never matched.
const LS_KEY = "tree-collapsed";
const norm = (p: string) => p.toLowerCase();
const collapsed = loadCollapsed();
// Guards auto-reveal: ancestors of the active file are expanded only when the
// selection changes, never on a rebuild of the same document (watcher saves).
let lastActivePath = "";
// A folder's row owns its group of children (aria-owns), which is the row's
// sibling in the DOM: the groups need ids, unique across rebuilds.
let groupSeq = 0;
// containers whose focus and keys are already wired (render runs many times)
const wired = new WeakSet<HTMLElement>();

function loadCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter((e) => typeof e === "string") : []);
  } catch {
    return new Set();
  }
}

function persist(): void {
  localStorage.setItem(LS_KEY, JSON.stringify([...collapsed]));
}

function revealAncestorsInSet(path: string): void {
  let changed = false;
  for (const entry of collapsed) {
    if (isInside(entry, path)) {
      collapsed.delete(entry);
      changed = true;
    }
  }
  if (changed) persist();
}

/** a file row was clicked; `e` tells a Ctrl+click or a middle click (a new window) */
export type OnSelect = (path: string, e: MouseEvent) => void;

export function render(
  container: HTMLElement,
  root: TreeNode,
  currentPath: string,
  onSelect: OnSelect,
): void {
  if (currentPath && norm(currentPath) !== lastActivePath) {
    revealAncestorsInSet(currentPath);
    lastActivePath = norm(currentPath);
  }
  wire(container);
  const frag = document.createDocumentFragment();
  root.children.forEach((child, i) =>
    frag.append(buildNode(child, currentPath, onSelect, { level: 1, pos: i + 1, size: root.children.length })),
  );
  container.replaceChildren(frag);
  // one row takes the Tab key: the open document's (or the folder that hides
  // it), else the first. A row focused after this (main.ts puts the focus
  // back on the row it was on) takes it over through focusin.
  const active = container.querySelector<HTMLElement>(".tree-row.active");
  setRoving(container, active ? shownRow(active, container) : container.querySelector<HTMLElement>(".tree-row"));
}

// Moves the highlight in an already-rendered tree without a rebuild. Returns
// false when the file is not in the DOM (e.g. deeper than the tree depth cap)
// so the caller can fall back to a full render.
export function setActive(container: HTMLElement, path: string): boolean {
  let target: HTMLElement | null = null;
  for (const row of container.querySelectorAll<HTMLElement>(".tree-row.file")) {
    if (samePath(row.dataset.path ?? "", path)) {
      target = row;
      break;
    }
  }
  if (!target) return false;
  const prev = container.querySelector(".tree-row.active");
  prev?.classList.remove("active");
  prev?.removeAttribute("aria-current");
  target.classList.add("active");
  target.setAttribute("aria-current", "true");
  let changed = false;
  for (let el = target.parentElement; el && el !== container; el = el.parentElement) {
    if (el.classList.contains("tree-dir") && el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      el.querySelector(":scope > .tree-row")?.setAttribute("aria-expanded", "true");
      changed = collapsed.delete(norm(el.dataset.path ?? "")) || changed;
    }
  }
  if (changed) persist();
  lastActivePath = norm(path);
  // Tab into the tree lands on the open document, unless the keys are in the
  // tree right now: then the row they are on keeps its place
  if (!container.contains(document.activeElement)) setRoving(container, target);
  return true;
}

interface Position {
  level: number;
  pos: number;
  size: number;
}

// Each row is a treeitem with its place spelled out (level, n of m), since
// its children sit beside it in the DOM rather than inside it.
function makeRow(kind: "file" | "dir", { level, pos, size }: Position): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `tree-row ${kind}`;
  row.tabIndex = -1;
  row.setAttribute("role", "treeitem");
  row.setAttribute("aria-level", String(level));
  row.setAttribute("aria-posinset", String(pos));
  row.setAttribute("aria-setsize", String(size));
  return row;
}

function buildNode(node: TreeNode, currentPath: string, onSelect: OnSelect, at: Position): HTMLElement {
  if (!node.isDir) {
    const row = makeRow("file", at);
    if (samePath(node.path, currentPath)) {
      row.classList.add("active");
      row.setAttribute("aria-current", "true");
    }
    row.dataset.path = node.path;
    row.innerHTML = FILE_ICON;
    const name = document.createElement("span");
    name.textContent = node.name;
    name.title = node.name;
    row.append(name);
    row.addEventListener("click", (e) => onSelect(node.path, e));
    // the middle button opens too (in a new window), without autoscroll
    row.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault();
    });
    row.addEventListener("auxclick", (e) => {
      if (e.button === 1) onSelect(node.path, e);
    });
    return row;
  }

  const wrap = document.createElement("div");
  wrap.className = "tree-dir";
  wrap.dataset.path = node.path;
  const isCollapsed = collapsed.has(norm(node.path));
  if (isCollapsed) wrap.classList.add("collapsed");
  const row = makeRow("dir", at);
  row.setAttribute("aria-expanded", String(!isCollapsed));
  row.innerHTML = CHEVRON;
  const name = document.createElement("span");
  name.textContent = node.name;
  name.title = node.name;
  row.append(name);
  row.addEventListener("click", () => setExpanded(wrap, wrap.classList.contains("collapsed")));

  const children = document.createElement("div");
  children.className = "tree-children";
  children.id = `tree-group-${++groupSeq}`;
  children.setAttribute("role", "group");
  row.setAttribute("aria-owns", children.id);
  const level = at.level + 1;
  node.children.forEach((child, i) =>
    children.append(buildNode(child, currentPath, onSelect, { level, pos: i + 1, size: node.children.length })),
  );

  wrap.append(row, children);
  return wrap;
}

// Opens or closes a folder (a click on it, the Right and Left keys) and
// remembers the choice.
function setExpanded(dir: HTMLElement, open: boolean): void {
  const row = dir.querySelector<HTMLElement>(":scope > .tree-row");
  dir.classList.toggle("collapsed", !open);
  row?.setAttribute("aria-expanded", String(open));
  const key = norm(dir.dataset.path ?? "");
  if (open) collapsed.delete(key);
  else collapsed.add(key);
  persist();
  // a row that went out of sight cannot keep the Tab stop: its folder takes it
  const container = dir.closest<HTMLElement>('[role="tree"]');
  const roving = container?.querySelector<HTMLElement>('.tree-row[tabindex="0"]');
  if (!open && container && row && roving && roving !== row && dir.contains(roving)) setRoving(container, row);
}

/* ---- keyboard: the tree pattern of the ARIA Authoring Practices ---- */

function wire(container: HTMLElement): void {
  if (wired.has(container)) return;
  wired.add(container);
  container.setAttribute("role", "tree");
  container.setAttribute("aria-label", t("pane.files"));
  // whichever row takes the focus (a click, the keys, a redraw putting it
  // back) is the one Tab returns to
  container.addEventListener("focusin", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (row && container.contains(row)) setRoving(container, row);
  });
  container.addEventListener("keydown", (e) => onKey(e, container));
}

function setRoving(container: HTMLElement, row: HTMLElement | null): void {
  for (const el of container.querySelectorAll<HTMLElement>('.tree-row[tabindex="0"]')) {
    if (el !== row) el.tabIndex = -1;
  }
  if (row) row.tabIndex = 0;
}

// a folder's wrapper, for its row; null for a file row
const dirOf = (row: HTMLElement): HTMLElement | null =>
  row.classList.contains("dir") ? row.parentElement : null;

const rowOf = (dir: Element | null | undefined): HTMLElement | null =>
  dir?.querySelector<HTMLElement>(":scope > .tree-row") ?? null;

// The rows on screen, top to bottom: the children of collapsed folders are
// left out. Read from the classes, not from the layout, since a collapsing
// folder's rows stay visible until its animation ends.
function visibleRows(container: HTMLElement): HTMLElement[] {
  const rows: HTMLElement[] = [];
  const walk = (parent: Element): void => {
    for (const el of parent.children) {
      if (el.classList.contains("tree-row")) {
        rows.push(el as HTMLElement);
      } else if (el.classList.contains("tree-dir")) {
        const row = rowOf(el);
        if (row) rows.push(row);
        const group = el.querySelector(":scope > .tree-children");
        if (group && !el.classList.contains("collapsed")) walk(group);
      }
    }
  };
  walk(container);
  return rows;
}

// the row that stands for `row` on screen: the outermost collapsed folder
// around it, or the row itself
function shownRow(row: HTMLElement, container: HTMLElement): HTMLElement {
  let shown = row;
  for (let el = row.parentElement; el && el !== container; el = el.parentElement) {
    if (el.classList.contains("tree-children") && el.parentElement?.classList.contains("collapsed")) {
      shown = rowOf(el.parentElement) ?? shown;
    }
  }
  return shown;
}

// the folder row a row belongs to; null at the top level
function parentRow(row: HTMLElement, container: HTMLElement): HTMLElement | null {
  const group = row.parentElement?.closest(".tree-children");
  return group && container.contains(group) ? rowOf(group.parentElement) : null;
}

function firstChildRow(dir: HTMLElement): HTMLElement | null {
  const first = dir.querySelector(":scope > .tree-children")?.firstElementChild;
  if (!first) return null;
  return first.classList.contains("tree-row") ? (first as HTMLElement) : rowOf(first);
}

// Up and Down walk the visible rows, Right opens a folder or enters it, Left
// closes it or goes to the parent folder, Home and End reach the ends, Enter
// and Space do what a click does (with Ctrl, a new window, as Ctrl+click).
// Alt and the other modifiers stay with the app (Alt+Left is Back).
function onKey(e: KeyboardEvent, container: HTMLElement): void {
  if (e.altKey || e.metaKey) return;
  const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
  if (!row || !container.contains(row)) return;
  const plain = !e.ctrlKey && !e.shiftKey;
  let next: HTMLElement | null = null;
  switch (e.key) {
    case "ArrowDown":
    case "ArrowUp":
    case "Home":
    case "End": {
      if (!plain) return;
      const rows = visibleRows(container);
      const i = rows.indexOf(row);
      if (e.key === "Home") next = rows[0] ?? null;
      else if (e.key === "End") next = rows[rows.length - 1] ?? null;
      else next = rows[i + (e.key === "ArrowDown" ? 1 : -1)] ?? null;
      break;
    }
    case "ArrowRight": {
      if (!plain) return;
      const dir = dirOf(row);
      if (dir?.classList.contains("collapsed")) setExpanded(dir, true);
      else if (dir) next = firstChildRow(dir);
      break;
    }
    case "ArrowLeft": {
      if (!plain) return;
      const dir = dirOf(row);
      if (dir && !dir.classList.contains("collapsed")) setExpanded(dir, false);
      else next = parentRow(row, container);
      break;
    }
    case "Enter":
    case " ":
      // held down, it must not open the file (or new windows) over and over
      if (!e.repeat) {
        const init = { bubbles: true, cancelable: true, view: window, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey };
        row.dispatchEvent(new MouseEvent("click", init));
      }
      break;
    default:
      return;
  }
  // the key was the tree's: no scrolling of the pane, no reading key
  e.preventDefault();
  if (next) {
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: "nearest" });
  }
}
