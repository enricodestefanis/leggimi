import "./styles/base.css";
import "./styles/layout.css";
import "./styles/markdown.css";
import "./styles/code.css";
import "./styles/ui.css";
import "./styles/lightbox.css";
import "./styles/print.css";
import "katex/dist/katex.min.css";

import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import * as ipc from "./ipc";
import { render, renderFragment } from "./renderer";
import { renderMermaidIn, rerenderForTheme } from "./mermaid";
import * as toc from "./toc";
import * as tree from "./tree";
import * as search from "./search";
import * as lightbox from "./lightbox";
import * as panes from "./panes";
import * as theme from "./theme";
import * as prefs from "./prefs";
import * as positions from "./positions";
import * as recents from "./recents";
import * as rating from "./rating";
import * as drafts from "./drafts";
import * as i18n from "./i18n";
import { t } from "./i18n";
import { captureScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from "./state";
import { isInside, samePath } from "./paths";
import { buildDocxBase64, buildStandaloneHtml, copyAsRichText, copySelectionAsRichText } from "./share";

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector(sel) as T;

const app = $("#app");
const shell = $("#shell");
const contentPane = $("#content-pane");
const treePane = $("#tree-pane");
const tocPane = $("#toc-pane");
const article = $("#article");
const emptyState = $("#empty-state");
const treeRoot = $("#tree-root");
const treeRootName = $("#tree-rootname");
const treeSearch = $<HTMLInputElement>("#tree-search");
const treeSearchClear = $<HTMLButtonElement>("#tree-search-clear");
const searchResults = $("#search-results");
const btnUp = $<HTMLButtonElement>("#btn-up");
const tocList = $("#toc-list");
const docTitle = $("#doc-title");
const docMeta = $("#doc-meta");
const dirtyDot = $("#dirty-dot");
const readProgress = $("#read-progress");
const helpDialog = $<HTMLDialogElement>("#help-dialog");
const keysDialog = $<HTMLDialogElement>("#keys-dialog");
const tocFilterWrap = $("#toc-filter-wrap");
const tocFilter = $<HTMLInputElement>("#toc-filter");
const tocFilterClear = $<HTMLButtonElement>("#toc-filter-clear");
const recentSection = $("#recent-section");
const recentList = $("#recent-list");
const rateToast = $("#rate-toast");
const btnPin = $<HTMLButtonElement>("#btn-pin");
const fileMenu = $("#file-menu");
const zoomDialog = $<HTMLDialogElement>("#zoom-dialog");
const zoomHint = $<HTMLButtonElement>("#zoom-hint");
const editorPane = $("#editor-pane");
const btnEdit = $<HTMLButtonElement>("#btn-edit");
const btnSave = $<HTMLButtonElement>("#btn-save");
const btnShare = $<HTMLButtonElement>("#btn-share");
const shareMenu = $("#share-menu");
const btnReading = $<HTMLButtonElement>("#btn-reading");
const readingMenu = $("#reading-menu");
const rsSizeValue = $("#rs-size-value");
const rsSizeDec = $<HTMLButtonElement>("#rs-size-dec");
const rsSizeInc = $<HTMLButtonElement>("#rs-size-inc");
const noticeBar = $("#notice-bar");
const noticeMsg = $("#notice-msg");
const noticeAction = $<HTMLButtonElement>("#notice-action");

let currentDoc: ipc.MarkdownDoc | null = null;
// Root of the file browser. It survives navigation *within* itself, so opening a
// file from a subfolder does not make the rest of the tree disappear.
let browseRoot: string | null = null;
let opening = false;

let editing = false;
let storeInstall = false;
let editorMod: typeof import("./editor") | null = null;
let previewGen = 0;
let previewTimer: number | undefined;
// ignore the watcher echo of our own save for a short window
let suppressReloadUntil = 0;

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
// keep in sync with MD_EXTS in src-tauri/src/commands.rs
const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "markdn", "mdtxt"];
const MD_EXT_RE = new RegExp(`\\.(${MD_EXTENSIONS.join("|")})$`, "i");
const isMarkdownPath = (p: string) => MD_EXT_RE.test(p);
const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p);
const isDriveRoot = (p: string) => /^[a-z]:[\\/]?$/i.test(p);

interface OpenOptions {
  preserveScroll?: boolean;
  /** heading id to show at the top (a `file.md#section` link) */
  anchor?: string;
  /** 1-based source line to show at the top (`--line N`) */
  line?: number;
}

async function openFile(path: string, opts: OpenOptions = {}): Promise<void> {
  if (opening) return;
  opening = true;
  try {
    if (editing && editorMod?.isDirty() && currentDoc && !samePath(path, currentDoc.path)) {
      if (!(await confirmDiscard())) return;
    }
    const doc = await ipc.readMarkdown(path);
    const prevPath = currentDoc?.path ?? null;
    const sameDoc = prevPath !== null && samePath(prevPath, doc.path);
    // reopening the document already on screen (a reload, or the same file
    // double-clicked again) keeps the place being read
    const anchor =
      (opts.preserveScroll || sameDoc) && currentDoc && !article.hidden
        ? captureScrollAnchor(contentPane, article)
        : null;
    // leaving a document: keep its reading position before it goes
    if (currentDoc && !sameDoc && !editing && !article.hidden) {
      positions.remember(currentDoc.path, captureScrollAnchor(contentPane, article));
    }
    currentDoc = doc;

    if (editing && prevPath !== null && !samePath(prevPath, doc.path)) exitEditMode();

    await render(doc, article);
    lightbox.markAll(article);
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
    setupTocFilter(headings, sameDoc);
    panes.refresh();
    updateDocMeta();

    const target = anchor ?? (sameDoc ? null : positions.recall(doc.path));
    // an explicit destination (link anchor, --line) beats the remembered place
    const jump = (): boolean =>
      opts.anchor !== undefined ? scrollToId(opts.anchor) : opts.line !== undefined ? scrollToSourceLine(opts.line - 1) : false;
    if (!jump() && !restoreRemembered(target)) contentPane.scrollTop = 0;
    updateProgress();
    const applied = contentPane.scrollTop;

    renderMermaidIn(article, theme.isDark())
      .then(() => {
        lightbox.markAll(article);
        // diagrams change the heights above the anchor: re-apply it, unless
        // the reader has already moved on
        if (currentDoc === doc && contentPane.scrollTop === applied && !jump() && target) restoreRemembered(target);
        updateProgress();
      })
      .catch(() => {});
    if (!sameDoc) offerDraft(doc);
    search.onContentChanged();

    const rootChanged = !browseRoot || !isInside(browseRoot, doc.dir);
    if (rootChanged) browseRoot = doc.dir;
    // Same-root selection just moves the highlight: a rebuild would discard the
    // user's collapsed folders and flicker. Same-document reopens (watcher
    // reloads) still rebuild so files added or removed on disk get picked up.
    if (rootChanged || sameDoc || !tree.setActive(treeRoot, doc.path)) refreshTree();
    ipc.watchFile(doc.path).catch(() => {});
    if (!sameDoc) {
      recents.push(doc);
      rating.noteOpen();
      scheduleRatePrompt();
    }
  } catch (err) {
    recents.remove(path); // a vanished file must not keep its place on the home
    showError(String(err));
  } finally {
    opening = false;
  }
}

