import "./styles/base.css";
import "./styles/layout.css";
import "./styles/markdown.css";
import "./styles/code.css";
import "./styles/ui.css";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import * as ipc from "./ipc";
import { render, renderFragment } from "./renderer";
import { renderMermaidIn, rerenderForTheme } from "./mermaid";
import * as toc from "./toc";
import * as tree from "./tree";
import * as search from "./search";
import * as theme from "./theme";
import { captureScrollAnchor, restoreScrollAnchor } from "./state";
import { isInside, samePath } from "./paths";

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
const dirtyDot = $("#dirty-dot");
const helpDialog = $<HTMLDialogElement>("#help-dialog");
const editorPane = $("#editor-pane");
const btnEdit = $<HTMLButtonElement>("#btn-edit");
const btnSave = $<HTMLButtonElement>("#btn-save");
const noticeBar = $("#notice-bar");
const noticeMsg = $("#notice-msg");
const noticeAction = $<HTMLButtonElement>("#notice-action");

let currentDoc: ipc.MarkdownDoc | null = null;
// Root of the file browser. It survives navigation *within* itself, so opening a
// file from a subfolder does not make the rest of the tree disappear.
let browseRoot: string | null = null;
let opening = false;

let editing = false;
let editorMod: typeof import("./editor") | null = null;
let previewGen = 0;
let previewTimer: number | undefined;
// ignore the watcher echo of our own save for a short window
let suppressReloadUntil = 0;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const isMarkdownPath = (p: string) => /\.(md|markdown)$/i.test(p);
const isDriveRoot = (p: string) => /^[a-z]:[\\/]?$/i.test(p);

async function openFile(path: string, opts: { preserveScroll?: boolean } = {}): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    if (editing && editorMod?.isDirty() && currentDoc && !samePath(path, currentDoc.path)) {
      if (!(await confirmDiscard())) return;
    }
    const doc = await ipc.readMarkdown(path);
    const anchor = opts.preserveScroll && currentDoc ? captureScrollAnchor(contentPane, article) : null;
    const prevPath = currentDoc?.path ?? null;
    currentDoc = doc;

    if (editing && prevPath !== null && !samePath(prevPath, doc.path)) exitEditMode();

    await render(doc, article);
    emptyState.hidden = true;
    article.hidden = false;
    if (!opts.preserveScroll) {
      article.classList.remove("doc-enter");
      void article.offsetWidth; // restart the entrance animation
      article.classList.add("doc-enter");
    }
    updateTitles();

    const headings = toc.build(article, tocList, contentPane);
    app.classList.toggle("no-headings", headings === 0);

    if (anchor) restoreScrollAnchor(contentPane, article, anchor);
    else contentPane.scrollTop = 0;

    renderMermaidIn(article, theme.current() === "dark").catch(() => {});
    search.onContentChanged();

    const rootChanged = !browseRoot || !isInside(browseRoot, doc.dir);
    if (rootChanged) browseRoot = doc.dir;
    // Same-root selection just moves the highlight: a rebuild would discard the
    // user's collapsed folders and flicker. Same-document reopens (watcher
    // reloads) still rebuild so files added or removed on disk get picked up.
    const sameDoc = prevPath !== null && samePath(prevPath, doc.path);
    if (rootChanged || sameDoc || !tree.setActive(treeRoot, doc.path)) refreshTree();
    ipc.watchFile(doc.path).catch(() => {});
  } catch (err) {
    showError(String(err));
  } finally {
    opening = false;
  }
}

function updateTitles(): void {
  const dirty = editorMod?.isDirty() ?? false;
  dirtyDot.hidden = !dirty;
  btnSave.disabled = !dirty;
  if (currentDoc) {
    docTitle.textContent = fileName(currentDoc.path);
    docTitle.title = currentDoc.path;
    getCurrentWindow()
      .setTitle(`${dirty ? "• " : ""}${fileName(currentDoc.path)} — Markdown Studio`)
      .catch(() => {});
  }
}

/* ---- edit mode ---- */

async function toggleEditMode(): Promise<void> {
  if (!editing) {
    await enterEditMode();
    return;
  }
  if (editorMod?.isDirty()) {
    if (!(await confirmDiscard())) return;
    // restore the saved document in the article before leaving the split view
    if (currentDoc) await openFile(currentDoc.path, { preserveScroll: true });
  }
  exitEditMode();
}

