import type { TreeNode } from "./ipc";

const CHEVRON =
  '<svg class="tree-chevron" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>';
const FILE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

export function render(
  container: HTMLElement,
  root: TreeNode,
  currentPath: string,
  onSelect: (path: string) => void,
): void {
  const frag = document.createDocumentFragment();
  for (const child of root.children) frag.append(buildNode(child, currentPath, onSelect));
  container.replaceChildren(frag);
}

function buildNode(node: TreeNode, currentPath: string, onSelect: (path: string) => void): HTMLElement {
  if (!node.isDir) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "tree-row file" + (node.path === currentPath ? " active" : "");
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
  const row = document.createElement("button");
  row.type = "button";
  row.className = "tree-row dir";
  row.innerHTML = CHEVRON;
  const name = document.createElement("span");
  name.textContent = node.name;
  name.title = node.name;
  row.append(name);
  row.addEventListener("click", () => wrap.classList.toggle("collapsed"));

  const children = document.createElement("div");
  children.className = "tree-children";
  for (const child of node.children) children.append(buildNode(child, currentPath, onSelect));

  wrap.append(row, children);
  return wrap;
}