function updateTitles(): void {
  const dirty = editorMod?.isDirty() ?? false;
  dirtyDot.hidden = !dirty;
  btnSave.disabled = !dirty;
  btnShare.disabled = currentDoc === null;
  if (currentDoc) {
    docTitle.textContent = fileName(currentDoc.path);
    docTitle.title = currentDoc.path;
    getCurrentWindow()
      .setTitle(`${dirty ? "• " : ""}${t("toolbar.windowTitle", { name: fileName(currentDoc.path) })}`)
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
  try {
    editorMod ??= await import("./editor");
  } catch (err) {
    // the editor chunk loads on first use; say so instead of silently doing nothing
    showNotice(t("msg.editorLoadFailed", { err: String(err) }));
    return;
  }
  editorMod.mount(editorPane, {
    onDocChanged: () => {
      schedulePreview();
      scheduleDraft();
    },
    onDirtyChanged: () => updateTitles(),
    onScroll: () => scheduleSyncPreview(),
    onCaretMoved: () => {
      // moving the caret is a request to see that spot: reveal it now, and
      // through the editor scroll the move may cause right after
      revealUntil = Math.max(revealUntil, performance.now() + 300);
      scheduleSyncPreview(true);
    },
    requestSave: () => {
      saveFile();
    },
    onImagePasted: (file) => {
      insertPastedImage(file);
    },
  });
  syncSuppressedUntil = performance.now() + 200;
  editorMod.setContent(currentDoc.content);
  editing = true;
  // the reading find bar searches the preview; while editing, Ctrl+F and F3
  // belong to the editor's panel, so close the bar instead of showing both
  search.close();
  app.classList.add("editing");
  btnEdit.setAttribute("aria-pressed", "true");
  updateTitles();
  updateProgress();
  hideRateToast();
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
  updateProgress();
}

/* ---- images into the editor ---- */

const IMAGE_EXT_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/avif": "avif",
};

async function insertPastedImage(file: File): Promise<void> {
  if (!editing || !currentDoc || !editorMod) return;
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const rel = await ipc.saveClipboardImage(
      currentDoc.dir,
      base64,
      IMAGE_EXT_BY_MIME[file.type] ?? "png",
    );
    editorMod.insertAtCursor(`![](${encodeURI(rel)})`);
  } catch (err) {
    showNotice(t("msg.imagePasteFailed", { err: String(err) }));
  }
}

async function insertDroppedImage(path: string): Promise<void> {
  if (!editing || !currentDoc || !editorMod) return;
  try {
    const rel = await ipc.importImage(currentDoc.dir, path);
    editorMod.insertAtCursor(`![](${encodeURI(rel)})`);
  } catch (err) {
    showNotice(t("msg.imageDropFailed", { err: String(err) }));
  }
}

const confirmDiscard = async (): Promise<boolean> => {
  const ok = await ask(t("msg.discardQ"), {
    title: t("msg.discardTitle"),
    kind: "warning",
  }).catch(() => false);
  // a deliberate discard also drops the recovery draft of that buffer
  if (ok && currentDoc) drafts.remove(currentDoc.path);
  return ok;
};

/* ---- recovery drafts ---- */

let draftTimer: number | undefined;

// while the buffer is dirty its text is parked in localStorage (1 s after the
// last keystroke); a clean buffer removes the draft
function scheduleDraft(): void {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(() => {
    if (!currentDoc || !editorMod) return;
    if (editing && editorMod.isDirty()) {
      drafts.put(currentDoc.path, editorMod.currentText(), currentDoc.content.replace(/\r\n/g, "\n"));
    } else {
      drafts.remove(currentDoc.path);
    }
  }, 1000);
}

// a draft left by a crash or a killed process is offered, never applied
function offerDraft(doc: ipc.MarkdownDoc): void {
  const draft = drafts.get(doc.path);
  if (!draft) return;
  if (draft.text === doc.content.replace(/\r\n/g, "\n")) {
    drafts.remove(doc.path);
    return;
  }
  showNotice(t("msg.draftRecovered"), {
    sticky: true,
    action: {
      label: t("msg.restore"),
      fn: () => {
        if (currentDoc !== doc) return;
        hideNotice(true);
        enterEditMode()
          .then(() => {
            if (currentDoc === doc) editorMod?.loadDraft(draft.text);
          })
          .catch(() => {});
      },
    },
    onDismiss: () => drafts.remove(doc.path),
  });
}

/* ---- live preview ---- */