async function enterEditMode(): Promise<void> {
  if (editing || !currentDoc) return;
  editorMod ??= await import("./editor");
  editorMod.mount(editorPane, {
    onDocChanged: schedulePreview,
    onDirtyChanged: () => updateTitles(),
    onScroll: scheduleSyncPreview,
    requestSave: () => {
      saveFile();
    },
  });
  syncSuppressedUntil = performance.now() + 200;
  editorMod.setContent(currentDoc.content);
  editing = true;
  app.classList.add("editing");
  btnEdit.setAttribute("aria-pressed", "true");
  updateTitles();
  editorMod.focus();

  // open the editor at the section being read: first anchor visible in the preview
  collectPreviewAnchors();
  const paneTop = contentPane.getBoundingClientRect().top;
  const first = previewAnchors.find((a) => a.el.getBoundingClientRect().top - paneTop >= -1);
  if (first && first.line > 0) editorMod.scrollToLine(first.line);
}

function exitEditMode(): void {
  if (!editing) return;
  editing = false;
  app.classList.remove("editing");
  btnEdit.setAttribute("aria-pressed", "false");
  // reset the buffer to the saved document: clears dirty state and undo history
  if (currentDoc) editorMod?.setContent(currentDoc.content);
  updateTitles();
}

const confirmDiscard = (): Promise<boolean> =>
  ask("You have unsaved changes. Discard them?", {
    title: "Unsaved changes",
    kind: "warning",
  }).catch(() => false);

/* ---- live preview ---- */

function schedulePreview(): void {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    if (editorMod) updatePreview(editorMod.currentText());
  }, 200);
}

async function updatePreview(content: string): Promise<void> {
  if (!currentDoc) return;
  const gen = ++previewGen;
  try {
    // all fallible work happens before the DOM commit; on error the previous
    // preview stays on screen and only the notice strip appears
    const staging = await renderFragment({ ...currentDoc, content });
    if (gen !== previewGen) return; // a newer render superseded this one

    // reuse already-rendered mermaid SVGs so untouched diagrams don't flicker
    const mmdCache = new Map<string, string>();
    for (const h of article.querySelectorAll<HTMLElement>(".mermaid-diagram[data-mmd-source]")) {
      mmdCache.set(h.dataset.mmdSource ?? "", h.innerHTML);
    }

    // in edit mode the editor viewport is the source of truth for the preview
    // position; the heading anchor only serves the non-editing path
    const anchor = editing ? null : captureScrollAnchor(contentPane, article);
    article.replaceChildren(...staging.childNodes);
    for (const code of article.querySelectorAll<HTMLElement>("pre > code.language-mermaid")) {
      const source = code.textContent ?? "";
      const cached = mmdCache.get(source);
      if (cached === undefined) continue;
      const holder = document.createElement("div");
      holder.className = "mermaid-diagram";
      holder.innerHTML = cached;
      holder.dataset.mmdSource = source;
      if (code.dataset.sourceLine) holder.dataset.sourceLine = code.dataset.sourceLine;
      (code.parentElement as HTMLPreElement).replaceWith(holder);
    }
    collectPreviewAnchors();
    if (anchor) restoreScrollAnchor(contentPane, article, anchor);
    else syncPreviewToEditor();

    const headings = toc.build(article, tocList, contentPane);
    app.classList.toggle("no-headings", headings === 0);
    search.onContentChanged();
    hideNotice();
    renderMermaidIn(article, theme.current() === "dark")
      .then(() => {
        // freshly rendered diagrams change heights: re-anchor and re-align
        collectPreviewAnchors();
        scheduleSyncPreview();
      })
      .catch((err) => showNotice(`Diagram rendering failed: ${err}`));
  } catch (err) {
    if (gen === previewGen) showNotice(`Preview error: ${err}`);
  }
}

/* ---- editor→preview scroll sync ---- */

const SYNC_MARGIN = 16;
let previewAnchors: { line: number; el: HTMLElement }[] = [];
let syncRaf = 0;
// brief window around edit-mode entry: CM's async scroll settling (setContent
// reset + scrollIntoView) fires scroll events that must not move the preview
let syncSuppressedUntil = 0;

function collectPreviewAnchors(): void {
  previewAnchors = [];
  let last = -1;
  for (const el of article.querySelectorAll<HTMLElement>("[data-source-line]")) {
    const line = Number(el.dataset.sourceLine);
    if (!Number.isFinite(line) || line <= last) continue; // keep the outermost element per line
    previewAnchors.push({ line, el });
    last = line;
  }
}

function scheduleSyncPreview(): void {
  if (!syncRaf) {
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0;
      syncPreviewToEditor();
    });
  }
}

