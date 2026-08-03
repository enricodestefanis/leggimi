import type { TreeNode } from "./ipc";
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

export function render(
  container: HTMLElement,
  root: TreeNode,
  currentPath: string,
  onSelect: (path: string) => void,
): void {
  if (currentPath && norm(currentPath) !== lastActivePath) {
    revealAncestorsInSet(currentPath);
    lastActivePath = norm(currentPath);
  }
  const frag = document.createDocumentFragment();
  for (const child of root.children) frag.append(buildNode(child, currentPath, onSelect));
  container.replaceChildren(frag);
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
  container.querySelector(".tree-row.active")?.classList.remove("active");
  target.classList.add("active");
  let changed = false;
  for (let el = target.parentElement; el && el !== container; el = el.parentElement) {
    if (el.classList.contains("tree-dir") && el.classList.contains("collapsed")) {
      el.classList.remove("collapsed");
      changed = collapsed.delete(norm(el.dataset.path ?? "")) || changed;
    }
  }
  if (changed) persist();
  lastActivePath = norm(path);
  return true;
}

function buildNode(node: TreeNode, currentPath: string, onSelect: (path: string) => void): HTMLElement {
  if (!node.isDir) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-row file" + (samePath(node.path, currentPath) ? " active" : "");
    row.dataset.path = node.path;
    row.innerHTML = FILE_ICON;
    const name = document.createElement("span");
    name.textContent = node.name;
    name.title = node.name;
    row.append(name);
    row.addEventListener("click", () => onSelect(node.path));
    return row;
  }

  const wrap = document.createElement("div");
  wrap.className = "tree-dir";
  wrap.dataset.path = node.path;
  if (collapsed.has(norm(node.path))) wrap.classList.add("collapsed");
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row dir";
  row.innerHTML = CHEVRON;
  const name = document.createElement("span");
  name.textContent = node.name;
  name.title = node.name;
  row.append(name);
  row.addEventListener("click", () => {
    const key = norm(node.path);
    if (wrap.classList.toggle("collapsed")) collapsed.add(key);
    else collapsed.delete(key);
    persist();
  });

  const children = document.createElement("div");
  children.className = "tree-children";
  for (const child of node.children) children.append(buildNode(child, currentPath, onSelect));

  wrap.append(row, children);
  return wrap;
}