function schedulePreview(): void {
  revealUntil = performance.now() + 1000;
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
    lightbox.markAll(article);
    if (anchor) restoreScrollAnchor(contentPane, article, anchor);
    else syncPreviewToEditor(true);

    const headings = toc.build(article, tocList, contentPane);
    app.classList.toggle("no-headings", headings === 0);
    setupTocFilter(headings, true);
    panes.refresh();
    updateDocMeta();
    search.onContentChanged();
    hideNotice();
    renderMermaidIn(article, theme.isDark())
      .then(() => {
        // freshly rendered diagrams change heights: re-anchor and re-align
        lightbox.markAll(article);
        collectPreviewAnchors();
        scheduleSyncPreview(true);
      })
      .catch((err) => showNotice(t("msg.diagramFailed", { err: String(err) })));
  } catch (err) {
    if (gen === previewGen) showNotice(t("msg.previewError", { err: String(err) }));
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

// `reveal` (after an edit or a caret move) also keeps the caret's block in
// view in the preview. The editor scrolls that follow them (typing at the
// bottom, arrowing past the edge) keep revealing until `revealUntil`.
let syncReveal = false;
let revealUntil = 0;
function scheduleSyncPreview(reveal = false): void {
  syncReveal ||= reveal || performance.now() < revealUntil;
  if (!syncRaf) {
    syncRaf = requestAnimationFrame(() => {
      syncRaf = 0;
      const r = syncReveal;
      syncReveal = false;
      syncPreviewToEditor(r);
    });
  }
}

// The anchors around a 0-based source line, as preview y (content
// coordinates): the block holding the line spans [y1, y2). null: an anchor
// was detached.
interface AnchorSpan {
  l1: number;
  y1: number;
  l2: number;
  y2: number;
  /** the anchor element opening the span, when there is one */
  el: HTMLElement | null;
}

function anchorSpan(line: number): AnchorSpan | null {
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
  if ((a1 && !a1.el.isConnected) || (a2 && !a2.el.isConnected)) return null;

  const paneTop = contentPane.getBoundingClientRect().top;
  const yOf = (el: HTMLElement) => el.getBoundingClientRect().top - paneTop + contentPane.scrollTop;
  return {
    l1: a1 ? a1.line : 0,
    y1: a1 ? yOf(a1.el) : yOf(article),
    l2: a2 ? a2.line : editorMod!.lineCount(),
    y2: a2 ? yOf(a2.el) : article.getBoundingClientRect().bottom - paneTop + contentPane.scrollTop,
    el: a1 ? a1.el : null,
  };
}

// Preview y of a fractional source line, interpolated inside its block.
function yInSpan(span: AnchorSpan, line: number): number {
  const t = span.l2 > span.l1 ? Math.min(1, Math.max(0, (line - span.l1) / (span.l2 - span.l1))) : 0;
  return span.y1 + t * (span.y2 - span.y1);
}

function syncPreviewToEditor(reveal = false, retry = true): void {
  if (!editing || !editorMod || previewAnchors.length === 0) return;
  if (performance.now() < syncSuppressedUntil) return;

  const topLine = editorMod.topVisibleLine();
  const topSpan = anchorSpan(topLine);
  const caret = reveal ? editorMod.visibleCaretLine() : null;
  const caretSpan = caret === null ? null : anchorSpan(caret);
  if (!topSpan || (caret !== null && !caretSpan)) {
    // the mermaid pass detached an anchor mid-flight; recollect once
    if (retry) {
      collectPreviewAnchors();
      syncPreviewToEditor(reveal, false);
    }
    return;
  }

  const view = contentPane.clientHeight;
  const max = contentPane.scrollHeight - view;
  // The editor scrolls past its end, so its top line can reach the last one
  // and the preview's end stays reachable through the plain line mapping.
  // An editor at its very top shows the preview from its very top too.
  let target = editorMod.isAtTop() ? 0 : yInSpan(topSpan, topLine) - SYNC_MARGIN;
  // After an edit or a caret move, what holds the caret must be in view: the
  // whole top-level block when it fits (a table, a formula, a short list),
  // else the innermost anchored part (a row, a list item), else the caret's
  // estimated line inside it.
  if (caret !== null && caretSpan) {
    const pad = SYNC_MARGIN * 3;
    const room = view - pad - SYNC_MARGIN;
    let caretTop = yInSpan(caretSpan, caret);
    let caretBottom = yInSpan(caretSpan, caret + 1);
    let outer = caretSpan.el;
    while (outer && outer.parentElement && outer.parentElement !== article) outer = outer.parentElement;
    const outerRect = outer?.parentElement === article ? outer.getBoundingClientRect() : null;
    const paneTop = contentPane.getBoundingClientRect().top - contentPane.scrollTop;
    if (outerRect && outerRect.height <= room) {
      caretTop = outerRect.top - paneTop;
      caretBottom = outerRect.bottom - paneTop;
    } else if (caretSpan.y2 - caretSpan.y1 <= room) {
      caretTop = caretSpan.y1;
      caretBottom = caretSpan.y2;
    }
    if (caretBottom > target + view - pad) target = caretBottom - view + pad;
    if (caretTop < target + SYNC_MARGIN) target = caretTop - SYNC_MARGIN;
  }
  contentPane.scrollTop = Math.max(0, Math.min(max, target));
}

/* ---- saving ---- */

// Writes `content` to the document's file, guarding against a file that
// changed on disk since it was read. null: the user kept the other version.
async function writeDocument(doc: ipc.MarkdownDoc, content: string): Promise<number | null> {
  suppressReloadUntil = Date.now() + 1500;
  try {
    return await ipc.writeMarkdown(doc.path, content, doc.modified);
  } catch (err) {
    if (String(err) !== ipc.WRITE_CONFLICT) throw err;
    // someone else wrote the file since it was read: overwrite only on request
    const overwrite = await ask(t("msg.conflictQ"), {
      title: t("msg.conflictTitle"),
      kind: "warning",
      okLabel: t("msg.overwrite"),
      cancelLabel: t("msg.keepTheirs"),
    }).catch(() => false);
    if (!overwrite) return null;
    suppressReloadUntil = Date.now() + 1500;
    return ipc.writeMarkdown(doc.path, content, null);
  }
}

async function saveFile(): Promise<void> {
  if (!editing || !currentDoc || !editorMod?.isDirty()) return;
  const content = editorMod.getContent();
  const doc = currentDoc;
  try {
    const modified = await writeDocument(doc, content);
    if (modified === null) return;
    if (currentDoc !== doc) return; // another document took over meanwhile
    currentDoc = { ...doc, content, modified };
    editorMod.markSaved();
    drafts.remove(doc.path);
    hideNotice(true);
  } catch (err) {
    showNotice(t("msg.saveFailed", { err: String(err) }));
  }
}

/* ---- task-list checkboxes in the preview ---- */

const TASK_MARK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/;

// The box already toggled natively; mirror it in the source line. In edit
// mode that edits the buffer; while reading it writes the file right away,
// the one deliberate exception to "the file only changes on Ctrl+S".
async function onTaskToggle(box: HTMLInputElement): Promise<void> {
  const li = box.closest<HTMLElement>("li[data-source-line]");
  const line = Number(li?.dataset.sourceLine);
  if (!currentDoc || !li || !Number.isFinite(line)) return;
  const doc = currentDoc;
  const eol = doc.content.includes("\r\n") ? "\r\n" : "\n";
  const source = editing && editorMod ? editorMod.currentText() : doc.content;
  const lines = source.split(/\r?\n/);
  const old = lines[line] ?? "";
  const next = old.replace(TASK_MARK_RE, (_m, pre: string, _mark: string, post: string) => `${pre}${box.checked ? "x" : " "}${post}`);
  if (next === old) return;
  if (editing && editorMod) {
    editorMod.replaceLine(line, next);
    return;
  }
  lines[line] = next;
  const content = lines.join(eol);
  try {
    const modified = await writeDocument(doc, content);
    if (modified === null || currentDoc !== doc) {
      box.checked = !box.checked;
      return;
    }
    currentDoc = { ...doc, content, modified };
    const before = doc.content;
    showNotice(t(box.checked ? "msg.taskChecked" : "msg.taskUnchecked"), {
      action: {
        label: t("msg.undo"),
        fn: () => {
          if (!currentDoc || !samePath(currentDoc.path, doc.path)) return;
          const cur = currentDoc;
          writeDocument(cur, before)
            .then((m) => {
              if (m === null || currentDoc !== cur) return;
              currentDoc = { ...cur, content: before, modified: m };
              box.checked = !box.checked;
              hideNotice(true);
            })
            .catch((err) => showNotice(t("msg.undoFailed", { err: String(err) })));
        },
      },
    });
  } catch (err) {
    box.checked = !box.checked;
    showNotice(t("msg.taskUpdateFailed", { err: String(err) }));
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
    showNotice(t("msg.reloadFailed", { err: String(err) }));
  }
}

/* ---- sharing: rich-text copy, print, HTML export ---- */

const BTN_CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

function flashDone(btn: HTMLButtonElement): void {
  const original = btn.innerHTML;
  btn.innerHTML = BTN_CHECK_ICON;
  setTimeout(() => (btn.innerHTML = original), 1200);
}

async function copyDocAsRichText(): Promise<void> {
  if (!currentDoc) return;
  try {
    // the plain-text flavor is the markdown source; in edit mode that means
    // the unsaved buffer, which is what the preview (and the eye) shows
    const plain = editing && editorMod ? editorMod.currentText() : currentDoc.content;
    await copyAsRichText(article, currentDoc.dir, plain);
    flashDone(btnShare);
  } catch (err) {
    showNotice(t("msg.copyFailed", { err: String(err) }));
  }
}

/* ---- printing and PDF ---- */

const cssString = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\s+/g, " ")}"`;

// The page header carries the document title and the date. CSS cannot read
// them from the page (string-set is unimplemented), so they are injected as
// a literal @page rule for the duration of the print.
function setPrintMeta(): () => void {
  if (!currentDoc) return () => {};
  const h1 = article.querySelector("h1")?.textContent?.trim();
  const title = h1 || fileName(currentDoc.path).replace(MD_EXT_RE, "");
  const date = i18n.fmtDate(new Date(), { dateStyle: "medium" });
  const style = document.createElement("style");
  style.id = "print-page-meta";
  style.textContent = `@media print { @page { @top-center { content: ${cssString(`${title}  ·  ${date}`)}; } } }`;
  document.head.append(style);
  return () => style.remove();
}