function syncPreviewToEditor(retry = true): void {
  if (!editing || !editorMod || previewAnchors.length === 0) return;
  if (performance.now() < syncSuppressedUntil) return;
  const line = editorMod.topVisibleLine();

  // binary search: lo = last anchor with .line <= line
  let lo = -1;
  let hi = previewAnchors.length;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (previewAnchors[mid].line <= line) lo = mid;
    else hi = mid;
  }
  const a1 = lo >= 0 ? previewAnchors[lo] : null;
  const a2 = hi < previewAnchors.length ? previewAnchors[hi] : null;
  if ((a1 && !a1.el.isConnected) || (a2 && !a2.el.isConnected)) {
    // the mermaid pass detached an anchor mid-flight; recollect once
    if (retry) {
      collectPreviewAnchors();
      syncPreviewToEditor(false);
    }
    return;
  }

  const paneTop = contentPane.getBoundingClientRect().top;
  const yOf = (el: HTMLElement) => el.getBoundingClientRect().top - paneTop + contentPane.scrollTop;
  const l1 = a1 ? a1.line : 0;
  const y1 = a1 ? yOf(a1.el) : yOf(article);
  const l2 = a2 ? a2.line : editorMod.lineCount();
  const y2 = a2
    ? yOf(a2.el)
    : article.getBoundingClientRect().bottom - paneTop + contentPane.scrollTop;
  const t = l2 > l1 ? (line - l1) / (l2 - l1) : 0;
  contentPane.scrollTop = Math.max(0, y1 + t * (y2 - y1) - SYNC_MARGIN);
}

/* ---- saving ---- */

async function saveFile(): Promise<void> {
  if (!editing || !currentDoc || !editorMod?.isDirty()) return;
  const content = editorMod.getContent();
  suppressReloadUntil = Date.now() + 1500;
  try {
    await ipc.writeMarkdown(currentDoc.path, content);
    currentDoc = { ...currentDoc, content };
    editorMod.markSaved();
    hideNotice(true);
  } catch (err) {
    showNotice(`Save failed: ${err}`);
  }
}

async function reloadFromDisk(): Promise<void> {
  if (!currentDoc) return;
  try {
    const doc = await ipc.readMarkdown(currentDoc.path);
    currentDoc = doc;
    editorMod?.setContent(doc.content);
    await updatePreview(doc.content);
    hideNotice(true);
  } catch (err) {
    showNotice(`Reload failed: ${err}`);
  }
}

/* ---- notice bar ---- */

let noticeActionFn: (() => void) | null = null;
let noticeSticky = false;

function showNotice(
  message: string,
  opts: { action?: { label: string; fn: () => void }; sticky?: boolean } = {},
): void {
  noticeMsg.textContent = message;
  noticeMsg.title = message;
  if (opts.action) {
    noticeAction.textContent = opts.action.label;
    noticeAction.hidden = false;
    noticeActionFn = opts.action.fn;
  } else {
    noticeAction.hidden = true;
    noticeActionFn = null;
  }
  noticeSticky = opts.sticky ?? false;
  noticeBar.hidden = false;
}

// sticky notices (external file change) survive routine preview refreshes
function hideNotice(force = false): void {
  if (noticeSticky && !force) return;
  noticeBar.hidden = true;
  noticeSticky = false;
  noticeActionFn = null;
}

/* ---- file browser ---- */

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
  btnEdit.addEventListener("click", () => toggleEditMode());
  btnSave.addEventListener("click", () => saveFile());
  $("#btn-help").addEventListener("click", () => helpDialog.showModal());
  $("#help-close").addEventListener("click", () => helpDialog.close());
  btnUp.addEventListener("click", goUp);
  noticeAction.addEventListener("click", () => noticeActionFn?.());
  $("#notice-close").addEventListener("click", () => hideNotice(true));

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
    } else if (e.ctrlKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggleEditMode();
    } else if (e.ctrlKey && e.key.toLowerCase() === "s") {
      // always swallow it: WebView2 would otherwise open its save-page dialog
      e.preventDefault();
      saveFile();
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

async function showVersion(): Promise<void> {
  const v = `v${await getVersion()}`;
  for (const el of document.querySelectorAll("#help-version, #empty-version")) el.textContent = v;
}

async function boot(): Promise<void> {
  theme.init();
  showVersion().catch(() => {});
  theme.onChange((t) => rerenderForTheme(article, t === "dark").catch(() => {}));
  wireUi();

  // registering this handler makes JS responsible for closing the window,
  // which needs the core:window:allow-destroy capability
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (editorMod?.isDirty() && !(await confirmDiscard())) e.preventDefault();
  });

  // listeners must be live before get_initial_file, or a double-click
  // arriving during startup would be lost
  await ipc.onOpenFile((p) => openFile(p));
  await ipc.onFileChanged(() => {
    if (!currentDoc) return;
    if (Date.now() < suppressReloadUntil) return; // echo of our own save
    if (editing && editorMod?.isDirty()) {
      // never clobber a dirty buffer
      showNotice("File changed on disk. Saving will overwrite it.", {
        action: {
          label: "Reload",
          fn: () => {
            reloadFromDisk();
          },
        },
        sticky: true,
      });
      return;
    }
    if (editing) reloadFromDisk();
    else openFile(currentDoc.path, { preserveScroll: true });
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
