import "./styles/base.css";
import "./styles/layout.css";
import "./styles/markdown.css";
import "./styles/code.css";
import "./styles/ui.css";

import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import * as ipc from "./ipc";
import { render } from "./renderer";
import { renderMermaidIn, rerenderForTheme } from "./mermaid";
import * as toc from "./toc";
import * as tree from "./tree";
import * as search from "./search";
import * as theme from "./theme";
import { captureScrollAnchor, restoreScrollAnchor } from "./state";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const app = $("#app");
const contentPane = $("#content-pane");
const article = $("#article");
const emptyState = $("#empty-state");
const treeRoot = $("#tree-root");
const treeRootName = $("#tree-rootname");
const btnUp = $<HTMLButtonElement>("#btn-up");
const tocList = $("#toc-list");
const docTitle = $("#doc-title");
const helpDialog = $<HTMLDialogElement>("#help-dialog");

let currentDoc: ipc.MarkdownDoc | null = null;
// Root of the file browser. It survives navigation *within* itself, so opening a
// file from a subfolder does not make the rest of the tree disappear.
let browseRoot: string | null = null;
let opening = false;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isMarkdownPath = (p: string) => /\.(md|markdown)$/i.test(p);
const isDriveRoot = (p: string) => /^[a-z]:[\\/]?$/i.test(p);

function isInside(parent: string, child: string): boolean {
  const p = parent.toLowerCase().replace(/[\\/]+$/, "");
  const c = child.toLowerCase();
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

async function openFile(path: string, opts: { preserveScroll?: boolean } = {}): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    const doc = await ipc.readMarkdown(path);
    const anchor = opts.preserveScroll && currentDoc ? captureScrollAnchor(contentPane, article) : null;
    currentDoc = doc;

    await render(doc, article);
    emptyState.hidden = true;
    article.hidden = false;
    docTitle.textContent = fileName(doc.path);
    docTitle.title = doc.path;
    getCurrentWindow().setTitle(`${fileName(doc.path)} — Markdown Viewer`).catch(() => {});

    const headings = toc.build(article, tocList, contentPane);
    app.classList.toggle("no-headings", headings === 0);

    if (anchor) restoreScrollAnchor(contentPane, article, anchor);
    else contentPane.scrollTop = 0;

    renderMermaidIn(article, theme.current() === "dark").catch(() => {});
    search.onContentChanged();

    if (!browseRoot || !isInside(browseRoot, doc.dir)) browseRoot = doc.dir;
    refreshTree();
    ipc.watchFile(doc.path).catch(() => {});
  } catch (err) {
    showError(String(err));
  } finally {
    opening = false;
  }
}

function refreshTree(): void {
  if (!browseRoot) return;
  const root = browseRoot;
  btnUp.disabled = isDriveRoot(root);
  ipc
    .listTree(root)
    .then((node) => {
      treeRootName.textContent = node.name;
      treeRootName.title = root;
      tree.render(treeRoot, node, currentDoc?.path ?? "", (p) => openFile(p));
    })
    .catch(() => {
      treeRootName.textContent = "";
      treeRoot.replaceChildren();
    });
}

async function goUp(): Promise<void> {
  if (!browseRoot || isDriveRoot(browseRoot)) return;
  const parent = await ipc.parentDir(browseRoot).catch(() => null);
  if (parent) {
    browseRoot = parent;
    refreshTree();
  }
}

function showError(message: string): void {
  emptyState.hidden = true;
  article.hidden = false;
  article.replaceChildren();
  const card = document.createElement("div");
  card.className = "error-card";
  card.textContent = message;
  article.append(card);
}

function showEmpty(): void {
  article.hidden = true;
  emptyState.hidden = false;
}

async function chooseFile(): Promise<void> {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
  }).catch(() => null);
  if (typeof picked === "string") await openFile(picked);
}

function toggleSidebar(cls: "tree-hidden" | "toc-hidden"): void {
  app.classList.toggle(cls);
  localStorage.setItem(cls, app.classList.contains(cls) ? "1" : "0");
}

function wireUi(): void {
  if (localStorage.getItem("tree-hidden") === "1") app.classList.add("tree-hidden");
  if (localStorage.getItem("toc-hidden") === "1") app.classList.add("toc-hidden");

  $("#btn-tree").addEventListener("click", () => toggleSidebar("tree-hidden"));
  $("#btn-toc").addEventListener("click", () => toggleSidebar("toc-hidden"));
  $("#btn-theme").addEventListener("click", () => theme.toggle());
  $("#btn-open").addEventListener("click", chooseFile);
  $("#btn-open-empty").addEventListener("click", chooseFile);
  $("#btn-help").addEventListener("click", () => helpDialog.showModal());
  $("#help-close").addEventListener("click", () => helpDialog.close());
  btnUp.addEventListener("click", goUp);

  // click outside the dialog body closes it
  helpDialog.addEventListener("click", (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });

  search.init({
    root: article,
    pane: contentPane,
    bar: $("#find-bar"),
    input: $("#find-input"),
    counter: $("#find-count"),
    btnPrev: $("#find-prev"),
    btnNext: $("#find-next"),
    btnClose: $("#find-close"),
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "F1") {
      e.preventDefault();
      if (helpDialog.open) helpDialog.close();
      else helpDialog.showModal();
      return;
    }
    if (helpDialog.open) return; // Esc is handled natively by <dialog>
    if (e.ctrlKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      search.open();
    } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      chooseFile();
    } else if (e.ctrlKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      toggleSidebar("tree-hidden");
    } else if (e.ctrlKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      toggleSidebar("toc-hidden");
    }
  });

  // in-article links: hash → in-page scroll, web → default browser, .md → open in viewer
  article.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    e.preventDefault();
    if (href.startsWith("#")) {
      document
        .getElementById(decodeURIComponent(href.slice(1)))
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (/^https?:/i.test(href)) {
      openUrl(href).catch(() => {});
    } else if (isMarkdownPath(href) && currentDoc) {
      ipc
        .resolvePath(currentDoc.dir, decodeURIComponent(href))
        .then((p) => openFile(p))
        .catch(() => {});
    }
  });
}

async function boot(): Promise<void> {
  theme.init();
  theme.onChange((t) => rerenderForTheme(article, t === "dark").catch(() => {}));
  wireUi();

  // listeners must be live before get_initial_file, or a double-click
  // arriving during startup would be lost
  await ipc.onOpenFile((p) => openFile(p));
  await ipc.onFileChanged(() => {
    if (currentDoc) openFile(currentDoc.path, { preserveScroll: true });
  });
  await getCurrentWebview().onDragDropEvent((event) => {
    const type = event.payload.type;
    if (type === "enter") app.classList.add("dropping");
    else if (type === "leave") app.classList.remove("dropping");
    else if (type === "drop") {
      app.classList.remove("dropping");
      const path = event.payload.paths.find(isMarkdownPath);
      if (path) openFile(path);
    }
  });

  const initial = await ipc.getInitialFile().catch(() => null);
  if (initial) await openFile(initial);
  else showEmpty();

  await ipc.showWindow().catch(() => {});
}

boot();