// paper is always light: the chrome, and the diagrams too
let printThemeRestore: [string, string] | undefined;
async function enterPrintTheme(): Promise<void> {
  if (printThemeRestore) return;
  const ds = document.documentElement.dataset;
  printThemeRestore = [ds.theme ?? "light", ds.scheme ?? "light"];
  ds.theme = "light";
  ds.scheme = "light";
  if (printThemeRestore[1] === "dark") await rerenderForTheme(article, false).catch(() => {});
}
function leavePrintTheme(): void {
  if (!printThemeRestore) return;
  const ds = document.documentElement.dataset;
  [ds.theme, ds.scheme] = printThemeRestore;
  const wasDark = printThemeRestore[1] === "dark";
  printThemeRestore = undefined;
  if (wasDark) rerenderForTheme(article, true).catch(() => {});
}

async function printDoc(): Promise<void> {
  if (!currentDoc) return;
  const clear = setPrintMeta();
  await enterPrintTheme();
  try {
    window.print(); // blocks until the dialog closes
  } finally {
    clear();
    leavePrintTheme();
  }
}

let pdfInProgress = false;

async function exportDocAsPdf(): Promise<void> {
  if (!currentDoc || pdfInProgress) return;
  const base = fileName(currentDoc.path).replace(MD_EXT_RE, "");
  const target = await saveDialog({
    defaultPath: `${base}.pdf`,
    filters: [{ name: t("filter.pdf"), extensions: ["pdf"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  pdfInProgress = true;
  const clear = setPrintMeta();
  await enterPrintTheme();
  try {
    await ipc.printToPdf(target, false);
    flashDone(btnShare);
    showNotice(t("msg.pdfSaved"), {
      action: { label: t("msg.showInFolder"), fn: () => void revealItemInDir(target).catch(() => {}) },
    });
  } catch (err) {
    showNotice(t("msg.pdfFailed", { err: String(err) }), {
      action: { label: t("msg.usePrintDialog"), fn: () => void printDoc() },
    });
  } finally {
    clear();
    leavePrintTheme();
    pdfInProgress = false;
  }
}

function positionMenu(menu: HTMLElement, anchor: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right - 4)}px`;
  menu.style.left = "auto";
}

function toggleShareMenu(): void {
  if (!shareMenu.hidden) {
    shareMenu.hidden = true;
    return;
  }
  if (!currentDoc) return;
  readingMenu.hidden = true;
  positionMenu(shareMenu, btnShare);
  shareMenu.hidden = false;
  shareMenu.querySelector<HTMLButtonElement>(".menu-item")?.focus();
}

function toggleReadingMenu(): void {
  if (!readingMenu.hidden) {
    readingMenu.hidden = true;
    return;
  }
  shareMenu.hidden = true;
  syncReadingMenu();
  positionMenu(readingMenu, btnReading);
  readingMenu.hidden = false;
}

/* ---- reading settings (the Aa popover) ---- */

function syncReadingMenu(): void {
  const p = prefs.get();
  const active: Record<string, string> = {
    font: p.font,
    lineHeight: p.lineHeight,
    width: p.width,
    sideSize: p.sideSize,
    theme: theme.currentPref(),
    lang: i18n.pref(),
  };
  for (const seg of readingMenu.querySelectorAll<HTMLElement>(".rs-seg")) {
    const key = seg.id === "rs-theme" ? "theme" : seg.id === "rs-lang" ? "lang" : (seg.dataset.pref ?? "");
    for (const opt of seg.querySelectorAll<HTMLButtonElement>(".rs-opt")) {
      opt.setAttribute("aria-pressed", String(opt.dataset.value === active[key]));
    }
  }
  rsSizeValue.textContent = `${p.size} px`;
  const i = prefs.SIZE_STEPS.indexOf(p.size);
  rsSizeDec.disabled = i <= 0;
  rsSizeInc.disabled = i >= prefs.SIZE_STEPS.length - 1;
}

// a size or spacing change reflows the article: keep the section being read
function withReadingAnchor(fn: () => void): void {
  const anchor = currentDoc && !article.hidden ? captureScrollAnchor(contentPane, article) : null;
  fn();
  if (anchor) restoreScrollAnchor(contentPane, article, anchor);
}

function bumpReaderSize(dir: 1 | -1): void {
  withReadingAnchor(() => prefs.bumpSize(dir));
}

async function exportDocAsHtml(): Promise<void> {
  if (!currentDoc) return;
  const base = fileName(currentDoc.path).replace(MD_EXT_RE, "");
  const target = await saveDialog({
    defaultPath: `${base}.html`,
    filters: [{ name: t("filter.html"), extensions: ["html"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  try {
    const html = await buildStandaloneHtml(article, fileName(currentDoc.path), currentDoc.dir);
    await ipc.exportFile(target, html);
    flashDone(btnShare);
  } catch (err) {
    showNotice(`Export failed: ${err}`);
  }
}

async function exportDocAsDocx(): Promise<void> {
  if (!currentDoc) return;
  const base = fileName(currentDoc.path).replace(MD_EXT_RE, "");
  const target = await saveDialog({
    defaultPath: `${base}.docx`,
    filters: [{ name: t("filter.word"), extensions: ["docx"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  try {
    const data = await buildDocxBase64(article, fileName(currentDoc.path), currentDoc.dir);
    await ipc.exportBinary(target, data);
    flashDone(btnShare);
  } catch (err) {
    showNotice(`Export failed: ${err}`);
  }
}

/* ---- notice bar ---- */

let noticeActionFn: (() => void) | null = null;
let noticeDismissFn: (() => void) | null = null;
let noticeSticky = false;

function showNotice(
  message: string,
  opts: { action?: { label: string; fn: () => void }; sticky?: boolean; onDismiss?: () => void } = {},
): void {
  noticeDismissFn = opts.onDismiss ?? null;
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
  noticeDismissFn = null;
}

/* ---- jumping to a heading or a source line ---- */

function scrollToId(id: string): boolean {
  const el = article.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
  if (!el) return false;
  const paneTop = contentPane.getBoundingClientRect().top;
  contentPane.scrollTop += el.getBoundingClientRect().top - paneTop - 24;
  return true;
}

// 0-based source line: the last rendered block starting at or before it
function scrollToSourceLine(line: number): boolean {
  collectPreviewAnchors();
  let best: HTMLElement | null = null;
  for (const a of previewAnchors) {
    if (a.line > line) break;
    best = a.el;
  }
  if (!best) return false;
  const paneTop = contentPane.getBoundingClientRect().top;
  contentPane.scrollTop += best.getBoundingClientRect().top - paneTop - 24;
  if (editing) editorMod?.scrollToLine(line);
  return true;
}

/* ---- always on top ---- */

let pinnedOnTop = false;

function togglePin(): void {
  pinnedOnTop = !pinnedOnTop;
  btnPin.setAttribute("aria-pressed", String(pinnedOnTop));
  getCurrentWindow()
    .setAlwaysOnTop(pinnedOnTop)
    .catch(() => {
      pinnedOnTop = !pinnedOnTop;
      btnPin.setAttribute("aria-pressed", String(pinnedOnTop));
    });
}

/* ---- file context menu: reveal, copy path, copy link ---- */

let fileMenuPath = "";

function openFileMenu(path: string, x: number, y: number): void {
  fileMenuPath = path;
  shareMenu.hidden = true;
  readingMenu.hidden = true;
  fileMenu.style.left = `${Math.min(x, window.innerWidth - 260)}px`;
  fileMenu.style.top = `${Math.min(y, window.innerHeight - 130)}px`;
  fileMenu.style.right = "auto";
  fileMenu.hidden = false;
  fileMenu.querySelector<HTMLButtonElement>(".menu-item")?.focus();
}

// `to` relative to `fromDir`, with forward slashes, for a Markdown link
function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split(/[\\/]+/).filter(Boolean);
  const b = to.split(/[\\/]+/).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  if (i === 0) return to.replace(/\\/g, "/"); // different drives: absolute
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/* ---- drag to scroll ---- */

// The middle button drags anywhere, like a PDF reader; the left button only
// on the pane outside the text column, so selecting text stays untouched.
function wireDragScroll(): void {
  let drag: { id: number; y: number; top: number; moved: boolean } | null = null;
  contentPane.addEventListener("pointerdown", (e) => {
    const margin = e.button === 0 && e.target === contentPane;
    if (!(e.button === 1 || margin) || lightbox.isOpen()) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll icon
    drag = { id: e.pointerId, y: e.clientY, top: contentPane.scrollTop, moved: false };
    try {
      contentPane.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer: capture is a nicety */
    }
  });
  contentPane.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      contentPane.classList.add("dragging");
    }
    contentPane.scrollTop = drag.top - dy;
  });
  const end = (e: PointerEvent) => {
    if (!drag || e.pointerId !== drag.id) return;
    contentPane.classList.remove("dragging");
    drag = null;
  };
  contentPane.addEventListener("pointerup", end);
  contentPane.addEventListener("pointercancel", end);
  // Chromium's middle-click autoscroll would fight the drag
  contentPane.addEventListener("auxclick", (e) => {
    if (e.button === 1) e.preventDefault();
  });
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

/* ---- folder-wide search ---- */

const SEARCH_FILE_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

let folderSearchTimer: number | undefined;
let folderSearchGen = 0;

function scheduleFolderSearch(): void {
  clearTimeout(folderSearchTimer);
  folderSearchTimer = window.setTimeout(() => runFolderSearch(), 250);
}

async function runFolderSearch(): Promise<void> {
  const q = treeSearch.value.trim();
  treeSearchClear.hidden = treeSearch.value.length === 0;
  const gen = ++folderSearchGen;
  if (!q || !browseRoot) {
    closeFolderSearch(false);
    return;
  }
  try {
    const hits = await ipc.searchInTree(browseRoot, q);
    if (gen !== folderSearchGen) return; // a newer query superseded this one
    renderFolderSearch(hits, q);
  } catch {
    /* folder gone mid-search: keep whatever is on screen */
  }
}

function renderFolderSearch(hits: ipc.SearchHit[], q: string): void {
  searchResults.replaceChildren();
  treeRoot.hidden = true;
  searchResults.hidden = false;
  if (hits.length === 0) {
    const empty = document.createElement("div");
    empty.className = "search-empty";
    empty.textContent = t("pane.noMatches");
    searchResults.append(empty);
    return;
  }
  let lastPath = "";
  for (const hit of hits) {
    if (!samePath(hit.path, lastPath)) {
      lastPath = hit.path;
      const file = document.createElement("button");
      file.type = "button";
      file.className = "search-file";
      file.innerHTML = SEARCH_FILE_ICON;
      const name = document.createElement("span");
      name.textContent = hit.name;
      name.title = hit.path;
      file.append(name);
      file.addEventListener("click", () => openHit(hit.path, q));
      searchResults.append(file);
    }
    if (hit.line > 0) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "search-hit";
      row.title = t("pane.lineN", { n: hit.line });
      row.append(...highlightMatch(hit.preview, q));
      row.addEventListener("click", () => openHit(hit.path, q));
      searchResults.append(row);
    }
  }
}

// preview text with the first case-insensitive match wrapped in <mark>
function highlightMatch(preview: string, q: string): Node[] {
  const i = preview.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [document.createTextNode(preview)];
  const mark = document.createElement("mark");
  mark.textContent = preview.slice(i, i + q.length);
  return [
    document.createTextNode(preview.slice(0, i)),
    mark,
    document.createTextNode(preview.slice(i + q.length)),
  ];
}

async function openHit(path: string, q: string): Promise<void> {
  await openFile(path);
  // carry the query into the document so the match is highlighted in place
  if (currentDoc && samePath(currentDoc.path, path)) search.openWith(q);
}

function closeFolderSearch(clearInput = true): void {
  if (clearInput) {
    treeSearch.value = "";
    treeSearchClear.hidden = true;
  }
  folderSearchGen++;
  searchResults.hidden = true;
  searchResults.replaceChildren();
  treeRoot.hidden = false;
}

async function goUp(): Promise<void> {
  if (!browseRoot || isDriveRoot(browseRoot)) return;
  const parent = await ipc.parentDir(browseRoot).catch(() => null);
  if (parent) {
    browseRoot = parent;
    refreshTree();
  }
}

/* ---- reading position, progress bar, reading time ---- */

// A remembered anchor is only honoured while its heading still exists: a
// rewritten document should open at the top, not at a stray offset.
function restoreRemembered(saved: ScrollAnchor | null): boolean {
  if (!saved) return false;
  if (!saved.id) {
    if (saved.offset <= 0) return false;
    restoreScrollAnchor(contentPane, article, saved);
    return true;
  }
  if (saved.id && !article.querySelector(`[id="${CSS.escape(saved.id)}"]`)) return false;
  restoreScrollAnchor(contentPane, article, saved);
  return true;
}

let progressRaf = 0;
function updateProgress(): void {
  if (progressRaf) return;
  progressRaf = requestAnimationFrame(() => {
    progressRaf = 0;
    const max = contentPane.scrollHeight - contentPane.clientHeight;
    const show = !editing && currentDoc !== null && !article.hidden && max > 24;
    readProgress.hidden = !show;
    if (show) readProgress.style.width = `${Math.min(100, (contentPane.scrollTop / max) * 100)}%`;
  });
}

let rememberTimer: number | undefined;
function onContentScroll(): void {
  updateProgress();
  if (editing || !currentDoc || article.hidden) return;
  clearTimeout(rememberTimer);
  const doc = currentDoc;
  rememberTimer = window.setTimeout(() => {
    if (currentDoc === doc && !editing) positions.remember(doc.path, captureScrollAnchor(contentPane, article));
  }, 300);
}

const WORDS_PER_MIN = 220;
const CJK_PER_MIN = 500;
const WORD_RE = /[\p{L}\p{N}_'\u2019-]+/gu;
const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

function updateDocMeta(): void {
  if (!currentDoc || article.hidden) {
    docMeta.hidden = true;
    return;
  }
  const text = article.textContent ?? "";
  const cjk = (text.match(CJK_RE) ?? []).length;
  const words = (text.replace(CJK_RE, " ").match(WORD_RE) ?? []).length;
  const minutes = Math.max(1, Math.ceil(words / WORDS_PER_MIN + cjk / CJK_PER_MIN));
  docMeta.textContent = t("msg.minRead", { n: minutes });
  docMeta.title = t("msg.words", { n: i18n.fmtNumber(words + cjk) });
  docMeta.hidden = false;
}

/* ---- outline filter ---- */

const TOC_FILTER_MIN = 8;

// `keep`: a refresh of the same document keeps the query; a new one starts clean
function setupTocFilter(headings: number, keep: boolean): void {
  const show = headings >= TOC_FILTER_MIN;
  tocFilterWrap.hidden = !show;
  if (!show || !keep) tocFilter.value = "";
  toc.setFilter(tocFilter.value);
  tocFilterClear.hidden = tocFilter.value.length === 0;
}

function clearTocFilter(): void {
  tocFilter.value = "";
  tocFilterClear.hidden = true;
  toc.setFilter("");
}

/* ---- reading keys (single keys while reading) ---- */

const isTypingTarget = (el: Element | null): boolean =>
  !!el &&
  (el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el as HTMLElement).isContentEditable ||
    el.closest(".cm-editor") !== null);

const readingKeysActive = (): boolean =>
  !editing && currentDoc !== null && !article.hidden && !isTypingTarget(document.activeElement);

const KEY_SCROLL = 80;
let lastG = 0;
// j/k presses in quick succession add up from the previous target, not from
// wherever the smooth scroll animation happens to be
let keyScrollTarget = -1;
let keyScrollAt = 0;

function scrollByKey(delta: number, repeat: boolean): void {
  const now = performance.now();
  const max = contentPane.scrollHeight - contentPane.clientHeight;
  const from = keyScrollTarget >= 0 && now - keyScrollAt < 400 ? keyScrollTarget : contentPane.scrollTop;
  keyScrollTarget = Math.max(0, Math.min(max, from + delta));
  keyScrollAt = now;
  contentPane.scrollTo({ top: keyScrollTarget, behavior: repeat ? "instant" : "smooth" });
}

// returns true when the key was a reading key
function handleReadingKey(e: KeyboardEvent): boolean {
  // some senders report Shift+g as "g" + shiftKey rather than "G"
  const key = e.shiftKey && e.key.length === 1 ? e.key.toUpperCase() : e.key;
  switch (key) {
    case "j":
      scrollByKey(KEY_SCROLL, e.repeat);
      return true;
    case "k":
      scrollByKey(-KEY_SCROLL, e.repeat);
      return true;
    case ".":
    case ",":
      toc.step(key === "." ? 1 : -1);
      return true;
    case "G":
      contentPane.scrollTo({ top: contentPane.scrollHeight, behavior: "smooth" });
      return true;
    case "g": {
      const now = performance.now();
      if (now - lastG < 500) {
        lastG = 0;
        contentPane.scrollTo({ top: 0, behavior: "smooth" });
      } else {
        lastG = now;
      }
      return true;
    }
    case "n":
    case "N":
      if (search.hasMatches()) search.step(key === "n" ? 1 : -1);
      return true;
    default:
      return false;
  }
}

function toggleKeysDialog(): void {
  if (keysDialog.open) keysDialog.close();
  else keysDialog.showModal();
}

/* ---- "rate on the Store" card ---- */

let rateTimer: number | undefined;

function scheduleRatePrompt(): void {
  clearTimeout(rateTimer);
  if (!storeInstall || !rating.due()) return;
  rateTimer = window.setTimeout(() => {
    if (editing || !currentDoc || article.hidden || !rateToast.hidden) return;
    rateToast.hidden = false;
    rating.shown();
  }, 2000);
}

function hideRateToast(): void {
  clearTimeout(rateTimer);
  rateToast.hidden = true;
}

/* ---- the home: recent files on the empty screen ---- */

const RECENT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

let recentsGen = 0;

async function renderRecents(): Promise<void> {
  const gen = ++recentsGen;
  const all = recents.list();
  let items = all;
  if (all.length > 0) {
    // files deleted or moved since are dropped silently
    const alive = new Set(
      (await ipc.existingPaths(all.map((r) => r.path)).catch(() => all.map((r) => r.path))).map((p) =>
        p.toLowerCase(),
      ),
    );
    items = all.filter((r) => alive.has(r.path.toLowerCase()));
    for (const r of all) if (!alive.has(r.path.toLowerCase())) recents.remove(r.path);
  }
  if (gen !== recentsGen) return;
  recentList.replaceChildren();
  recentSection.hidden = items.length === 0;
  const now = Date.now();
  for (const r of items) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "recent-row";
    row.title = r.path;
    row.innerHTML = RECENT_ICON;
    const name = document.createElement("span");
    name.className = "recent-name";
    name.textContent = r.name;
    const dir = document.createElement("span");
    dir.className = "recent-dir";
    dir.textContent = r.dir;
    const time = document.createElement("span");
    time.className = "recent-time";
    time.textContent = recents.relativeTime(r.openedAt, now);
    row.append(name, dir, time);
    row.addEventListener("click", () => openFile(r.path));
    recentList.append(row);
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
  docMeta.hidden = true;
  readProgress.hidden = true;
  renderRecents().catch(() => {});
}

async function chooseFile(): Promise<void> {
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: t("filter.markdown"), extensions: MD_EXTENSIONS }],
  }).catch(() => null);
  if (typeof picked === "string") await openFile(picked);
}

function toggleSidebar(cls: "tree-hidden" | "toc-hidden"): void {
  app.classList.toggle(cls);
  localStorage.setItem(cls, app.classList.contains(cls) ? "1" : "0");
  panes.refresh(); // the other pane may now have room to reach its stored width
}

function wireUi(): void {
  if (localStorage.getItem("tree-hidden") === "1") app.classList.add("tree-hidden");
  if (localStorage.getItem("toc-hidden") === "1") app.classList.add("toc-hidden");

  panes.init({
    shell,
    panes: { tree: treePane, toc: tocPane },
    handles: { tree: $("#tree-resizer"), toc: $("#toc-resizer") },
  });
  lightbox.init({
    article,
    pane: contentPane,
    hint: zoomHint,
    dialog: zoomDialog,
    bars: [$("#find-bar"), noticeBar],
  });

  $("#btn-tree").addEventListener("click", () => toggleSidebar("tree-hidden"));
  $("#btn-toc").addEventListener("click", () => toggleSidebar("toc-hidden"));
  $("#btn-open").addEventListener("click", chooseFile);
  $("#btn-open-empty").addEventListener("click", chooseFile);
  btnPin.addEventListener("click", togglePin);
  wireDragScroll();

  // right-click on a file (tree or title): reveal, copy path, copy link
  treeRoot.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row) return;
    const path = row.classList.contains("dir") ? row.parentElement?.dataset.path : row.dataset.path;
    if (!path) return;
    e.preventDefault();
    openFileMenu(path, e.clientX, e.clientY);
  });
  docTitle.addEventListener("contextmenu", (e) => {
    if (!currentDoc) return;
    e.preventDefault();
    openFileMenu(currentDoc.path, e.clientX, e.clientY);
  });
  $("#file-reveal").addEventListener("click", () => {
    fileMenu.hidden = true;
    revealItemInDir(fileMenuPath).catch((err) => showNotice(t("msg.revealFailed", { err: String(err) })));
  });
  $("#file-copy-path").addEventListener("click", () => {
    fileMenu.hidden = true;
    navigator.clipboard.writeText(fileMenuPath).catch(() => {});
  });
  $("#file-copy-link").addEventListener("click", () => {
    fileMenu.hidden = true;
    const rel = currentDoc ? relativePath(currentDoc.dir, fileMenuPath) : fileMenuPath;
    const name = fileName(fileMenuPath).replace(MD_EXT_RE, "");
    navigator.clipboard.writeText(`[${name}](${encodeURI(rel)})`).catch(() => {});
  });

  // Ctrl+C on a selection: the same Word-friendly HTML as the Share copy,
  // for the selected part, plus the plain text
  article.addEventListener("copy", (e) => {
    if (editing || !currentDoc) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || isTypingTarget(document.activeElement)) return;
    const range = sel.getRangeAt(0);
    if (!article.contains(range.commonAncestorContainer)) return;
    e.preventDefault();
    const plain = sel.toString();
    copySelectionAsRichText(article, currentDoc.dir, range).catch(() => {
      navigator.clipboard.writeText(plain).catch(() => {});
    });
  });
  $("#recent-clear").addEventListener("click", () => {
    recents.clear();
    renderRecents().catch(() => {});
  });
  contentPane.addEventListener("scroll", onContentScroll, { passive: true });
  window.addEventListener("resize", updateProgress);

  // outline filter
  tocFilter.addEventListener("input", () => {
    toc.setFilter(tocFilter.value);
    tocFilterClear.hidden = tocFilter.value.length === 0;
  });
  tocFilter.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      toc.moveCursor(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      toc.activateCursor();
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearTocFilter();
      tocFilter.blur();
    }
  });
  tocFilterClear.addEventListener("click", () => {
    clearTocFilter();
    tocFilter.focus();
  });

  // rate card
  $("#rate-now").addEventListener("click", () => {
    rating.done();
    hideRateToast();
    ipc.openStoreReview().catch(() => {});
  });
  $("#rate-later").addEventListener("click", () => {
    rating.later();
    hideRateToast();
  });
  $("#rate-never").addEventListener("click", () => {
    rating.done();
    hideRateToast();
  });
  btnEdit.addEventListener("click", () => toggleEditMode());
  btnSave.addEventListener("click", () => saveFile());
  btnShare.addEventListener("click", (e) => {
    e.stopPropagation(); // the document click-away handler must not see this
    toggleShareMenu();
  });
  btnReading.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleReadingMenu();
  });
  $("#share-copy").addEventListener("click", () => {
    shareMenu.hidden = true;
    copyDocAsRichText();
  });
  $("#share-print").addEventListener("click", () => {
    shareMenu.hidden = true;
    void printDoc();
  });
  $("#export-pdf").addEventListener("click", () => {
    shareMenu.hidden = true;
    void exportDocAsPdf();
  });
  const breakH1 = $<HTMLButtonElement>("#print-break-h1");
  const syncBreakH1 = () => breakH1.setAttribute("aria-checked", String(prefs.get().printBreakH1));
  syncBreakH1();
  prefs.onChange(syncBreakH1);
  breakH1.addEventListener("click", (e) => {
    e.stopPropagation(); // the menu stays open: it is a setting, not an action
    prefs.set({ printBreakH1: !prefs.get().printBreakH1 });
  });
  $("#export-html").addEventListener("click", () => {
    shareMenu.hidden = true;
    exportDocAsHtml();
  });
  $("#export-docx").addEventListener("click", () => {
    shareMenu.hidden = true;
    exportDocAsDocx();
  });
  document.addEventListener("click", (e) => {
    const t = e.target as Node;
    if (!shareMenu.hidden && !shareMenu.contains(t)) shareMenu.hidden = true;
    if (!readingMenu.hidden && !readingMenu.contains(t)) readingMenu.hidden = true;
    if (!fileMenu.hidden && !fileMenu.contains(t)) fileMenu.hidden = true;
  });

  // reading settings: selections keep the popover open so choices compose
  rsSizeDec.addEventListener("click", () => bumpReaderSize(-1));
  rsSizeInc.addEventListener("click", () => bumpReaderSize(1));
  $("#rs-reset").addEventListener("click", () => withReadingAnchor(() => prefs.reset()));
  for (const seg of readingMenu.querySelectorAll<HTMLElement>(".rs-seg[data-pref]")) {
    seg.addEventListener("click", (e) => {
      const opt = (e.target as HTMLElement).closest<HTMLButtonElement>(".rs-opt");
      if (!opt) return;
      const key = seg.dataset.pref as "font" | "lineHeight" | "width" | "sideSize";
      const value = opt.dataset.value ?? "";
      withReadingAnchor(() => prefs.set({ [key]: value } as Partial<prefs.ReaderPrefs>));
    });
  }
  $("#rs-theme").addEventListener("click", (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLButtonElement>(".rs-opt");
    if (opt) theme.setPref(opt.dataset.value as theme.ThemePref);
  });
  // a language change reloads the window: every module reads the dictionary
  // at load time, and a reload is cheaper than rebuilding menus and keymaps
  $("#rs-lang").addEventListener("click", async (e) => {
    const opt = (e.target as HTMLElement).closest<HTMLButtonElement>(".rs-opt");
    if (!opt) return;
    const next = opt.dataset.value as i18n.LangPref;
    if (next === i18n.pref()) return;
    if (editorMod?.isDirty()) {
      const ok = await ask(t("msg.langReloadQ"), { title: t("msg.discardTitle"), kind: "warning" }).catch(() => false);
      if (!ok) return;
    }
    i18n.setPref(next);
    // get_initial_file was consumed at boot: carry the open document across
    if (currentDoc) sessionStorage.setItem("reopen", currentDoc.path);
    location.reload();
  });
  prefs.onChange(() => {
    syncReadingMenu();
    editorMod?.refresh();
    updateProgress();
  });
  theme.onChange(() => syncReadingMenu());
  $("#btn-help").addEventListener("click", () => helpDialog.showModal());
  $("#help-close").addEventListener("click", () => helpDialog.close());
  $("#help-rate").addEventListener("click", () => {
    ipc.openStoreReview().catch(() => {});
  });
  btnUp.addEventListener("click", goUp);
  treeSearch.addEventListener("input", scheduleFolderSearch);
  treeSearch.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeFolderSearch();
      treeSearch.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      searchResults.querySelector<HTMLButtonElement>(".search-hit, .search-file")?.click();
    }
  });
  treeSearchClear.addEventListener("click", () => closeFolderSearch());
  noticeAction.addEventListener("click", () => noticeActionFn?.());
  $("#notice-close").addEventListener("click", () => {
    const fn = noticeDismissFn;
    hideNotice(true);
    fn?.();
  });

  // click outside the dialog body closes it
  helpDialog.addEventListener("click", (e) => {
    if (e.target === helpDialog) helpDialog.close();
  });
  keysDialog.addEventListener("click", (e) => {
    if (e.target === keysDialog) keysDialog.close();
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
    // Esc closes it natively and +/-/0/arrows are handled inside it; F1 too,
    // so a help dialog cannot stack on top of a modal preview
    if (lightbox.isOpen()) return;
    if (e.key === "F1") {
      e.preventDefault();
      if (helpDialog.open) helpDialog.close();
      else helpDialog.showModal();
      return;
    }
    if (helpDialog.open) return; // Esc is handled natively by <dialog>
    if (keysDialog.open) {
      if (e.key === "?") {
        e.preventDefault();
        keysDialog.close();
      }
      return;
    }
    // the editor already handled it (Ctrl+B/I format there, Ctrl+S saved once)
    if (e.defaultPrevented) return;
    if (e.key === "Escape" && (!shareMenu.hidden || !readingMenu.hidden || !fileMenu.hidden)) {
      shareMenu.hidden = true;
      readingMenu.hidden = true;
      fileMenu.hidden = true;
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      togglePin();
      return;
    }
    if (e.key === "Escape" && !rateToast.hidden) {
      rating.later();
      hideRateToast();
      return;
    }
    // single-key reading commands, only while the document itself has the keys
    if (!e.ctrlKey && !e.altKey && !e.metaKey && !isTypingTarget(document.activeElement)) {
      if (e.key === "?") {
        e.preventDefault();
        toggleKeysDialog();
        return;
      }
      if (readingKeysActive() && handleReadingKey(e)) {
        e.preventDefault();
        return;
      }
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      app.classList.remove("tree-hidden");
      localStorage.setItem("tree-hidden", "0");
      panes.refresh();
      treeSearch.focus();
      treeSearch.select();
    } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
      // while editing, find always means the editor's panel (case, word,
      // regexp, replace), wherever the focus is: never a second find bar
      e.preventDefault();
      if (editing && editorMod) editorMod.openFind(false);
      else search.open();
    } else if (e.ctrlKey && !e.altKey && e.key.toLowerCase() === "h") {
      if (editing && editorMod) {
        e.preventDefault();
        editorMod.openFind(true);
      }
    } else if (e.key === "F3" && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const dir = e.shiftKey ? -1 : 1;
      if (editing && editorMod) editorMod.findStep(dir);
      else if (search.hasMatches()) search.step(dir);
      else if (currentDoc) search.open();
    } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      chooseFile();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggleShareMenu();
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
    } else if (e.ctrlKey && e.key.toLowerCase() === "p") {
      // swallow it even without a document: WebView2 would print the empty UI
      e.preventDefault();
      void printDoc();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      copyDocAsRichText();
      // !e.altKey below: on Windows AltGr reports Ctrl+Alt, and AltGr symbol
      // combos must keep working while typing in the editor.
      // preventDefault also suppresses WebView2's whole-page zoom.
    } else if (e.ctrlKey && !e.altKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      bumpReaderSize(1);
    } else if (e.ctrlKey && !e.altKey && e.key === "-") {
      e.preventDefault();
      bumpReaderSize(-1);
    } else if (e.ctrlKey && !e.altKey && e.key === "0") {
      e.preventDefault();
      withReadingAnchor(() => prefs.set({ size: prefs.DEFAULTS.size }));
    }
  });

  // Ctrl+wheel resizes the reader text instead of WebView2's whole-page zoom
  let lastWheelBump = 0;
  document.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault(); // block the native page zoom everywhere, not just over text
      if (lightbox.isOpen()) return; // the preview zooms itself
      const t = e.target as Node;
      const overReader = contentPane.contains(t) || editorPane.contains(t);
      const overPane = treePane.contains(t) || tocPane.contains(t);
      if (!overReader && !overPane) return;
      const now = performance.now();
      if (now - lastWheelBump < 80) return; // trackpad pinches arrive in bursts
      lastWheelBump = now;
      // zoom whatever is under the cursor
      if (overReader) bumpReaderSize(e.deltaY < 0 ? 1 : -1);
      else prefs.bumpSideSize(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );

  // a print the app did not start (the WebView2 context menu) still gets the
  // light chrome; prints started by printDoc/exportDocAsPdf already did this
  window.addEventListener("beforeprint", () => void enterPrintTheme());
  window.addEventListener("afterprint", () => {
    if (!pdfInProgress) leavePrintTheme();
  });

  // help dialog links (licence, repository) → default browser
  helpDialog.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (!/^https?:/i.test(href)) return;
    e.preventDefault();
    openUrl(href).catch(() => {});
  });

  // in-article links: hash → in-page scroll, web → default browser, local →
  // open in the viewer. Local links resolve like a wiki: `doc`, `doc.md`,
  // `folder/` (its index.md or README.md), with an optional `#heading`.
  article.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (!href) return;
    e.preventDefault();
    const hashAt = href.indexOf("#");
    const target = hashAt >= 0 ? href.slice(0, hashAt) : href;
    const anchor = hashAt >= 0 ? decodeURIComponent(href.slice(hashAt + 1)) : undefined;
    if (!target) {
      if (anchor) document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      if (/^https?:/i.test(href)) openUrl(href).catch(() => {});
    } else if (currentDoc) {
      const rel = decodeURIComponent(target);
      ipc
        .resolveDoc(currentDoc.dir, rel)
        .then((p) => {
          if (p) return openFile(p, { anchor });
          showNotice(t("msg.notFound", { name: rel }));
        })
        .catch(() => showNotice(t("msg.notFound", { name: rel })));
    }
  });

  // task-list checkboxes write the change back to the source
  article.addEventListener("click", (e) => {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("input.task-list-item-checkbox");
    if (box) void onTaskToggle(box);
  });

  // diagrams and images open the full-window preview
  article.addEventListener("click", (e) => {
    if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
    if (e.defaultPrevented) return; // a link already took it
    if (!(window.getSelection()?.isCollapsed ?? true)) return; // text being selected
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-zoomable]");
    if (el) void lightbox.openFor(el);
  });
}

async function showVersion(): Promise<void> {
  const v = `v${await getVersion()}`;
  for (const el of document.querySelectorAll("#help-version, #empty-version")) el.textContent = v;
}

// the rating prompt only makes sense for the Microsoft Store build
async function showStoreRating(): Promise<void> {
  storeInstall = await ipc.isStoreInstall().catch(() => false);
  if (storeInstall) $("#help-rate-card").hidden = false;
}

async function boot(): Promise<void> {
  i18n.init();
  theme.init();
  prefs.init();
  showVersion().catch(() => {});
  showStoreRating().catch(() => {});
  theme.onChange((t) => rerenderForTheme(article, theme.schemeOf(t) === "dark").catch(() => {}));
  wireUi();

  // registering this handler makes JS responsible for closing the window,
  // which needs the core:window:allow-destroy capability
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (editorMod?.isDirty() && !(await confirmDiscard())) e.preventDefault();
  });

  // listeners must be live before get_initial_file, or a double-click
  // arriving during startup would be lost
  await ipc.onOpenFile((l) => {
    if (l.path) openFile(l.path, { line: l.line ?? undefined });
  });
  await ipc.onFileChanged(() => {
    if (!currentDoc) return;
    if (Date.now() < suppressReloadUntil) return; // echo of our own save
    if (editing && editorMod?.isDirty()) {
      // never clobber a dirty buffer
      showNotice(t("msg.fileChanged"), {
        action: {
          label: t("msg.reload"),
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
      const md = event.payload.paths.find(isMarkdownPath);
      const img = event.payload.paths.find(isImagePath);
      if (md) openFile(md);
      else if (img && editing) insertDroppedImage(img);
    }
  });

  const initial = await ipc.getInitialFile().catch(() => null);
  const reopen = sessionStorage.getItem("reopen");
  sessionStorage.removeItem("reopen");
  if (initial?.path) await openFile(initial.path, { line: initial.line ?? undefined });
  else if (reopen) await openFile(reopen);
  else showEmpty();

  await ipc.showWindow().catch(() => {});
}

boot();
