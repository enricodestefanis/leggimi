import "./styles/base.css";
import "./styles/layout.css";
import "./styles/markdown.css";
import "./styles/code.css";
import "./styles/ui.css";
import "./styles/lightbox.css";
import "./styles/tabs.css";
import "./styles/section-line.css";
import "./styles/print.css";

import { getVersion } from "@tauri-apps/api/app";
import { convertFileSrc } from "@tauri-apps/api/core";
import { documentDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask, message, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";

import * as ipc from "./ipc";
import { applyScheme, forgetFoundFiles, render, renderFragment } from "./renderer";
import { placeDrawnDiagrams, renderMermaidIn, rerenderForTheme } from "./mermaid";
import * as toc from "./toc";
import * as tree from "./tree";
import * as search from "./search";
import * as lightbox from "./lightbox";
import * as panes from "./panes";
import * as wide from "./wide";
import * as tableScroll from "./tableScroll";
import * as theme from "./theme";
import * as prefs from "./prefs";
import * as positions from "./positions";
import * as recents from "./recents";
import * as rating from "./rating";
import * as drafts from "./drafts";
import * as i18n from "./i18n";
import * as contextMenu from "./contextMenu";
import * as navHistory from "./navHistory";
import * as notices from "./notices";
import * as bars from "./bars";
import * as motion from "./motion";
import * as sectionLine from "./sectionLine";
import { outline, pathOf } from "./sections";
import { collectMedia, restoreMedia } from "./media";
import { handleMenuKey } from "./menuKeys";
import { keyLabel, t } from "./i18n";
import { whereFrom, type Where } from "./where";
import { reachable } from "./reach";
import { captureScrollAnchor, findHeading, restoreScrollAnchor, type ScrollAnchor } from "./state";
import { isInside, samePath } from "./paths";
import {
  docKey,
  fileSafeName,
  isPastedKey,
  newPasteId,
  pastedDoc,
  pastedIdOf,
  pastedKey,
  pastedText,
  pastedTitle,
  type Doc,
  type Pasted,
} from "./docs";
import { buildDocxBase64, buildStandaloneHtml, copyAsRichText, copySelectionAsRichText } from "./share";
import * as session from "./tabs/session";
import * as strip from "./tabs/strip";
import * as chrome from "./tabs/chrome";
import type { TabAccepted, TabInfo, TabOffer, TabTransfer, TestHooks } from "./tabs/contract";
import type { Snapshot } from "./editor";
import type { PaletteCommand, PaletteFile, PaletteHeading, PaletteHost, PaletteTab } from "./palette";
import type { AppCommandHost } from "./appCommands";

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

// a file, or pasted text (docs.ts: path and dir null, nothing on disk)
let currentDoc: Doc | null = null;
// Root of the file browser. It survives navigation *within* itself, so opening a
// file from a subfolder does not make the rest of the tree disappear.
let browseRoot: string | null = null;
let opening = false;
// a tab is coming to the front: documents asked for meanwhile wait for it
let switching = false;
// the article holds an error card, not the document
let errorShown = false;
// the document was deleted or moved away while on screen (see onDocRemoved)
let docGone = false;

let editing = false;
let storeInstall = false;
// the window is hidden until the first document (or the home) is ready
let windowShown = false;
let editorMod: typeof import("./editor") | null = null;
let previewGen = 0;
let previewTimer: number | undefined;
// edits typed since the preview was last drawn, and drawings under way
let previewDirty = false;
let previewsInFlight = 0;
// the watcher's echo of our own saves is ignored for a moment, file by file
const ownWrites = new Map<string, number>();
const ownWriteChecks = new Map<string, number>();
const OWN_WRITE_MS = 1500;
// A change made by another program within that window was dropped for good (report
// B-10: an agent still writing its plan, right after a tick): once it is over, the
// file is compared with what the window holds, once, and treated as any change.
const noteOwnWrite = (path: string): void => {
  const k = path.toLowerCase();
  ownWrites.set(k, Date.now() + OWN_WRITE_MS);
  clearTimeout(ownWriteChecks.get(k));
  ownWriteChecks.set(
    k,
    window.setTimeout(() => {
      ownWriteChecks.delete(k);
      recheckAfterOwnWrite(path);
    }, OWN_WRITE_MS + 100),
  );
};
const isOwnWrite = (path: string): boolean => (ownWrites.get(path.toLowerCase()) ?? 0) > Date.now();

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;
// keep in sync with MD_EXTS in src-tauri/src/commands.rs
const MD_EXTENSIONS = ["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "markdn", "mdtxt"];
const MD_EXT_RE = new RegExp(`\\.(${MD_EXTENSIONS.join("|")})$`, "i");
const isMarkdownPath = (p: string) => MD_EXT_RE.test(p);
const isImagePath = (p: string) => /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i.test(p);
const isDriveRoot = (p: string) => /^[a-z]:[\\/]?$/i.test(p);

// pasted text is called by its title, or (it has none) in the words of the interface
const pastedName = (p: Pasted): string => p.title || t("paste.untitled");
// a document's name: its file's ("notes.md"), or the pasted text's
const docName = (d: Doc): string => (d.path !== null ? fileName(d.path) : pastedName(d.paste));
// the name an export starts with in the save dialog, without the extension
const exportBase = (d: Doc): string =>
  d.path !== null
    ? fileName(d.path).replace(MD_EXT_RE, "")
    : fileSafeName(pastedName(d.paste)) || fileSafeName(t("paste.untitled"));
// the document is that file (pasted text is no file)
const isDocAt = (d: Doc | null, path: string): boolean => d !== null && d.path !== null && samePath(d.path, path);
// what the editor's text is held against for "unsaved": a file's text, or
// pasted text's as it was pasted (typing back to it leaves nothing unsaved)
const baselineOf = (d: Doc): string => (d.path !== null ? d.content : d.paste.original);

interface OpenOptions {
  preserveScroll?: boolean;
  /** heading id to show at the top (a `file.md#section` link) */
  anchor?: string;
  /** 1-based source line to show at the top (`--line N`) */
  line?: number;
  /** a place to go back to (Back, Forward): shown as it was, at once */
  restore?: ScrollAnchor;
}

// a request that arrives while another document is opening (or a tab is
// coming forward) waits for it; the latest one wins
let queuedOpen: { path: string; opts: OpenOptions; tab: session.Tab | null } | null = null;

// "shown": the document is on screen; "kept": not now (the unsaved edits were
// kept, or another document opens first and this one waits for it);
// "failed": it could not be read (a notice said why).
type OpenResult = "shown" | "kept" | "failed";

async function openFile(path: string, opts: OpenOptions = {}): Promise<OpenResult> {
  // a tab coming to the front holds the view too: the request waits for it
  if (opening || switching) {
    queuedOpen = { path, opts, tab: session.hasActive() ? session.active() : null };
    return "kept";
  }
  // pasted text is never replaced (it is in no file): the file gets a tab of its own
  if (session.hasActive() && session.active().src.kind === "pasted") {
    openInTab(path, opts);
    return "kept";
  }
  opening = true;
  try {
    return await loadDoc(path, opts);
  } finally {
    opening = false;
    drainQueuedOpen();
  }
}

// the request that waited, unless it was about a tab no longer in front
function drainQueuedOpen(): void {
  if (opening || switching) return;
  const next = queuedOpen;
  queuedOpen = null;
  if (!next) return;
  if (next.tab && session.hasActive() && session.active() !== next.tab) return;
  void openFile(next.path, next.opts);
}

// A document into the tab in front: openFile's work, one at a time.
async function loadDoc(path: string, opts: OpenOptions): Promise<OpenResult> {
  try {
    // read before asking: a file that is gone never costs the unsaved edits
    const doc = await ipc.readMarkdown(path);
    // the document being edited, asked for again (double-clicked in File
    // Explorer, picked in the pane, dropped): see keepEditedDoc. A reload
    // that discards the edits (preserveScroll) goes on as usual.
    if (editing && isDocAt(currentDoc, doc.path) && !opts.preserveScroll) {
      await keepEditedDoc(doc, opts);
      return "shown";
    }
    if (editing && editorMod?.isDirty() && currentDoc && !isDocAt(currentDoc, doc.path)) {
      // as when leaving the editor: Save / Don't save / Cancel, Save first
      const was = currentDoc;
      const answer = await askSave(t("msg.openOtherQ", { name: docName(was) }), t("msg.save"));
      if (answer === "cancel" || currentDoc !== was) return "kept";
      if (answer === "save") {
        await saveFile();
        if (editorMod?.isDirty()) return "kept";
      } else drafts.remove(docKey(was));
    }
    const prevPath = currentDoc?.path ?? null;
    const sameDoc = prevPath !== null && samePath(prevPath, doc.path);
    // the place on screen before it goes (never an error card's): for the
    // reading position, a reload, and Back
    const here = currentDoc && !article.hidden && !errorShown ? captureScrollAnchor(contentPane, article) : null;
    // reopening the document already on screen (a reload, or the same file
    // double-clicked again) keeps the place being read
    const anchor = opts.preserveScroll || sameDoc ? here : null;
    // leaving a document: keep its reading position before it goes
    if (currentDoc?.path && here && !sameDoc && !editing) positions.remember(currentDoc.path, here);
    // the place Back returns to; reloads and Back itself leave none
    const from = here && prevPath !== null && !opts.preserveScroll && !opts.restore ? { path: prevPath, pos: here } : null;
    // another document in front (one opened from outside while the palette was
    // open): the palette's list was the old one's. A reload keeps it open.
    if (!sameDoc) closePalette();
    currentDoc = doc;
    syncFrontTab();

    if (editing && prevPath !== null && !samePath(prevPath, doc.path)) exitEditMode();

    await render(doc, article);
    // diagrams drawn before come back at their height before the place is put back (C-01)
    placeDrawnDiagrams(article, theme.isDark());
    errorShown = false;
    // a notice about what was on screen before ("not found", "changed on
    // disk") is not about this document; nor is "no longer on disk" once
    // the file could be read again
    if (docGone || !sameDoc) hideNotice(true);
    docGone = false;
    lightbox.markAll(article);
    emptyState.hidden = true;
    article.hidden = false;
    // no entrance animation while the place is measured: its translateY(4px)
    // would put every jump and remembered place 4 px off (it starts below)
    article.classList.remove("doc-enter");
    updateTitles();

    const headings = toc.build(article, tocList, contentPane);
    app.classList.toggle("no-headings", headings === 0);
    sectionLine.rebuild();
    setupTocFilter(headings, sameDoc);
    panes.refresh();
    // tables and diagrams too wide for the column take the pane's width; once
    // the outline has settled (it changes the pane's width), and before the
    // place is restored (they change the heights above it)
    wide.markWide(article);
    updateDocMeta();

    const target = opts.restore ?? anchor ?? (sameDoc ? null : positions.recall(doc.path));
    // an explicit destination (link anchor, --line) beats the remembered place
    const jump = (): HTMLElement | null =>
      opts.anchor !== undefined ? scrollToId(opts.anchor) : opts.line !== undefined ? scrollToSourceLine(opts.line - 1) : null;
    const landed = jump();
    // the place on screen before a reload of this document: kept even if its heading was renamed
    const same = target !== null && target === anchor;
    if (!landed && !restoreRemembered(target, same)) contentPane.scrollTop = 0;
    // A place restored by Back appears at once, as in a browser; so does the
    // first document of a window, whose own appearance is the transition (a
    // fade on top of it would only make the start feel slower).
    if (windowShown && !opts.preserveScroll && !opts.restore) {
      void article.offsetWidth; // restart the entrance animation
      article.classList.add("doc-enter");
    }
    // the place asked for lights up for a moment, so the eye finds it
    if (landed) motion.flash(landed);
    updateProgress();
    const applied = contentPane.scrollTop;

    renderMermaidIn(article, theme.isDark())
      .then(() => {
        lightbox.markAll(article);
        wide.markWide(article);
        // diagrams change the heights above the anchor: re-apply it, unless
        // the reader has already moved on
        if (currentDoc === doc && contentPane.scrollTop === applied && !jump() && target) restoreRemembered(target, same);
        updateProgress();
      })
      .catch(() => {});
    if (!sameDoc) void offerDraft(doc);
    search.onContentChanged();

    const rootChanged = !browseRoot || !isInside(browseRoot, doc.dir);
    if (rootChanged) browseRoot = doc.dir;
    // Same-root selection just moves the highlight: a rebuild would discard the
    // user's collapsed folders and flicker. Same-document reopens (watcher
    // reloads) still rebuild so files added or removed on disk get picked up.
    if (rootChanged || sameDoc || !tree.setActive(treeRoot, doc.path)) void refreshTree();
    reportTabs();
    if (!sameDoc) {
      recents.push(doc);
      rating.noteOpen();
      scheduleRatePrompt();
    }
    // a new place: the one left goes on the Back list (a reopen of the same
    // document counts only when it jumped somewhere, a --line or an anchor)
    if (from && (!sameDoc || landed)) navHistory.record(from);
    return "shown";
  } catch (err) {
    // what is on screen stays (the document, or the home): a notice says it
    const onScreen = currentDoc !== null && !article.hidden && !errorShown;
    if (String(err) === ipc.NOT_FOUND) {
      // the document on screen, deleted meanwhile (F5): its way back stays at hand
      if (docGone && isDocAt(currentDoc, path)) showGoneNotice();
      else {
        if (!onScreen) showEmpty(); // at start, or over an error card: the home
        reportMissing(path);
      }
    } else if (onScreen) {
      showNotice(String(err), { kind: "error" });
    } else {
      showError(String(err));
    }
    return "failed";
  }
}

// The file of the document being edited, opened again. Reading it in would put
// the disk's text in the preview under the editor's, and move the baseline the
// save guard compares with: a later Ctrl+S could then overwrite a change made
// elsewhere without asking. The buffer and the baseline stay; a change on disk
// is reported as the watcher does, and a line or an anchor is still honoured.
async function keepEditedDoc(disk: ipc.MarkdownDoc, opts: OpenOptions): Promise<void> {
  if (!currentDoc || currentDoc.path === null) return;
  // the same text with another time (see sameOnDisk) is not a change
  if (disk.modified !== currentDoc.modified && disk.content === currentDoc.content) currentDoc.modified = disk.modified;
  if (disk.modified !== currentDoc.modified) {
    if (editorMod?.isDirty()) showFileChangedNotice();
    // first: reloading resets the editor to its top, which would undo the jump
    else await reloadFromDisk();
  }
  const line =
    opts.line !== undefined
      ? opts.line - 1
      : opts.anchor !== undefined
        ? Number(elementById(opts.anchor)?.dataset.sourceLine)
        : NaN;
  // the preview and the editor both go there
  const landed = Number.isFinite(line) ? scrollToSourceLine(line) : null;
  if (landed) motion.flash(landed);
}

// Windows reports a change of attributes as a write: OneDrive turns a new
// file in a synced folder (the Desktop, Documents) into a reparse point a
// couple of seconds after it appears, and antivirus or backup tools touch
// files too. Only another text on disk is news; the same text only brings
// its time (so a save does not take it for a conflict). Unreadable: news.
async function sameOnDisk(doc: ipc.MarkdownDoc): Promise<boolean> {
  try {
    const disk = await ipc.readMarkdown(doc.path);
    if (disk.content !== doc.content) return false;
    // in place, as for a rename: a save in flight holds this very object
    doc.modified = disk.modified;
    return true;
  } catch {
    return false;
  }
}

// The file in front changed on disk (the watcher said so, or the window after one of
// our own writes ended): another text is read in, or reported over unsaved edits.
function onFrontChanged(): void {
  // a document on its way replaces this one, or (a reload) reads it anew:
  // a reload queued behind it would bring the old one back
  if (opening || switching || !currentDoc || currentDoc.path === null || docGone) return;
  const doc = currentDoc;
  void sameOnDisk(doc).then((same) => {
    // read meanwhile: another document, a save, or one on its way
    if (same || currentDoc !== doc || opening || switching) return;
    if (editing && editorMod?.isDirty()) {
      // never clobber a dirty buffer
      showFileChangedNotice();
      return;
    }
    if (editing) void reloadFromDisk();
    else void openFile(doc.path, { preserveScroll: true });
  });
}

// The window after one of our own writes to `path` is over: what came meanwhile
// from someone else is read now. The tab in front as the watcher would; a tab
// behind is marked to read its file again when it comes forward.
function recheckAfterOwnWrite(path: string): void {
  if (!session.hasActive()) return;
  for (const tab of session.tabs) {
    if (tab === session.active() || tab.closing || !isTabOf(tab, path)) continue;
    const doc = tab.doc;
    if (!doc || doc.path === null || tab.stale) continue;
    void ipc
      .readMarkdown(doc.path)
      .then((disk) => {
        if (tab.doc === doc && disk.content !== doc.content) tab.stale = true;
      })
      .catch(() => {});
  }
  if (currentDoc && currentDoc.path !== null && samePath(currentDoc.path, path)) onFrontChanged();
}

function showFileChangedNotice(): void {
  showNotice(t("msg.fileChanged"), {
    sticky: true,
    action: { label: t("msg.reload"), fn: () => void reloadFromDisk() },
  });
}

function updateTitles(): void {
  const dirty = frontChanged();
  const pasted = currentDoc?.path === null;
  dirtyDot.hidden = !dirty;
  if (dirty) dirtyDot.classList.remove("saved");
  // pasted text can always be saved: into a file of its own ("Save as…")
  btnSave.disabled = !dirty && !pasted;
  app.classList.toggle("pasted", pasted);
  const saveKey = pasted ? "toolbar.saveAs" : "toolbar.save";
  if (btnSave.dataset.i18nTitle !== saveKey) {
    btnSave.dataset.i18nTitle = saveKey;
    i18n.applyDom(btnSave.parentElement ?? document);
  }
  btnShare.disabled = currentDoc === null;
  // the tab in front wears the dot of unsaved edits
  if (session.hasActive() && session.active().dirty !== dirty) {
    session.active().dirty = dirty;
    strip.render();
  }
  // the title stays in the page, out of sight, for screen readers and the tests
  docTitle.textContent = currentDoc ? docName(currentDoc) : "";
  // the editor's text box is named after its document (WCAG 4.1.2, report A-07)
  editorMod?.setLabel(currentDoc ? t("editor.label", { name: docName(currentDoc) }) : t("pal.editor"));
  docTitle.title = currentDoc?.path ?? "";
  getCurrentWindow()
    .setTitle(currentDoc ? `${dirty ? "• " : ""}${t("toolbar.windowTitle", { name: docName(currentDoc) })}` : "Leggimi")
    .catch(() => {});
}

/* ---- edit mode ---- */

async function toggleEditMode(): Promise<void> {
  if (!editing) {
    await enterEditMode();
    return;
  }
  // pasted text lives only here: back to reading, it keeps what was typed
  // (closing its tab asks about it), and so does its draft
  if (currentDoc?.path === null) {
    if (editorMod) currentDoc = { ...currentDoc, content: editorMod.currentText() };
    exitEditMode();
    writeDraft();
    return;
  }
  if (editorMod?.isDirty() && currentDoc) {
    // the question closing the tab asks (report A-02: it offered only Discard, and Enter
    // pressed it): Save is the first button, so Enter keeps the work
    const doc = currentDoc;
    const answer = await askSave(t("msg.leaveEditQ", { name: docName(doc) }), t("msg.save"));
    if (answer === "cancel" || currentDoc !== doc || !editing) return;
    if (answer === "save") {
      await saveFile();
      // not written (the other version kept, an error): the edits stay in the editor
      if (editorMod?.isDirty()) return;
    } else {
      drafts.remove(docKey(doc));
      // restore the saved document in the article before leaving the split view
      await openFile(doc.path, { preserveScroll: true });
    }
  }
  exitEditMode();
}

// `line` (0-based) puts the caret there; without it the editor opens at the
// section being read
async function enterEditMode(line?: number): Promise<void> {
  if (editing || !currentDoc) return;
  const doc = currentDoc;
  // another tab may come forward while the editor's code loads the first time
  if (!(await ensureEditor()) || !editorMod || currentDoc !== doc || editing) return;
  syncSuppressedUntil = performance.now() + 200;
  editorMod.setContent(doc.content, baselineOf(doc));
  // the section being read (first anchor visible in the preview), measured
  // before the split view: a narrow window edits without the preview
  let readLine = 0;
  if (line === undefined) {
    collectPreviewAnchors();
    const paneTop = contentPane.getBoundingClientRect().top;
    readLine = previewAnchors.find((a) => a.el.getBoundingClientRect().top - paneTop >= -1)?.line ?? 0;
  }
  editing = true;
  // the reading find bar searches the preview; while editing, Ctrl+F and F3
  // belong to the editor's panel, so close the bar instead of showing both
  search.close();
  app.classList.add("editing");
  sectionLine.hideNow();
  panes.refresh();
  syncEditButton();
  updateTitles();
  updateProgress();
  hideRateToast();
  editorMod.focus();

  // the editor opens at the line asked for, else at the section being read
  if (line !== undefined) editorMod.scrollToLine(line);
  else if (readLine > 0) editorMod.scrollToLine(readLine);
}

// "Edit from here": the editor at that source line, entering edit mode first
async function editAt(line: number | null): Promise<void> {
  if (!editing) await enterEditMode(line ?? undefined);
  else if (line !== null && editorMod) {
    editorMod.scrollToLine(line);
    editorMod.focus();
  }
}

function exitEditMode(): void {
  if (!editing) return;
  // a narrow window edited without the preview, which kept no place of its
  // own: reading resumes where the editor was
  const at = app.classList.contains("is-narrow") ? editorMod?.topVisibleLine() : undefined;
  editing = false;
  app.classList.remove("editing");
  panes.refresh();
  syncEditButton();
  // reset the buffer to the saved document: clears dirty state and undo history
  if (currentDoc) editorMod?.setContent(currentDoc.content, baselineOf(currentDoc));
  if (at !== undefined) scrollToSourceLine(at);
  updateTitles();
  updateProgress();
}

// The edit button says what a click does: Edit while reading, Back to reading
// while editing; its icon follows the mode in CSS (#app.editing). A pressed
// state would be the wrong signal for a button whose name changes.
function syncEditButton(): void {
  btnEdit.dataset.i18nTitle = editing ? "toolbar.read" : "toolbar.edit";
  i18n.applyDom(btnEdit.parentElement ?? document);
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
  // a picture goes into a folder next to its document: pasted text becomes a file first
  if (currentDoc.dir === null && !(await saveForPicture())) return;
  if (!editing || !currentDoc || currentDoc.dir === null || !editorMod) return;
  const tab = session.active();
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
    insertInto(tab, `![](${encodeURI(rel)})`);
  } catch (err) {
    showNotice(t("msg.imagePasteFailed", { err: String(err) }), { kind: "error" });
  }
}

async function insertDroppedImage(path: string): Promise<void> {
  if (!editing || !currentDoc || !editorMod) return;
  if (currentDoc.dir === null && !(await saveForPicture())) return;
  if (!editing || !currentDoc || currentDoc.dir === null || !editorMod) return;
  const tab = session.active();
  try {
    const rel = await ipc.importImage(currentDoc.dir, path);
    insertInto(tab, `![](${encodeURI(rel)})`);
  } catch (err) {
    showNotice(t("msg.imageDropFailed", { err: String(err) }), { kind: "error" });
  }
}

// A picture pasted or dropped into pasted text is kept in a folder next to
// its document, so the text becomes a file first (asked). True once it is one.
async function saveForPicture(): Promise<boolean> {
  const ok = await ask(t("msg.imageNeedsFileQ"), {
    title: t("msg.imageNeedsFileTitle"),
    kind: "info",
    okLabel: t("tab.saveAs"),
    cancelLabel: t("msg.cancel"),
  }).catch(() => false);
  return ok && (await saveAsFront());
}

// an image link into the editor of the tab it was pasted or dropped in, in
// front or behind by now
function insertInto(tab: session.Tab, text: string): void {
  if (session.active() === tab) {
    if (editing) editorMod?.insertAtCursor(text);
    return;
  }
  const v = tab.view;
  if (!v?.editor || !editorMod) return;
  v.editor = editorMod.snapshotInsert(v.editor, text);
  v.previewStale = true;
  tab.dirty = v.editor.dirty;
  strip.render();
}

/* ---- recovery drafts ---- */

let draftTimer: number | undefined;

// while the buffer is dirty its text is parked in localStorage (1 s after the
// last keystroke); a clean buffer removes the draft
function scheduleDraft(): void {
  clearTimeout(draftTimer);
  draftTimer = window.setTimeout(writeDraft, 1000);
}

function writeDraft(): void {
  draftTimer = undefined;
  // pasted text is kept whenever it is no longer as pasted, read or edited:
  // it is in no file, the draft is all there is after a crash
  if (currentDoc && currentDoc.path === null) {
    const key = pastedKey(currentDoc.paste);
    if (frontChanged()) drafts.put(key, frontText(), currentDoc.paste.original);
    else drafts.remove(key);
    return;
  }
  if (!currentDoc || !editorMod) return;
  if (editing && editorMod.isDirty()) {
    drafts.put(docKey(currentDoc), editorMod.currentText(), currentDoc.content.replace(/\r\n/g, "\n"));
  } else {
    drafts.remove(docKey(currentDoc));
  }
}

// a tab going behind leaves its draft written at once
function flushDraft(): void {
  if (draftTimer === undefined) return;
  clearTimeout(draftTimer);
  writeDraft();
}

// The windows share localStorage, drafts included: before offering one, ask
// the others whether it is the live, unsaved buffer of one of them.
const peers = new BroadcastChannel("leggimi-windows");
peers.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as { type?: string; path?: string; id?: number };
  const path = m.path;
  if (m.type !== "editing?" || !path) return;
  // any tab of this window, in front or behind (a draft's key: a file's path, or pasted text's)
  const mine = session.tabs.some((x) => {
    const key = draftKeyOf(x);
    return !x.closing && key !== null && samePath(key, path) && tabDirty(x);
  });
  if (mine) peers.postMessage({ type: "editing!", id: m.id });
});

function editedElsewhere(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const id = Math.random();
    const onReply = (e: MessageEvent) => {
      if ((e.data as { type?: string; id?: number }).type !== "editing!" || e.data.id !== id) return;
      peers.removeEventListener("message", onReply);
      resolve(true);
    };
    peers.addEventListener("message", onReply);
    peers.postMessage({ type: "editing?", path, id });
    setTimeout(() => {
      peers.removeEventListener("message", onReply);
      resolve(false);
    }, 250);
  });
}

// a draft left by a crash or a killed process is offered, never applied
async function offerDraft(doc: ipc.MarkdownDoc): Promise<void> {
  const draft = drafts.get(doc.path);
  if (!draft) return;
  if ((await editedElsewhere(doc.path)) || currentDoc !== doc) return;
  // the buffer holds it already (a tab carried here with its edits), or
  // another tab of this window is editing the file
  if (editing && editorMod?.currentText() === draft.text) return;
  if (session.tabs.some((x) => x !== session.active() && isTabOf(x, doc.path) && tabDirty(x))) return;
  if (draft.text === doc.content.replace(/\r\n/g, "\n")) {
    drafts.remove(doc.path);
    return;
  }
  showNotice(t("msg.draftRecovered"), {
    kind: "info",
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
  previewDirty = true;
  revealUntil = performance.now() + 1000;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => {
    previewDirty = false;
    if (editorMod) void updatePreview(editorMod.currentText());
  }, 200);
}

async function updatePreview(content: string): Promise<void> {
  if (!currentDoc) return;
  const gen = ++previewGen;
  previewsInFlight++;
  try {
    // all fallible work happens before the DOM commit; on error the previous
    // preview stays on screen and only the notice strip appears
    const staging = await renderFragment({ ...currentDoc, content });
    if (gen !== previewGen) return; // a newer render superseded this one

    // in edit mode the editor viewport is the source of truth for the preview
    // position; the heading anchor only serves the non-editing path
    const anchor = editing ? null : captureScrollAnchor(contentPane, article);
    // a video or a sound playing goes on playing: in the same task as the swap (media.ts)
    const keep = collectMedia(article);
    article.replaceChildren(...staging.childNodes);
    restoreMedia(keep, article);
    // diagrams already drawn come back at once, so untouched ones neither flicker nor move the text
    placeDrawnDiagrams(article, theme.isDark());
    collectPreviewAnchors();
    lightbox.markAll(article);
    wide.markWide(article);
    if (anchor) restoreScrollAnchor(contentPane, article, anchor);
    else syncPreviewToEditor(true);

    const headings = toc.build(article, tocList, contentPane);
    app.classList.toggle("no-headings", headings === 0);
    sectionLine.rebuild();
    setupTocFilter(headings, true);
    panes.refresh();
    updateDocMeta();
    search.onContentChanged();
    hideNotice();
    followPastedTitle();
    renderMermaidIn(article, theme.isDark())
      .then(() => {
        // freshly rendered diagrams change heights: re-anchor and re-align
        lightbox.markAll(article);
        wide.markWide(article);
        collectPreviewAnchors();
        scheduleSyncPreview(true);
      })
      .catch((err) => showNotice(t("msg.diagramFailed", { err: String(err) }), { kind: "error" }));
  } catch (err) {
    if (gen === previewGen) showNotice(t("msg.previewError", { err: String(err) }), { kind: "error" });
  } finally {
    previewsInFlight--;
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
  // a narrow window edits without the preview: nothing to align
  if (contentPane.clientHeight === 0) return;

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
  // Over a table's rows the header holds the top of the pane: what is at
  // the editor's top goes below the header instead (tableScroll.headCover;
  // fading out past the table, so that leaving it does not jump).
  const cover = (y: number, after = false): number => tableScroll.headCover(contentPane, article, y, after);
  let target = 0;
  if (!editorMod.isAtTop()) {
    const y = yInSpan(topSpan, topLine);
    target = y - SYNC_MARGIN - cover(y, true);
  }
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
    const above = SYNC_MARGIN + cover(caretTop);
    if (caretTop < target + above) target = caretTop - above;
  }
  contentPane.scrollTop = Math.max(0, Math.min(max, target));
}

/* ---- saving ---- */

// Writes `content` to the document's file, guarding against a file that
// changed on disk since it was read. null: the user kept the other version.
// `create`: the file was deleted while open (the tab in front's, by default)
async function writeDocument(doc: ipc.MarkdownDoc, content: string, create = docGone): Promise<number | null> {
  noteOwnWrite(doc.path);
  // a UTF-8 BOM the file had stays; one read as UTF-16 or ANSI gets one (wroteAsUtf8)
  const bom = !!doc.encoding && doc.encoding !== "utf-8";
  // a document deleted while open is written again: that is what saving it means
  try {
    const modified = await ipc.writeMarkdown(doc.path, content, doc.modified, create, bom);
    if (create && currentDoc === doc) onDocBack();
    return modified;
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
    noteOwnWrite(doc.path);
    return ipc.writeMarkdown(doc.path, content, null, false, bom);
  }
}

// A file read in another encoding (UTF-16 from Windows PowerShell, ANSI) is written in
// UTF-8, as every save is: said once, at its first save (report B-06). "" otherwise.
// It is UTF-8 with a BOM from then on, which Windows PowerShell 5.1 reads back right.
function wroteAsUtf8(doc: ipc.MarkdownDoc): string {
  const enc = doc.encoding;
  if (!enc || enc === "utf-8" || enc === "utf-8-bom") return "";
  doc.encoding = "utf-8-bom";
  const name = /^utf-16/.test(enc) ? "UTF-16" : enc.startsWith("windows-") ? `ANSI (Windows-${enc.slice(8)})` : enc.toUpperCase();
  return t("msg.savedUtf8", { enc: name });
}

async function saveFile(): Promise<void> {
  // pasted text has no file to write to yet: Save asks where, read or edited, changed or not
  if (currentDoc?.path === null) {
    await saveAsFront();
    return;
  }
  if (!editing || !currentDoc || !editorMod?.isDirty()) return;
  const content = editorMod.getContent();
  const doc = currentDoc;
  try {
    const modified = await writeDocument(doc, content);
    if (modified === null) return;
    const utf8 = wroteAsUtf8(doc);
    if (currentDoc !== doc) {
      // its tab went behind meanwhile: the one saved keeps the news
      savedBehind(doc, content, modified);
      return;
    }
    currentDoc = { ...doc, content, modified };
    editorMod.markSaved();
    drafts.remove(doc.path);
    hideNotice(true);
    showSaved();
    if (utf8) showNotice(utf8, { kind: "info" });
  } catch (err) {
    showNotice(t("msg.saveFailed", { err: String(err) }), { kind: "error" });
  }
}

// a "Save as…" under way: a second Ctrl+S meanwhile does not ask twice
let savingAs = false;

// `name` in `folder`, as the save dialog takes a starting point
const inFolder = (folder: string, name: string): string => `${folder.replace(/[\\/]+$/, "")}\\${name}`;

/**
 * The pasted text in front into a file of its own ("Save as…": Ctrl+S, the
 * Save button, the tab's menu, a picture pasted in, a link followed): named
 * after its title, in the folder it was pasted over, else in Documents. The
 * tab is then that file, read back from disk as any file opened (the folder
 * of its pictures, Windows' list of recent files), in the pane, watched,
 * among the recent files, its Back places following it. True once it is.
 */
async function saveAsFront(o: { closing?: boolean } = {}): Promise<boolean> {
  const doc = currentDoc;
  if (!doc || doc.path !== null || savingAs || opening || switching || !session.hasActive()) return false;
  const tab = session.active();
  const paste = doc.paste;
  savingAs = true;
  // no tab comes forward under the dialog, nor while the file is written and read back
  tabHolds++;
  try {
    const name = `${fileSafeName(pastedName(paste)) || fileSafeName(t("paste.untitled")) || "Leggimi"}.md`;
    const folder = paste.home ?? (await documentDir().catch(() => null));
    const picked = await saveDialog({
      defaultPath: folder ? inFolder(folder, name) : name,
      filters: [{ name: t("filter.markdown"), extensions: MD_EXTENSIONS }],
    }).catch(() => null);
    // still this pasted text in front (its doc object is renewed by a tick, by leaving the editor)
    if (typeof picked !== "string" || !picked || currentDoc?.path !== null || currentDoc.paste !== paste) return false;
    // the dialog leaves the extension to the name typed
    const target = isMarkdownPath(picked) ? picked : `${picked}.md`;
    // that file in another tab: its unsaved edits are not overwritten (and this
    // text stays as it is). A tab holds its file's path as Windows resolves it
    // (a mapped drive's share, a junction's target): a file already there is
    // looked for in that form too.
    const cut = Math.max(target.lastIndexOf("\\"), target.lastIndexOf("/"));
    const canon = await ipc.resolvePath(target.slice(0, cut + 1), target.slice(cut + 1)).catch(() => target);
    const other = session.findPath(canon) ?? session.findPath(target);
    if (other && other !== tab && tabDirty(other)) {
      showNotice(t("msg.saveAsOpenDirty", { name: fileName(target) }), { kind: "warning" });
      return false;
    }
    noteOwnWrite(target);
    await ipc.writeMarkdown(target, frontText(), null, true);
    // the text is in the file: the tab is that file now, its edits saved
    if (editing && editorMod) editorMod.markSaved();
    clearTimeout(draftTimer);
    draftTimer = undefined;
    const key = pastedKey(paste);
    tab.src = { kind: "file", path: target };
    opening = true;
    let result: OpenResult;
    try {
      result = await loadDoc(target, { preserveScroll: true });
    } finally {
      opening = false;
    }
    // what loadDoc put on screen (the compiler cannot see it replace currentDoc)
    const read = currentDoc as Doc | null;
    if (result !== "shown" || read === null || read.path === null) {
      // written, but not readable back: the tab stays the pasted text (the file is there)
      tab.src = { kind: "pasted", paste };
      strip.render();
      reportTabs();
      writeDraft();
      return false;
    }
    drafts.remove(key);
    navHistory.renamePath(key, read.path);
    if (editing) collectPreviewAnchors();
    // the same file in a tab of its own, with nothing unsaved: one tab for it.
    // Saved as its tab closes, this one goes: that one stays, and reads the
    // file again when it comes forward (this window's own write marks nothing).
    const dup = session.live().find((x) => x !== tab && x.src.kind === "file" && samePath(x.src.path, read.path)) ?? other;
    if (dup && dup !== tab && !dup.closing) {
      if (o.closing) dup.stale = true;
      else void releaseTab(dup);
    }
    strip.render();
    showSaved();
    return true;
  } catch (err) {
    showNotice(t("msg.saveFailed", { err: String(err) }), { kind: "error" });
    return false;
  } finally {
    tabHolds--;
    savingAs = false;
    drainQueuedOpen();
  }
}

let savedTimer: number | undefined;

// Ctrl+S answers: the unsaved-changes dot turns into a check for a moment,
// and screen readers hear "Saved". Typing again brings the dot straight back.
function showSaved(): void {
  if (session.hasActive()) strip.flashSaved(session.active());
  clearTimeout(savedTimer);
  dirtyDot.classList.remove("saved");
  void dirtyDot.offsetWidth; // restart the animation
  dirtyDot.classList.add("saved");
  dirtyDot.hidden = false;
  notices.announce(t("msg.saved"));
  savedTimer = window.setTimeout(() => {
    dirtyDot.classList.remove("saved");
    dirtyDot.hidden = !(editorMod?.isDirty() ?? false);
  }, 1400);
}

/* ---- task-list checkboxes in the preview ---- */

// inside a quote or a callout too ("> - [ ] …", "> > 1. [x] …"): a tick there was never written
const TASK_MARK_RE = /^((?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/;

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
  // a line it cannot find its box in: the box goes back, rather than show a tick the file lacks
  if (next === old) {
    box.checked = !box.checked;
    return;
  }
  if (editing && editorMod) {
    editorMod.replaceLine(line, next);
    return;
  }
  lines[line] = next;
  // pasted text: the tick changes the text here, there is no file to write
  // (its draft keeps it)
  if (doc.path === null) {
    currentDoc = { ...doc, content: lines.join(eol) };
    box.toggleAttribute("checked", box.checked);
    updateTitles();
    writeDraft();
    return;
  }
  // a file deleted meanwhile is not written back by a tick (its notice says so)
  if (docGone) {
    box.checked = !box.checked;
    return;
  }
  const content = lines.join(eol);
  try {
    const modified = await writeDocument(doc, content);
    if (modified === null) {
      box.checked = !box.checked;
      return;
    }
    const utf8 = wroteAsUtf8(doc);
    if (currentDoc !== doc) {
      // its tab went behind meanwhile: the tick stays, and the tab has the file's news
      const tab = session.tabs.find((x) => x.doc === doc);
      if (tab) tab.doc = { ...doc, content, modified };
      box.toggleAttribute("checked", box.checked);
      return;
    }
    currentDoc = { ...doc, content, modified };
    // the attribute too: exports and the rich copy read the markup, not the live state
    box.toggleAttribute("checked", box.checked);
    const before = doc.content;
    const said = t(box.checked ? "msg.taskChecked" : "msg.taskUnchecked");
    showNotice(utf8 ? `${said} ${utf8}` : said, {
      kind: "success",
      action: {
        label: t("msg.undo"),
        fn: () => {
          const cur = currentDoc;
          if (!cur || cur.path === null || !samePath(cur.path, doc.path)) return;
          writeDocument(cur, before)
            .then((m) => {
              if (m === null || currentDoc !== cur) return;
              currentDoc = { ...cur, content: before, modified: m };
              box.checked = !box.checked;
              box.toggleAttribute("checked", box.checked);
              hideNotice(true);
            })
            .catch((err) => showNotice(t("msg.undoFailed", { err: String(err) }), { kind: "error" }));
        },
      },
    });
  } catch (err) {
    box.checked = !box.checked;
    showNotice(t("msg.taskUpdateFailed", { err: String(err) }), { kind: "error" });
  }
}

async function reloadFromDisk(): Promise<void> {
  // pasted text has no file to read again
  if (!currentDoc || currentDoc.path === null) return;
  const path = currentDoc.path;
  const tab = session.active();
  try {
    const doc = await ipc.readMarkdown(path);
    // its tab went behind meanwhile: it reads the file again when it comes back
    if (session.active() !== tab) {
      tab.stale = true;
      return;
    }
    // another document took the tab while the file was being read
    if (!isDocAt(currentDoc, path)) return;
    // unsaved edits replaced by the disk's text: steps Ctrl+Z (or Undo) takes back
    // (report A-01: it used to be gone with no question and no way back). While
    // editing the history always stays: a second change on disk after a reload over
    // edits (an agent writing again) is one more step to walk back, not their end.
    const pending = reloaded !== null && reloaded.doc === currentDoc;
    const replaced = editing && (!!editorMod?.isDirty() || pending);
    const steps = replaced ? (pending && reloaded ? reloaded.steps + 1 : 1) : 0;
    currentDoc = doc;
    if (editing && editorMod) editorMod.replaceAll(doc.content);
    else editorMod?.setContent(doc.content);
    await updatePreview(doc.content);
    hideNotice(true);
    if (replaced) showReloadedNotice(doc, steps);
  } catch (err) {
    showNotice(t("msg.reloadFailed", { err: String(err) }), { kind: "error" });
  }
}

// "Reloaded from disk: your edits were replaced." with Undo: the edits come back
// (unsaved, over the disk's new text, which the notice about it says again). It
// stays until used or dismissed, and goes at the first edit after the reload: Undo
// would then take back that edit, not the reload (Ctrl+Z still walks back to it).
// The reload Undo takes back: the document it read, the text it put in the editor,
// and how many reloads in a row (each one step of the editor's history) since the edits.
let reloaded: { doc: ipc.MarkdownDoc; text: string; steps: number } | null = null;
function showReloadedNotice(doc: ipc.MarkdownDoc, steps: number): void {
  const state = { doc, text: doc.content.replace(/\r\n/g, "\n"), steps };
  reloaded = state;
  showNotice(t("msg.reloaded"), {
    kind: "info",
    sticky: true,
    action: {
      label: t("msg.undo"),
      fn: () => {
        if (reloaded === state) reloaded = null;
        hideNotice(true);
        if (currentDoc !== doc || !editing || !editorMod) return;
        // edited since (in another tab's absence too): Undo would take back that edit
        if (editorMod.currentText() !== state.text) return;
        for (let i = 0; i < state.steps; i++) editorMod.undoLast();
        editorMod.focus();
        if (editorMod.isDirty()) showFileChangedNotice();
      },
    },
    onDismiss: () => {
      if (reloaded === state) reloaded = null;
    },
  });
}

// an edit after a reload: its Undo notice has done its time
function dropReloadedNotice(): void {
  if (reloaded === null || !editorMod || editorMod.currentText() === reloaded.text) return;
  reloaded = null;
  if (document.getElementById("notice-msg")?.textContent === t("msg.reloaded")) hideNotice(true);
}

/* ---- the document renamed or deleted on disk ---- */

// Renamed in File Explorer while on screen: the window follows the file,
// with the unsaved edits, the place being read and everything kept by path.
function onDocRenamed(to: string): void {
  if (!currentDoc || currentDoc.path === null) return;
  const from = currentDoc.path;
  // in place: a save or a ticked checkbox in flight still holds this very
  // object, and must not take it for another document
  currentDoc.path = to;
  // a focus check that came first took the old name for a deletion
  if (docGone) {
    docGone = false;
    hideNotice(true);
  }
  recents.rename(from, to);
  positions.rename(from, to);
  drafts.rename(from, to);
  navHistory.renamePath(from, to);
  syncFrontTab();
  updateTitles();
  reportTabs();
  if (!tree.setActive(treeRoot, to)) void refreshTree();
  showNotice(t("msg.renamedTo", { name: fileName(to) }), { kind: "info" });
}

// Deleted, or moved out of its folder: the text stays on screen, and the
// notice offers to write it back (so does saving, in edit mode)
function onDocRemoved(): void {
  if (!currentDoc || currentDoc.path === null || docGone) return;
  docGone = true;
  showGoneNotice();
  void refreshTree();
}

function showGoneNotice(): void {
  if (!currentDoc || currentDoc.path === null) return;
  showNotice(t("msg.goneFromDisk", { name: fileName(currentDoc.path) }), {
    sticky: true,
    action: { label: t("msg.saveAgain"), fn: () => void restoreGoneDoc() },
  });
}

// the file is there again (written back, or restored by an Undo in File Explorer)
function onDocBack(): void {
  if (!docGone) return;
  docGone = false;
  hideNotice(true);
  void refreshTree();
}

// "Save again": the text on screen (the editor's, while editing) back to its file
async function restoreGoneDoc(): Promise<void> {
  if (!currentDoc || currentDoc.path === null || !docGone) return;
  const doc = currentDoc;
  const content = editing && editorMod ? editorMod.getContent() : doc.content;
  try {
    const modified = await writeDocument(doc, content);
    if (modified === null || currentDoc !== doc) return;
    currentDoc = { ...doc, content, modified };
    if (editing) editorMod?.markSaved();
    drafts.remove(doc.path);
    updateTitles();
  } catch (err) {
    showNotice(t("msg.saveFailed", { err: String(err) }), { kind: "error" });
  }
}

// The document's own watch goes with its folder (renamed or deleted): the
// file itself is looked for whenever the pane's folder changes, and on focus.
// Missing, it is looked for once more after the watch's own delay: a rename
// it is about to report must not pass for a deletion.
async function checkDocOnDisk(): Promise<void> {
  // pasted text is on no disk
  if (!currentDoc || currentDoc.path === null || docGone || errorShown) return;
  const doc = currentDoc;
  const path = doc.path;
  const missing = async () => (await ipc.existingPaths([path]).catch(() => [path])).length === 0;
  if (!(await missing())) return;
  await new Promise((r) => setTimeout(r, 800));
  if (currentDoc === doc && doc.path === path && !docGone && (await missing())) onDocRemoved();
}

// a file picked from a list (the pane, the home, a search, Back) that is no
// longer there: say so, and let the lists catch up
function reportMissing(path: string): void {
  recents.remove(path);
  if (!emptyState.hidden) renderRecents().catch(() => {});
  void refreshTree();
  if (treeSearch.value.trim()) void runFolderSearch();
  showNotice(t("msg.notFound", { name: fileName(path) }));
}

// The file of a tab behind the one in front changed on disk: renamed, the tab
// follows it; deleted, it says so when it comes back; changed, it reads the
// file again then (never over unsaved edits).
function onBehindFileChanged(tab: session.Tab, change: ipc.FileChange): void {
  const from = session.filePath(tab);
  if (from === null) return;
  if (change.kind === "renamed" && change.to) {
    const to = change.to;
    tab.src = { kind: "file", path: to };
    // in place, as for the document in front: a save in flight holds this object
    if (tab.doc && tab.doc.path !== null) tab.doc.path = to;
    recents.rename(from, to);
    positions.rename(from, to);
    drafts.rename(from, to);
    if (tab.view) tab.view.nav = navHistory.renamedIn(tab.view.nav, from, to);
    strip.render();
    reportTabs();
    return;
  }
  if (change.kind === "removed") {
    if (tab.view) {
      tab.view.docGone = true;
      tab.view.notice = null;
    }
    return;
  }
  if (tab.view?.docGone) tab.view.docGone = false;
  if (isOwnWrite(change.path)) return;
  if (tab.doc) tab.stale = true;
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
  tabHolds++;
  try {
    // the plain-text flavor is the markdown source; in edit mode that means
    // the unsaved buffer, which is what the preview (and the eye) shows
    const plain = editing && editorMod ? editorMod.currentText() : currentDoc.content;
    await copyAsRichText(article, currentDoc.dir, plain);
    flashDone(btnShare);
  } catch (err) {
    showNotice(t("msg.copyFailed", { err: String(err) }), { kind: "error" });
  } finally {
    tabHolds--;
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
  const title = h1 || (currentDoc.path !== null ? fileName(currentDoc.path).replace(MD_EXT_RE, "") : pastedName(currentDoc.paste));
  const date = i18n.fmtDate(new Date(), { dateStyle: "medium" });
  const style = document.createElement("style");
  style.id = "print-page-meta";
  style.textContent = `@media print { @page { @top-center { content: ${cssString(`${title}  ·  ${date}`)}; } } }`;
  document.head.append(style);
  return () => style.remove();
}

// paper is always light: the chrome, the diagrams and the pictures too
let printThemeRestore: [string, string] | undefined;
async function enterPrintTheme(): Promise<void> {
  if (printThemeRestore) return;
  const ds = document.documentElement.dataset;
  printThemeRestore = [ds.theme ?? "light", ds.scheme ?? "light"];
  ds.theme = "light";
  ds.scheme = "light";
  if (printThemeRestore[1] === "dark") {
    applyScheme(article, "light");
    await rerenderForTheme(article, false).catch(() => {});
    await settlePictures();
  }
}
function leavePrintTheme(): void {
  if (!printThemeRestore) return;
  const ds = document.documentElement.dataset;
  [ds.theme, ds.scheme] = printThemeRestore;
  const wasDark = printThemeRestore[1] === "dark";
  printThemeRestore = undefined;
  if (wasDark) {
    applyScheme(article, "dark");
    rerenderForTheme(article, true).catch(() => {});
  }
}

// a <picture> that switched source must have its new image before printing
// snapshots the page: one task for the switch, then the decode (or 1.5 s)
async function settlePictures(): Promise<void> {
  const imgs = [...article.querySelectorAll<HTMLImageElement>("picture > img")];
  if (imgs.length === 0) return;
  await new Promise((r) => setTimeout(r, 0));
  await Promise.race([
    Promise.all(imgs.map((img) => img.decode().catch(() => {}))),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
}

// tables wider than the paper are scaled down to fit it (wide.ts), for the
// length of one print; preparing twice (Ctrl+P, then beforeprint) is one
let undoPrintWide: (() => void) | null = null;
function preparePrintWide(): void {
  undoPrintWide ??= wide.preparePrint(article);
}
function undoPrintWideNow(): void {
  undoPrintWide?.();
  undoPrintWide = null;
}

async function printDoc(): Promise<void> {
  if (!currentDoc) return;
  const clear = setPrintMeta();
  await enterPrintTheme();
  preparePrintWide();
  try {
    window.print(); // blocks until the dialog closes
  } finally {
    clear();
    leavePrintTheme();
    undoPrintWideNow();
  }
}

let pdfInProgress = false;

async function exportDocAsPdf(): Promise<void> {
  if (!currentDoc || pdfInProgress) return;
  const base = exportBase(currentDoc);
  const target = await saveDialog({
    defaultPath: `${base}.pdf`,
    filters: [{ name: t("filter.pdf"), extensions: ["pdf"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  pdfInProgress = true;
  const clear = setPrintMeta();
  await enterPrintTheme();
  preparePrintWide();
  try {
    await ipc.printToPdf(target, false);
    flashDone(btnShare);
    showNotice(t("msg.pdfSaved"), {
      kind: "success",
      action: { label: t("msg.showInFolder"), fn: () => void revealItemInDir(target).catch(() => {}) },
    });
  } catch (err) {
    showNotice(t("msg.pdfFailed", { err: String(err) }), {
      kind: "error",
      action: { label: t("msg.usePrintDialog"), fn: () => void printDoc() },
    });
  } finally {
    clear();
    leavePrintTheme();
    undoPrintWideNow();
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
    hideShareMenu();
    return;
  }
  if (!currentDoc) return;
  hideReadingMenu();
  contextMenu.close();
  positionMenu(shareMenu, btnShare);
  shareMenu.hidden = false;
  btnShare.setAttribute("aria-expanded", "true");
  shareMenu.querySelector<HTMLButtonElement>(".menu-item")?.focus();
}

function hideShareMenu(): void {
  shareMenu.hidden = true;
  btnShare.setAttribute("aria-expanded", "false");
}

// The Aa popover opens from its button (popovertarget), so the browser keeps
// it next to the button in the Tab order and closes it on Escape or a click
// elsewhere; it is filled and placed as it opens.
const readingMenuOpen = (): boolean => readingMenu.matches(":popover-open");

function hideReadingMenu(): void {
  if (readingMenuOpen()) readingMenu.hidePopover();
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
    lang: i18n.activePref(),
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
  // the new text size or column width may widen or narrow tables above the place
  if (anchor) {
    wide.markWide(article);
    restoreScrollAnchor(contentPane, article, anchor);
  }
}

function bumpReaderSize(dir: 1 | -1): void {
  withReadingAnchor(() => prefs.bumpSize(dir));
}

async function exportDocAsHtml(): Promise<void> {
  if (!currentDoc) return;
  const base = exportBase(currentDoc);
  const target = await saveDialog({
    defaultPath: `${base}.html`,
    filters: [{ name: t("filter.html"), extensions: ["html"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  tabHolds++;
  try {
    const html = await buildStandaloneHtml(article, docName(currentDoc), currentDoc.dir);
    await ipc.exportFile(target, html);
    flashDone(btnShare);
  } catch (err) {
    showNotice(t("msg.exportFailed", { err: String(err) }), { kind: "error" });
  } finally {
    tabHolds--;
  }
}

async function exportDocAsDocx(): Promise<void> {
  if (!currentDoc) return;
  const base = exportBase(currentDoc);
  const target = await saveDialog({
    defaultPath: `${base}.docx`,
    filters: [{ name: t("filter.word"), extensions: ["docx"] }],
  }).catch(() => null);
  if (typeof target !== "string" || !target) return;
  tabHolds++;
  try {
    const data = await buildDocxBase64(article, docName(currentDoc), currentDoc.dir);
    await ipc.exportBinary(target, data);
    flashDone(btnShare);
  } catch (err) {
    showNotice(t("msg.exportFailed", { err: String(err) }), { kind: "error" });
  } finally {
    tabHolds--;
  }
}

/* ---- notice bar (notices.ts) ---- */

const showNotice = notices.show;
const hideNotice = notices.hide;

/* ---- jumping to a heading or a source line ---- */

const uriSafe = (fn: (s: string) => string, s: string): string => {
  try {
    return fn(s);
  } catch {
    return s; // a stray "%" or a lone surrogate stays as it is
  }
};
const decodeSafe = (s: string): string => uriSafe(decodeURIComponent, s);

// A link's anchor may arrive percent-encoded or decoded, name an id the app's
// UI also uses (renamed in the document, see renderer.ts), or a heading's id
// from before 1.15.1, when ids were not GitHub's: findHeading tries them all.
function elementById(id: string): HTMLElement | null {
  return findHeading(article, id);
}

// The scrollTop that puts `el` where a jump lands: 24 px below the top of
// the pane, below a table's header when the header will be holding the top
// over el's row (tableScroll.ts), and below the section's path when that
// line will be over it (sectionLine.ts; never for a heading)
function jumpTop(el: Element): number {
  const y = contentPane.scrollTop + el.getBoundingClientRect().top - contentPane.getBoundingClientRect().top;
  return y - 24 - tableScroll.headCover(contentPane, article, y) - sectionLine.reserve(el);
}

// the element it scrolled to, or null when there is none
function scrollToId(id: string, smooth = false): HTMLElement | null {
  const el = elementById(id);
  if (!el) return null;
  const top = jumpTop(el);
  if (smooth) contentPane.scrollTo({ top, behavior: motion.behavior() });
  else contentPane.scrollTop = top;
  return el;
}

// 0-based source line: the last rendered block starting at or before it (returned)
function scrollToSourceLine(line: number): HTMLElement | null {
  collectPreviewAnchors();
  let best: HTMLElement | null = null;
  for (const a of previewAnchors) {
    if (a.line > line) break;
    best = a.el;
  }
  if (!best) return null;
  contentPane.scrollTop = jumpTop(best);
  if (editing) editorMod?.scrollToLine(line);
  return best;
}

/* ---- Back and Forward ---- */

// the place on screen, for Back: none over the home or an error card
function currentPlace(): navHistory.Place | null {
  if (!currentDoc || article.hidden || errorShown) return null;
  return { path: docKey(currentDoc), pos: captureScrollAnchor(contentPane, article) };
}

// Before a jump inside the document (a #link, the outline): the place being
// left goes on the Back list, unless the jump goes nowhere: the target
// already sits where a jump puts it (24 px below the top), or, near the end,
// the page cannot scroll any further toward it.
function noteJump(target: HTMLElement): void {
  const here = currentPlace();
  if (!here) return;
  const max = contentPane.scrollHeight - contentPane.clientHeight;
  const dest = jumpTop(target);
  if (Math.abs(Math.max(0, Math.min(max, dest)) - contentPane.scrollTop) < 8) return;
  navHistory.record(here);
}

// a #link in the document: there, smoothly, with the place left kept for Back;
// the heading reached lights up once the scroll arrives
function jumpToAnchor(id: string): void {
  const el = elementById(id);
  if (!el) return;
  noteJump(el);
  scrollToId(id, true);
  motion.flash(el, contentPane);
}

// Back (-1) or Forward (1). The place comes off its list only once it is on
// screen: opening it can be cancelled (unsaved edits), or its file be gone.
async function travel(dir: -1 | 1): Promise<void> {
  if (opening || switching) return;
  const place = dir < 0 ? navHistory.peekBack() : navHistory.peekForward();
  if (!place) return;
  const here = currentPlace();
  const commit = () => (dir < 0 ? navHistory.commitBack(here) : navHistory.commitForward(here));
  if (here && samePath(place.path, here.path)) {
    commit();
    if (!restoreRemembered(place.pos)) contentPane.scrollTop = 0;
    // while editing the editor goes there too, or its next scroll would pull
    // the preview back
    if (editing && place.pos.id) {
      const line = Number(elementById(place.pos.id)?.dataset.sourceLine);
      if (Number.isFinite(line)) editorMod?.scrollToLine(line);
    }
    toc.unpin();
    updateProgress();
    return;
  }
  // pasted text that is no longer here: nothing on disk to look for
  if (isPastedKey(place.path)) {
    navHistory.drop(dir);
    return;
  }
  const alive = await ipc.existingPaths([place.path]).catch(() => [place.path]);
  // another document started opening meanwhile: it goes first, and this
  // move would only be queued behind it and then undo it
  if (opening || switching) return;
  if (alive.length === 0) {
    navHistory.drop(dir);
    showNotice(t("msg.notFound", { name: fileName(place.path) }));
    return;
  }
  const result = await openFile(place.path, { restore: place.pos });
  if (result === "shown") commit();
  // unreadable (no permission, not text): no use stopping there again
  else if (result === "failed") navHistory.drop(dir);
}

const goBack = (): Promise<void> => travel(-1);
const goForward = (): Promise<void> => travel(1);

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

/* ---- more windows ---- */

// a new window for a file, or (path null) on the home; its Rust side cascades it
function openInNewWindow(path: string | null, opts: OpenOptions = {}): void {
  ipc.openWindow(path, { line: opts.line, anchor: opts.anchor }).catch((err) => {
    if (path && String(err) === ipc.NOT_FOUND) reportMissing(path);
    else showNotice(t("msg.windowFailed", { err: String(err) }), { kind: "error" });
  });
}

/* ---- tabs: one view, many documents ---- */

// a file picked inside a window: there, in a tab, or in a window of its own
function openFrom(path: string, e: MouseEvent, opts: OpenOptions = {}): void {
  openAt(path, whereFrom(e), opts);
}

function openAt(path: string, where: Where, opts: OpenOptions = {}): void {
  if (where === "tab") openInTab(path, { ...opts, background: true });
  else if (where === "tab-front") openInTab(path, opts);
  else if (where === "window") openInNewWindow(path, opts);
  else void navigate(path, opts);
}

// the rendered views kept for coming back to a tab at once (diagrams and all)
const KEEP_VIEWS = 6;
const winLabel = getCurrentWebviewWindow().label;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// the tab the latest activation asked for: a burst of them shows only the last
let pendingFront: session.Tab | null = null;

/** The tab in front, or the one about to be: new tabs go after it. */
function latestFront(): session.Tab {
  const p = pendingFront;
  return p && !p.closing && !p.leaving && session.tabs.includes(p) ? p : session.active();
}

// what a tab is called in questions and lists: its file's name, the pasted text's title, "New tab"
function tabName(tab: session.Tab): string {
  const src = tab.src;
  if (src.kind === "file") return fileName(src.path);
  return src.kind === "pasted" ? pastedName(src.paste) : t("tab.newTab");
}

// the key of a tab's recovery draft (docs.ts docKey); a start page has none
function draftKeyOf(tab: session.Tab): string | null {
  const src = tab.src;
  if (src.kind === "file") return src.path;
  return src.kind === "pasted" ? pastedKey(src.paste) : null;
}

// the tab shows (or is about to show) this file
const isTabOf = (tab: session.Tab, path: string): boolean => {
  const p = session.filePath(tab);
  return p !== null && samePath(p, path);
};

// a tab made from a path that may be none: that file, or a start page
const fileOrStart = (path: string | null): session.TabSource => (path !== null ? { kind: "file", path } : { kind: "start" });

const emptyTransfer = (path: string | null): TabTransfer => ({
  v: 1,
  path,
  anchor: null,
  editing: false,
  editor: null,
  nav: { back: [], forward: [] },
  find: null,
  tocFilter: "",
});

// A document asked for in the tab in front, unless another tab of this window
// shows it: that one comes forward instead (one file, one tab).
async function navigate(path: string, opts: OpenOptions = {}): Promise<void> {
  const open = session.findPath(path);
  if (open && open !== session.active()) {
    if (await activateTab(open)) jumpIn(opts);
    return;
  }
  await openFile(path, opts);
}

// a --line or a #heading asked for a document already on screen
function jumpIn(opts: OpenOptions): void {
  if (!currentDoc || article.hidden || errorShown) return;
  const landed =
    opts.anchor !== undefined ? scrollToId(opts.anchor) : opts.line !== undefined ? scrollToSourceLine(opts.line - 1) : null;
  if (landed) motion.flash(landed);
}

interface TabOpenOptions extends OpenOptions {
  /** behind the tab in front, which stays in front */
  background?: boolean;
  /** at the end of the strip (a file opened from outside), not after the tab in front */
  atEnd?: boolean;
  /** at this place among the tabs (files dropped on the strip) */
  index?: number;
  /** a query for the find bar, once the document is shown */
  find?: string;
}

// where background tabs go: after the ones opened from the same tab before
// them, as in a browser (reset when another tab comes forward)
let insertAfterTab: session.Tab | null = null;

/** A document in a tab of its own: in front, or behind the one in front. */
function openInTab(path: string, opts: TabOpenOptions = {}): void {
  const open = session.findPath(path);
  if (open) {
    if (opts.background) strip.pulse(open);
    else
      void activateTab(open).then((front) => {
        if (!front) return;
        jumpIn(opts);
        if (opts.find) search.openWith(opts.find);
      });
    return;
  }
  const front = latestFront();
  const tab = session.make(
    { kind: "file", path },
    opts.line !== undefined || opts.anchor !== undefined ? { line: opts.line, anchor: opts.anchor } : null,
  );
  if (opts.find) tab.transfer = { ...emptyTransfer(path), find: { open: true, query: opts.find } };
  if (!opts.background && session.isStartPage(front)) {
    // a start page in front becomes that document: the new tab takes its place
    session.insertAfter(tab, front);
    front.closing = true;
  } else if (opts.index !== undefined) {
    session.insert(tab, session.live()[opts.index] ?? null);
  } else if (opts.atEnd) {
    session.insert(tab);
  } else if (opts.background) {
    session.insertAfter(tab, insertAfterTab && session.live().includes(insertAfterTab) ? insertAfterTab : front);
    insertAfterTab = tab;
  } else {
    session.insertAfter(tab, front);
  }
  strip.render(tab);
  reportTabs();
  // a file gone since it was listed: said at once, and its tab goes
  void ipc
    .existingPaths([path])
    .then((alive) => {
      if (alive.length > 0 || tab.doc || tab.closing || session.filePath(tab) !== path) return;
      reportMissing(path);
      void releaseTab(tab);
    })
    .catch(() => {});
  if (opts.background) strip.pulse(tab);
  else void activateTab(tab);
}

/** A new tab on the start page (Ctrl+T, the +). */
function newStartTab(where: "end" | "after"): void {
  const tab = session.make({ kind: "start" });
  if (where === "end") session.insert(tab);
  else session.insertAfter(tab, latestFront());
  strip.render(tab);
  void activateTab(tab);
}

/* ---- paste and read: text from the clipboard, a document of its own ---- */

// A tab for pasted text reading `text`; `original` is the text as first
// pasted (a recovered draft's is older, so it counts as changed), `home` the
// folder "Save as…" starts in (the pane's, by default)
function makePastedTab(text: string, o: { id?: string; original?: string; home?: string | null } = {}): session.Tab {
  const paste: Pasted = {
    id: o.id ?? newPasteId(),
    original: o.original ?? text,
    title: pastedTitle(text),
    home: o.home !== undefined ? o.home : browseRoot,
  };
  const tab = session.make({ kind: "pasted", paste });
  tab.doc = pastedDoc(paste, text);
  return tab;
}

// Pasted text in a tab of its own, in front, placed as a file opened from
// within the window is: a start page in front becomes it, else it comes
// right after the tab in front
function openPasted(text: string): { tab: session.Tab; shown: Promise<boolean> } {
  const tab = makePastedTab(text);
  const front = latestFront();
  session.insertAfter(tab, front);
  if (session.isStartPage(front)) front.closing = true;
  strip.render(tab);
  reportTabs();
  return { tab, shown: activateTab(tab) };
}

// What the clipboard held, as the Markdown to open (pasteConvert.ts, loaded on the
// first paste): a selection copied from a chat page through its HTML, a terminal's
// tables, a ```markdown wrapper, \( \) math. Its own failure falls back to the text.
async function pastedMarkdown(raw: string | null, html: string | null): Promise<{ markdown: string; plain: string; changed: boolean }> {
  const plain = pastedText(raw ?? "");
  try {
    const { convertPaste } = await import("./pasteConvert");
    const r = await convertPaste({ text: raw, html });
    return { markdown: r.markdown, plain: r.plain, changed: r.changes.length > 0 && r.markdown !== r.plain };
  } catch {
    return { markdown: plain, plain, changed: false };
  }
}

// Every way of pasting ends here: Ctrl+V's text, or the clipboard as Rust
// read it (the start page's button, the palette). Nothing to read, or a
// picture alone, is said so; text next to a picture (Excel copies both) is read.
async function openPastedOrSay(raw: string | null, image: boolean, html: string | null = null): Promise<void> {
  const { markdown, plain, changed } = await pastedMarkdown(raw, html);
  if (!markdown.trim()) {
    sayAboutPaste(t(image ? "msg.pasteImage" : "msg.pasteEmpty"), "info");
    return;
  }
  const { tab, shown } = openPasted(markdown);
  if (!changed) {
    notices.announce(t("msg.pastedOpened", { name: tabName(tab) }));
    return;
  }
  // said once the tab is in front (bringing it there clears the notice bar), with the
  // way back to the text exactly as it was copied
  if (!(await shown) || session.active() !== tab) return;
  const doc = tab.doc;
  if (!doc || doc.path !== null) return;
  // a clipboard with HTML and no plain text has nothing "as copied" to show
  const action = plain.trim() ? { label: t("msg.pasteAsCopied"), fn: () => showPastedAsCopied(tab, doc.paste, plain) } : undefined;
  showNotice(t("msg.pastedConverted", { name: tabName(tab) }), { kind: "info", action });
}

// "Show as copied": the pasted tab reads the clipboard's plain text instead of the
// Markdown made of it, as untouched (it is what was pasted now), titled after it
function showPastedAsCopied(tab: session.Tab, paste: Pasted, plain: string): void {
  hideNotice(true);
  if (session.active() !== tab || !currentDoc || currentDoc.path !== null || currentDoc.paste !== paste) return;
  if (editing || frontChanged()) return;
  paste.original = plain;
  currentDoc = pastedDoc(paste, plain);
  tab.doc = currentDoc;
  void updatePreview(plain).then(() => {
    followPastedTitle();
    updateTitles();
  });
}

// What a paste that opened nothing says: on the notice bar, unless the bar
// holds a notice of the document's own (a draft to restore, a change on disk),
// which stays; then only heard
function sayAboutPaste(message: string, kind: "info" | "error"): void {
  if (notices.snapshot()) notices.announce(message, kind === "error" ? "assertive" : "polite");
  else showNotice(message, { kind });
}

// the start page's button and the palette's command: the clipboard as Rust reads it
async function pasteFromClipboard(): Promise<void> {
  try {
    const clip = await ipc.readClipboardText();
    await openPastedOrSay(clip.text, clip.image, clip.html ?? null);
  } catch (err) {
    // another program holding the clipboard is a moment's wait, not a failure
    if (String(err) === ipc.CLIPBOARD_BUSY) sayAboutPaste(t("msg.pasteBusy"), "info");
    else sayAboutPaste(t("msg.pasteFailed", { err: String(err) }), "error");
  }
}

// Ctrl+V and Shift+Insert anywhere but where they paste into text: the page's own paste event
function onPaste(e: ClipboardEvent): void {
  if (e.defaultPrevented || !pasteWelcome() || !e.clipboardData) return;
  e.preventDefault();
  const data = e.clipboardData;
  const image = [...data.items].some((i) => i.kind === "file" && i.type.startsWith("image/"));
  // the HTML a page copies beside its text: read now, the event's data is gone after it
  const html = data.types.includes("text/html") ? data.getData("text/html") : "";
  void openPastedOrSay(data.getData("text/plain"), image, html || null);
}

// not in the editor (its format bar included) or a text field, and nothing in
// the way: a dialog or the palette open, a tab in hand, the window closing
function pasteWelcome(): boolean {
  const el = document.activeElement;
  if (isTextEditable(el) || (el !== null && editorPane.contains(el))) return false;
  if (document.querySelector("dialog[open]") || lightbox.isOpen()) return false;
  return session.hasActive() && !strip.dragging() && !closingWindow;
}

// pasted text is called after its text until it is saved: a new first heading renames its tab
function followPastedTitle(): void {
  if (!currentDoc || currentDoc.path !== null) return;
  const paste = currentDoc.paste;
  const title = pastedTitle(frontText());
  if (title === paste.title) return;
  paste.title = title;
  strip.render();
  updateTitles();
}

// After a crash: pasted text changed and never saved comes back by itself,
// once, as the first window starts (not again after a language reload),
// unless another window has it open. Nothing is asked: a question would take
// the notice bar from a file's own (its draft to restore, a change on disk),
// and an offer left unanswered, or withdrawn by the next document, would
// leave the only copy of the text behind.
const RECOVERY_KEY = "pasted-drafts-offered";

const lf = (s: string): string => s.replace(/\r\n/g, "\n");

async function recoverPastedDrafts(): Promise<void> {
  if (winLabel !== "main") return;
  try {
    if (sessionStorage.getItem(RECOVERY_KEY)) return;
    sessionStorage.setItem(RECOVERY_KEY, "1");
  } catch {
    return;
  }
  const keys = drafts.keys().filter((k) => isPastedKey(k) && !session.tabs.some((x) => draftKeyOf(x)?.toLowerCase() === k));
  if (keys.length === 0) return;
  const elsewhere = await Promise.all(keys.map(editedElsewhere));
  const found = keys
    .filter((_k, i) => !elsewhere[i])
    .map((key) => ({ key, draft: drafts.get(key) }))
    .filter((f): f is { key: string; draft: drafts.Draft } => {
      if (f.draft === null) return false;
      // changed back to the text as pasted (undone just before its tab
      // closed): nothing was lost, the draft goes
      const kept = f.draft.text.trim() !== "" && lf(f.draft.text) !== lf(f.draft.base);
      if (!kept) drafts.remove(f.key);
      return kept;
    })
    // in the order they were last changed
    .sort((a, b) => a.draft.at - b.draft.at);
  if (found.length === 0) return;
  restorePasted(found);
  const said = found.length === 1 ? t("msg.pastedRecovered") : t("msg.pastedRecoveredN", { n: found.length });
  // shown where nothing else is; heard in any case
  if (!notices.visible()) showNotice(said, { kind: "info" });
  else notices.announce(said);
}

// The recovered texts in tabs, after the one in front and in order, each
// with its dot: a start page in front gives its place to the first, a
// document in front (one opened from File Explorer) stays there. Each keeps
// its id, so its draft goes on under the same key.
function restorePasted(found: { key: string; draft: drafts.Draft }[]): void {
  if (!session.hasActive()) return;
  const front = latestFront();
  let after = front;
  const made = found.map(({ key, draft }) => {
    const tab = makePastedTab(draft.text, { id: pastedIdOf(key), original: draft.base, home: null });
    tab.dirty = tabDirty(tab);
    session.insertAfter(tab, after);
    after = tab;
    return tab;
  });
  const takesFront = session.isStartPage(front);
  if (takesFront) front.closing = true;
  strip.render(takesFront ? made[0] : undefined);
  reportTabs();
  if (takesFront) void activateTab(made[0]);
  for (const tab of takesFront ? made.slice(1) : made) strip.pulse(tab);
}

// Tab switches, one at a time and in order: each waits for the one before,
// for a document still opening, and for a PDF or an export of the tab in front.
let tabQueue: Promise<unknown> = Promise.resolve();
// exports and copies read the article: no tab comes forward under them
let tabHolds = 0;

/** Brings a tab to the front. True once it is there (false: another one was asked for after it, or it went). */
function activateTab(tab: session.Tab): Promise<boolean> {
  pendingFront = tab;
  const run = async (): Promise<boolean> => {
    if (session.hasActive() && session.active() === tab) return true;
    while ((opening || pdfInProgress || tabHolds > 0) && pendingFront === tab) await sleep(20);
    // a later activation was asked for: that one comes forward instead
    if (pendingFront !== tab || tab.closing || tab.leaving || !session.tabs.includes(tab)) return false;
    switching = true;
    try {
      closeMenus();
      if (lightbox.isOpen()) lightbox.close();
      if (session.hasActive()) suspendView(session.active());
      session.setActive(tab);
      insertAfterTab = null;
      strip.render();
      strip.revealActive();
      await resumeView(tab);
      session.trimViews(KEEP_VIEWS);
    } finally {
      switching = false;
    }
    reportTabs();
    drainQueuedOpen();
    return session.active() === tab;
  };
  const p = tabQueue.then(run, run);
  tabQueue = p.catch(() => {});
  return p;
}

// The tab leaving the front takes along what the view shows of it; the view
// is then empty for the next one.
function suspendView(tab: session.Tab): void {
  // what the palette lists (the headings above all) is the old tab's
  closePalette();
  sectionLine.hideNow();
  strip.hideCard();
  clearTimeout(previewTimer);
  previewGen++;
  clearTimeout(rememberTimer);
  if (tab.closing) {
    // closeTab has dealt with its edits: no draft is left behind
    clearTimeout(draftTimer);
    draftTimer = undefined;
  } else flushDraft();
  const shows = currentDoc !== null && !article.hidden && !errorShown;
  const here = shows ? captureScrollAnchor(contentPane, article) : null;
  if (currentDoc?.path && here && !editing) positions.remember(currentDoc.path, here);
  const snap = editing && editorMod ? editorMod.snapshot() : null;
  // pasted text changed while reading (a box ticked, edits kept) has no snapshot to say so
  const changed = frontChanged();
  // the preview of the last keystrokes never came (its timer is cleared above):
  // left in the editor, it is drawn when the tab comes back; left after the
  // editor closed (within 200 ms of typing), the article lags behind the
  // text, so it is not kept: the tab is drawn again from its text
  const lagging = previewDirty;
  previewDirty = false;
  const view: session.TabView = {
    anchor: here,
    fragment: null,
    scheme: theme.schemeOf(theme.current()),
    editing,
    editor: snap,
    nav: navHistory.exportState(),
    find: search.state(),
    tocFilter: tocFilter.value,
    notice: notices.snapshot(),
    error: errorShown ? (article.textContent ?? "") : null,
    docGone,
    treeRoot: browseRoot,
    previewStale: editing && lagging,
  };
  // the find bar marks ranges of this article: cleared before it goes
  search.close();
  if (shows && !tab.closing && (editing || !lagging)) {
    const frag = document.createDocumentFragment();
    frag.append(...article.childNodes);
    view.fragment = frag;
  } else {
    article.replaceChildren();
  }
  tab.doc = currentDoc;
  tab.view = view;
  if (currentDoc && !docMeta.hidden) tab.meta = docMeta.textContent ?? "";
  // the notice bar, emptied for the next tab; a tab closing leaves a passing
  // notice where it is ("not found"), not one of its own sticky ones
  if (!tab.closing || notices.snapshot()) hideNotice(true);
  if (editing) leaveEditLayout();
  // the editor between tabs: empty, with nothing to save (the tab keeps its snapshot)
  editorMod?.setContent("");
  tab.dirty = tab.src.kind === "pasted" ? changed : (snap?.dirty ?? false);
  currentDoc = null;
  errorShown = false;
  docGone = false;
}

// A tab coming to the front puts its state back into the view: at once from
// its rendered article, or rendered again; its file read the first time.
async function resumeView(tab: session.Tab): Promise<void> {
  const v = tab.view;
  tab.view = null;
  navHistory.importState(v?.nav ?? null);
  if (tab.src.kind === "start") {
    showStartPage();
    return;
  }
  const doc = tab.doc;
  if (!doc) {
    // a file is read the first time its tab comes forward; pasted text
    // comes with its tab, so one without it has nothing to show
    if (tab.src.kind === "file") await loadFirstTime(tab, tab.src.path);
    else showStartPage();
    return;
  }
  currentDoc = doc;
  docGone = v?.docGone ?? false;
  if (v?.error) {
    showError(v.error);
  } else {
    emptyState.hidden = true;
    article.hidden = false;
    article.classList.remove("doc-enter");
    const scheme = theme.schemeOf(theme.current());
    if (v?.fragment) {
      article.replaceChildren(v.fragment);
      // drawn for the other scheme while it was behind: pictures and diagrams follow
      if (v.scheme !== scheme) {
        applyScheme(article, scheme);
        rerenderForTheme(article, scheme === "dark").catch(() => {});
      }
    } else {
      const text = v?.editing && v.editor && editorMod ? editorMod.snapshotText(v.editor) : doc.content;
      await render({ ...doc, content: text }, article);
      placeDrawnDiagrams(article, theme.isDark());
      lightbox.markAll(article);
      renderMermaidIn(article, theme.isDark())
        .then(() => {
          if (session.active() !== tab) return;
          lightbox.markAll(article);
          wide.markWide(article);
          updateProgress();
        })
        .catch(() => {});
    }
  }
  // the split view first: the place is measured in the layout it is read in
  if (v?.editing && v.editor) await resumeEditing(v.editor);
  const headings = toc.build(article, tocList, contentPane);
  app.classList.toggle("no-headings", headings === 0);
  sectionLine.rebuild();
  tocFilter.value = v?.tocFilter ?? "";
  setupTocFilter(headings, true);
  panes.refresh();
  wide.markWide(article);
  updateDocMeta();
  // the tab's own place in its own document, even if the file changed while it was behind
  if (!restoreRemembered(v?.anchor ?? null, true)) contentPane.scrollTop = 0;
  if (editing && v?.previewStale && editorMod) void updatePreview(editorMod.currentText());
  search.restore(v?.find ?? null);
  if (v?.notice) showNotice(v.notice.message, v.notice.opts);
  else if (docGone) showGoneNotice();
  // the file pane shows the tab's folder (pasted text's: the one it was pasted
  // over, if any; with none, the pane stays as it was)
  const root = v?.treeRoot ?? (doc.path !== null ? doc.dir : doc.paste.home);
  if (root !== null && (!browseRoot || !samePath(root, browseRoot))) {
    browseRoot = root;
    void refreshTree();
  } else if (doc.path === null) clearTreeActive();
  else if (!tree.setActive(treeRoot, doc.path)) void refreshTree();
  updateTitles();
  updateProgress();
  if (!v && tab.src.kind === "pasted") await firstShowPasted(tab);
  // changed on disk while it was behind: read again, never over unsaved edits
  if (tab.stale && doc.path !== null) {
    tab.stale = false;
    void sameOnDisk(doc).then((same) => {
      if (same || session.active() !== tab || currentDoc !== doc) return;
      if (editing && editorMod?.isDirty()) showFileChangedNotice();
      else if (editing) void reloadFromDisk();
      // queued behind this switch, then read into this tab
      else void openFile(doc.path, { preserveScroll: true });
    });
  }
  void checkDocOnDisk();
}

// A tab read for the first time: a tab opened behind another, or one that
// came from another window (its place, its edits) or from a closed tab.
async function loadFirstTime(tab: session.Tab, path: string): Promise<void> {
  const at = tab.at ?? {};
  tab.at = null;
  const tr = tab.transfer;
  tab.transfer = null;
  opening = true;
  let result: OpenResult;
  try {
    result = await loadDoc(path, { line: at.line, anchor: at.anchor, restore: tr?.anchor ?? undefined });
  } finally {
    opening = false;
  }
  if (result === "shown") {
    if (tr) await applyTransfer(tr);
    return;
  }
  // gone: a tab of its own is no use (a notice said why); an unreadable file
  // keeps its tab, with the card that says what went wrong
  if (result === "failed" && !currentDoc && !errorShown) {
    if (session.live().length > 1) void releaseTab(tab);
    else {
      tab.src = { kind: "start" };
      strip.render();
      reportTabs();
      showStartPage();
    }
  }
}

// Pasted text on screen for the first time (just pasted, reopened, carried
// from another window or across a language reload): what came with it (the
// place, the edits and their undo, Back and Forward, the find bar), or else
// the entrance of a document just opened. A read like any document's.
async function firstShowPasted(tab: session.Tab): Promise<void> {
  const tr = tab.transfer;
  tab.transfer = null;
  if (tr) {
    if (tr.anchor && !restoreRemembered(tr.anchor)) contentPane.scrollTop = 0;
    await applyTransfer(tr);
  } else if (windowShown) {
    void article.offsetWidth; // restart the entrance animation
    article.classList.add("doc-enter");
  }
  search.onContentChanged();
  rating.noteOpen();
  scheduleRatePrompt();
}

// The editor's code, loaded and put in its pane the first time it is needed.
async function ensureEditor(): Promise<boolean> {
  try {
    editorMod ??= await import("./editor");
  } catch (err) {
    // the editor chunk loads on first use; say so instead of silently doing nothing
    showNotice(t("msg.editorLoadFailed", { err: String(err) }), { kind: "error" });
    return false;
  }
  editorMod.mount(editorPane, {
    onDocChanged: () => {
      schedulePreview();
      scheduleDraft();
      dropReloadedNotice();
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
      void saveFile();
    },
    onImagePasted: (file) => {
      void insertPastedImage(file);
    },
  });
  return true;
}

// The split view of a tab coming back: its editor with its text, undo and
// place (the preview already shows its text: the article came back too).
async function resumeEditing(snap: Snapshot): Promise<void> {
  if (!(await ensureEditor()) || !editorMod) return;
  syncSuppressedUntil = performance.now() + 200;
  editorMod.restore(snap);
  editing = true;
  search.close();
  app.classList.add("editing");
  sectionLine.hideNow();
  panes.refresh();
  syncEditButton();
  collectPreviewAnchors();
  updateTitles();
  // typing goes on in the editor, as a browser gives the page the keys after a tab click
  const focused = document.activeElement;
  if (!focused || focused === document.body || strip.hasFocus()) editorMod.focus();
}

// The split view goes; the editor's text stays the tab's, in its snapshot.
function leaveEditLayout(): void {
  editing = false;
  app.classList.remove("editing");
  panes.refresh();
  syncEditButton();
}

// the tab in front is a start page: no document, the recent files
function showStartPage(): void {
  currentDoc = null;
  docGone = false;
  showEmpty();
  app.classList.add("no-headings");
  tocList.replaceChildren();
  setupTocFilter(0, false);
  clearTreeActive();
  updateTitles();
  sectionLine.refresh();
}

// no file of the pane is the one on screen (a start page, pasted text)
function clearTreeActive(): void {
  treeRoot.querySelector(".tree-row.active")?.classList.remove("active");
}

// the tab in front follows its document (a link followed, a file renamed)
function syncFrontTab(): void {
  if (!session.hasActive() || !currentDoc) return;
  // pasted text is what its tab was made with: there is no file to follow
  if (currentDoc.path === null) return;
  const tab = session.active();
  if (session.filePath(tab) === currentDoc.path) return;
  tab.src = { kind: "file", path: currentDoc.path };
  strip.render();
}

/**
 * Rust learns which files the window shows, to route launches to them and
 * watch them, and how many tabs hold pasted text (a window with one is no
 * free start page for a file opened from outside).
 */
function reportTabs(): void {
  if (!session.hasActive()) return;
  const live = session.live();
  const paths = live.map(session.filePath).filter((p): p is string => p !== null);
  const pasted = live.filter((x) => x.src.kind === "pasted").length;
  ipc.setTabs(paths, session.filePath(latestFront()), pasted).catch(() => {});
  ipc.watchFiles(paths).catch(() => {});
}

// The text of the document in front as it is now, "\n" line ends: the
// editor's while editing.
function frontText(): string {
  if (editing && editorMod) return editorMod.currentText();
  return (currentDoc?.content ?? "").replace(/\r\n/g, "\n");
}

// The document in front holds what is not kept anywhere else: a file's edits
// not saved; pasted text that is no longer as it was pasted.
function frontChanged(): boolean {
  if (currentDoc && currentDoc.path === null) return frontText() !== currentDoc.paste.original;
  return editing && !!editorMod?.isDirty();
}

// a tab with edits not saved: the one in front by its editor, the others by
// their snapshot, or (brought from another window, or across a language
// reload, and not shown here yet) by what they came with
function tabDirty(tab: session.Tab): boolean {
  if (session.hasActive() && tab === session.active()) return frontChanged();
  const carried = !tab.view && tab.transfer?.editor?.dirty === true;
  if (tab.src.kind === "pasted") {
    const ed = tab.view?.editor;
    const text = ed ? ed.state.doc.toString() : (tab.doc?.content ?? tab.src.paste.original);
    return carried || text !== tab.src.paste.original;
  }
  return tab.view?.editor?.dirty ?? carried;
}

// "a.md, b.md and c.md", in the words of the interface
const fileNames = (tabs: session.Tab[]): string => listFormat(tabs.map(tabName));

// Intl.ListFormat is newer than the library the code is typed against (WebView2 has it)
const listFormat = (items: string[]): string => {
  const LF = (Intl as unknown as { ListFormat?: new (l: string, o: object) => { format(i: string[]): string } }).ListFormat;
  return LF ? new LF(i18n.current(), { type: "conjunction" }).format(items) : items.join(", ");
};

// What a closing window would take with it: edits not saved, and pasted
// text, changed or not (it is in no file, and Ctrl+Shift+T goes with the
// window). Only the window asks by it: a tab's own close, its dot, the other
// windows and the tests go by tabDirty.
const goesWithWindow = (tab: session.Tab): boolean => tabDirty(tab) || tab.src.kind === "pasted";

// The closing window's question. Documents with unsaved changes keep the
// words they have always had; pasted text never changed has none unsaved, so
// it is named for what it is, alone or after the changed ones.
function closeWindowQuestion(tabs: session.Tab[]): { text: string; title: string } {
  const changed = tabs.filter(tabDirty);
  const pasted = tabs.filter((x) => !changed.includes(x));
  if (pasted.length === 0) {
    const one = changed.length === 1;
    return {
      text: one ? t("msg.closeWindowOneQ", { name: fileNames(changed) }) : t("msg.closeWindowQ", { names: fileNames(changed) }),
      title: t("msg.discardTitle"),
    };
  }
  const text =
    changed.length > 0
      ? t("msg.closeWindowMixedQ", { changed: fileNames(changed), pasted: fileNames(pasted) })
      : pasted.length === 1
        ? t("msg.closeWindowPastedOneQ", { name: fileNames(pasted) })
        : t("msg.closeWindowPastedQ", { names: fileNames(pasted) });
  return { text, title: t("msg.unsavedTextTitle") };
}

// Saves a tab's edits, in front or not. True when saved.
async function saveTab(tab: session.Tab): Promise<boolean> {
  const saveFront = async (): Promise<boolean> => {
    // saved as it closes (its own tab, or the window)
    if (currentDoc?.path === null) return saveAsFront({ closing: true });
    await saveFile();
    return !frontChanged();
  };
  if (session.hasActive() && tab === session.active()) return saveFront();
  // pasted text ("Save as…" asks where), or a tab not shown here yet (its
  // edits came with it from another window): saved in front, what it is about on screen
  if (tab.src.kind === "pasted" || !tab.view) return (await activateTab(tab)) && (await saveFront());
  const snap = tab.view?.editor;
  const doc = tab.doc;
  if (!doc || doc.path === null || !snap || !editorMod) return true;
  const content = editorMod.snapshotText(snap);
  try {
    const modified = await writeDocument(doc, content, tab.view?.docGone ?? false);
    if (modified === null) return false;
    wroteAsUtf8(doc);
    savedBehind(doc, content, modified);
    if (tab.view) tab.view.docGone = false;
    return true;
  } catch (err) {
    showNotice(t("msg.saveFailed", { err: String(err) }), { kind: "error" });
    return false;
  }
}

// A save that ended with its tab behind another one (or of a tab behind):
// its file, its baseline and its dot follow, as in front.
function savedBehind(doc: ipc.MarkdownDoc, content: string, modified: number): void {
  const tab = session.tabs.find((x) => x.doc === doc);
  const snap = tab?.view?.editor;
  if (tab) tab.doc = { ...doc, content, modified };
  if (tab && snap) {
    snap.lastSaved = content.replace(/\r\n/g, "\n");
    snap.dirty = snap.state.doc.toString() !== snap.lastSaved;
    tab.dirty = snap.dirty;
  }
  if (!snap?.dirty) drafts.remove(doc.path);
  strip.render();
}

// Save / Don't save / Cancel (labelled: without labels Windows writes Yes/No in its own language)
async function askSave(text: string, saveLabel: string, title = t("msg.discardTitle")): Promise<"save" | "discard" | "cancel"> {
  const answer = await message(text, {
    title,
    kind: "warning",
    buttons: { yes: saveLabel, no: t("msg.dontSave"), cancel: t("msg.cancel") },
  }).catch(() => "Cancel");
  if (answer === saveLabel || answer === "Yes") return "save";
  if (answer === t("msg.dontSave") || answer === "No") return "discard";
  return "cancel";
}

/** Closes a tab, asking first about unsaved edits; the start page left alone closes the window. */
async function closeTab(tab: session.Tab, opts: { pointer?: boolean } = {}): Promise<"closed" | "kept"> {
  if (tab.closing || tab.leaving || !session.tabs.includes(tab)) return "kept";
  // the lone start page closes the window (lone pasted text leaves a start page, below)
  if (session.live().length === 1 && tab.src.kind === "start") {
    void getCurrentWindow().close().catch(() => {});
    return "kept";
  }
  if (tabDirty(tab)) {
    // what it is about must be on screen while it is asked
    if (tab !== session.active()) await activateTab(tab);
    const choice = await askSave(t("msg.closeTabQ", { name: tab.src.kind === "start" ? "" : tabName(tab) }), t("msg.save"));
    if (choice === "cancel") return "kept";
    if (choice === "save" && !(await saveTab(tab))) return "kept";
    const key = draftKeyOf(tab);
    if (choice === "discard" && key) drafts.remove(key);
  } else if (tab.src.kind === "pasted") {
    // as pasted (changed back, perhaps, within the second its draft waits):
    // nothing is left for the next start to bring back
    drafts.remove(pastedKey(tab.src.paste));
  }
  if (tab.closing) return "kept";
  const front = session.hasActive() && session.active() === tab;
  const anchor = front ? (currentPlace()?.pos ?? null) : (tab.view?.anchor ?? null);
  session.rememberClosed(tab, session.live().indexOf(tab), anchor);
  if (opts.pointer) strip.freezeWidths();
  await releaseTab(tab, { discard: true });
  return "closed";
}

// A tab leaves the window (closed, or moved to another one): its neighbour
// takes the front; the last one leaves a start page behind.
async function releaseTab(tab: session.Tab, opts: { discard?: boolean } = {}): Promise<void> {
  if (tab.closing) return;
  const list = session.tabs.filter((x) => x === tab || (!x.closing && !x.leaving));
  const index = list.indexOf(tab);
  // its edits do not stay in this window: the editor must not answer for them
  if (opts.discard && session.hasActive() && session.active() === tab && editing && currentDoc) {
    editorMod?.setContent(currentDoc.content);
  }
  tab.closing = true;
  tab.leaving = false;
  let activation: Promise<boolean> | null = null;
  const target = pendingFront && session.tabs.includes(pendingFront) ? pendingFront : session.hasActive() ? session.active() : null;
  if (!target || target === tab || target.closing) {
    const next = list[index + 1] ?? list[index - 1];
    if (next && next !== tab) activation = activateTab(next);
    else {
      const home = session.make({ kind: "start" });
      session.insertAfter(home, tab);
      activation = activateTab(home);
    }
  }
  strip.render();
  reportTabs();
  if (activation) await activation;
}

function closeOthers(keep: session.Tab): void {
  void (async () => {
    await activateTab(keep);
    for (const x of session.live()) if (x !== keep && (await closeTab(x)) === "kept") return;
  })();
}

function closeRight(of: session.Tab): void {
  void (async () => {
    const list = session.live();
    for (const x of list.slice(list.indexOf(of) + 1).reverse()) if ((await closeTab(x)) === "kept") return;
  })();
}

/** Ctrl+Shift+T: the last closed tab, back where it was and at the place it was read. */
function reopenTab(): void {
  const last = session.closed.pop();
  if (!last) return;
  const src = last.src;
  // a file's tab, or pasted text as it was pasted (its id too) and where it was read
  const open =
    src.kind === "file"
      ? session.findPath(src.path)
      : session.live().find((x) => x.src.kind === "pasted" && x.src.paste.id === src.paste.id);
  if (open) {
    void activateTab(open);
    return;
  }
  const tab =
    src.kind === "file" ? session.make(src) : makePastedTab(src.paste.original, { id: src.paste.id, home: src.paste.home });
  if (last.anchor) tab.transfer = { ...emptyTransfer(src.kind === "file" ? src.path : null), anchor: last.anchor };
  session.insert(tab, session.live()[last.index] ?? null);
  strip.render(tab);
  reportTabs();
  void activateTab(tab);
}

function stepTab(dir: 1 | -1): void {
  const list = session.live();
  if (list.length < 2) return;
  const i = list.indexOf(latestFront());
  void activateTab(list[(i + dir + list.length) % list.length]);
}

// Ctrl+1…8: that tab; Ctrl+9 (i -1): the last one
function nthTab(i: number): void {
  const list = session.live();
  const tab = i < 0 ? list[list.length - 1] : list[i];
  if (tab) void activateTab(tab);
}

function moveTab(dir: 1 | -1): void {
  const list = session.live();
  const tab = latestFront();
  const i = list.indexOf(tab);
  if (i < 0 || i + dir < 0 || i + dir >= list.length) return;
  session.move(tab, i + dir);
  strip.render();
  strip.revealActive();
  reportTabs();
}

// Ctrl+W, Ctrl+F4: a preview or a dialog first, then the tab
function closeTabByKey(): void {
  if (paletteOpen()) {
    closePalette();
    return;
  }
  if (lightbox.isOpen()) {
    lightbox.close();
    return;
  }
  if (helpDialog.open || keysDialog.open) {
    helpDialog.close();
    keysDialog.close();
    return;
  }
  strip.cancelDrag();
  if (session.hasActive()) void closeTab(latestFront());
}

// The tab keys, as in a browser. Never with a dialog open (the handler returns
// before this), as AltGr (Ctrl+Alt) or while an IME composes. The digits go by
// the key's place, so Ctrl+& is tab 1 on AZERTY; in the editor Ctrl+1–3 are
// its headings (it has taken them before this).
function handleTabKey(e: KeyboardEvent): boolean {
  if (!e.ctrlKey || e.altKey || e.metaKey || composing(e) || !session.hasActive()) return false;
  let act: (() => void) | null = null;
  let repeats = false;
  if (e.key === "Tab") {
    act = () => stepTab(e.shiftKey ? -1 : 1);
    repeats = true;
  } else if (e.key === "PageDown" || e.key === "PageUp") {
    const dir = e.key === "PageDown" ? 1 : -1;
    act = e.shiftKey ? () => moveTab(dir) : () => stepTab(dir);
    repeats = true;
  } else if (keyIs(e, "t")) {
    act = e.shiftKey ? reopenTab : () => newStartTab("end");
  } else if (!e.shiftKey) {
    // a numpad digit only as a digit: without Num Lock it is End, Home, the arrows;
    // no physical key reported (on-screen keyboards, remote desktops): Windows' key code
    const digit =
      /^Digit([1-9])$/.exec(e.code)?.[1] ??
      (/^Numpad[1-9]$/.test(e.code) && /^[1-9]$/.test(e.key) ? e.key : null) ??
      (!e.code && e.keyCode >= 49 && e.keyCode <= 57 ? String(e.keyCode - 48) : null);
    if (digit) act = () => nthTab(digit === "9" ? -1 : Number(digit) - 1);
  }
  if (!act) return false;
  e.preventDefault();
  // held down, Ctrl+Tab goes on through the tabs; the others act once
  if (e.repeat && !repeats) return true;
  strip.cancelDrag();
  act();
  return true;
}

/* ---- tabs between windows ---- */

// A tab as it travels: the place, the edits (undo too), Back/Forward, the find bar.
function transferOf(tab: session.Tab): TabTransfer {
  const front = session.hasActive() && tab === session.active();
  const v = tab.view;
  // never shown here: what it was brought with, pasted text with its text
  // (one reopened by Ctrl+Shift+T came with its place only)
  if (!front && !v && tab.transfer) {
    const s = tab.src;
    if (s.kind !== "pasted" || tab.transfer.pasted) return tab.transfer;
    return { ...tab.transfer, pasted: { ...s.paste, content: tab.doc?.content ?? s.paste.original } };
  }
  const snap = front ? (editing && editorMod ? editorMod.snapshot() : null) : (v?.editor ?? null);
  const doc = front ? currentDoc : tab.doc;
  // pasted text travels whole: there is no file for the other window to read
  const src = tab.src;
  const pasted =
    src.kind === "pasted" ? { ...src.paste, content: doc?.content ?? src.paste.original } : undefined;
  return {
    v: 1,
    path: session.filePath(tab),
    ...(pasted ? { pasted } : {}),
    anchor: front ? (currentPlace()?.pos ?? null) : (v?.anchor ?? null),
    editing: front ? editing : (v?.editing ?? false),
    editor:
      snap && editorMod ? { ...editorMod.snapshotToJSON(snap), baseModified: doc?.modified ?? 0, dirty: snap.dirty } : null,
    nav: front ? navHistory.exportState() : (v?.nav ?? { back: [], forward: [] }),
    find: front ? search.state() : (v?.find ?? null),
    tocFilter: front ? tocFilter.value : (v?.tocFilter ?? ""),
  };
}

// What came with a tab from another window (or across a language reload),
// laid over its document once read: the place came with loadDoc already.
async function applyTransfer(tr: TabTransfer): Promise<void> {
  navHistory.importState(tr.nav);
  if (tr.editing && currentDoc) {
    if (tr.editor && (await ensureEditor()) && editorMod) {
      const snap = editorMod.snapshotFromJSON(tr.editor);
      syncSuppressedUntil = performance.now() + 200;
      editorMod.restore(snap);
      editing = true;
      search.close();
      app.classList.add("editing");
      sectionLine.hideNow();
      panes.refresh();
      syncEditButton();
      collectPreviewAnchors();
      const disk = currentDoc.content.replace(/\r\n/g, "\n");
      if (tr.editor.lastSaved !== disk && currentDoc.path !== null) {
        // the file changed on disk since the other window read it: the save
        // guard keeps that window's baseline, and the change is reported
        const base = tr.editor.eol === "\r\n" ? tr.editor.lastSaved.replace(/\n/g, "\r\n") : tr.editor.lastSaved;
        currentDoc = { ...currentDoc, content: base, modified: tr.editor.baseModified };
        if (snap.dirty) showFileChangedNotice();
        else void reloadFromDisk();
      }
      if (editorMod.currentText() !== disk) void updatePreview(editorMod.currentText());
      updateTitles();
      // a tab carried into this window goes on being typed in
      const focused = document.activeElement;
      if (!focused || focused === document.body || strip.hasFocus()) editorMod.focus();
    } else await enterEditMode();
  }
  if (tr.tocFilter) {
    tocFilter.value = tr.tocFilter;
    // the outline's entries are buttons: counted by its headings
    setupTocFilter(toc.headings().length, true);
  }
  search.restore(tr.find);
}

// tabs that left for another window, until that window says it has them
const pendingMoves = new Map<string, session.Tab>();
const newToken = (): string => `${winLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
// the window is closing (asked, or gone into another one): nothing comes in
let closingWindow = false;

/** A tab pulled off the strip: a window of its own, born under the pointer, which carries it on. */
async function tearOff(tab: session.Tab, at: { x: number; y: number } | null, follow: boolean): Promise<void> {
  if (session.live().length < 2 || tab.closing || tab.leaving) return;
  const transfer = transferOf(tab);
  const token = newToken();
  pendingMoves.set(token, tab);
  const wasFront = latestFront() === tab;
  const list = session.live();
  const i = list.indexOf(tab);
  tab.leaving = true;
  strip.render();
  // it leaves the front: its neighbour comes forward meanwhile
  if (wasFront) {
    const rest = list.filter((x) => x !== tab);
    void activateTab(rest[Math.min(i, rest.length - 1)]);
  }
  try {
    // pasted text has no file to name the ghost over another window's strip: its title does
    const title = tab.src.kind === "pasted" ? tabName(tab) : undefined;
    await ipc.openWindow(session.filePath(tab), { transfer, from: winLabel, token, at: at ?? undefined, follow, title });
  } catch (err) {
    pendingMoves.delete(token);
    tab.leaving = false;
    strip.render();
    showNotice(t("msg.tearOffFailed", { err: String(err) }), { kind: "error" });
    return;
  }
  // never arrived: it stays here
  setTimeout(() => {
    if (pendingMoves.get(token) !== tab) return;
    pendingMoves.delete(token);
    tab.leaving = false;
    strip.render();
  }, 15000);
}

// a tab let go over this window's strip: it comes in at that place
async function acceptOffer(o: TabOffer): Promise<void> {
  strip.hideGhost();
  const reply = (ok: boolean, reason: TabAccepted["reason"] = null): void => {
    ipc.sendTabAccepted(o.from, { token: o.token, ok, reason }).catch(() => {});
  };
  if (closingWindow || !session.hasActive()) {
    reply(false, "closing");
    return;
  }
  const tr = o.transfer;
  const dup = tr.path ? session.findPath(tr.path) : undefined;
  if (dup) {
    // the same file here already: the two become one, unless either has unsaved edits
    if (tabDirty(dup) || tr.editor?.dirty) {
      showNotice(t("msg.tabRefusedSameFile", { name: fileName(tr.path!) }), { kind: "info" });
      reply(false, "same-file-dirty");
      return;
    }
    reply(true);
    await activateTab(dup);
    void getCurrentWindow().setFocus().catch(() => {});
    return;
  }
  const index = await strip.dropIndex(o.x);
  const tab = tabFromTransfer(tr);
  session.insert(tab, session.live()[index] ?? null);
  strip.render(tab);
  reportTabs();
  reply(true);
  await activateTab(tab);
  void getCurrentWindow().setFocus().catch(() => {});
}

// this window, carried by its only tab, was let go over another window's strip
async function offerWindowTab(target: string, x: number, y: number): Promise<void> {
  if (!session.hasActive()) return;
  const tab = session.active();
  // a start page has nothing to bring: it stays a window of its own
  if (session.live().length !== 1 || tab.src.kind === "start" || closingWindow) return;
  const token = newToken();
  pendingMoves.set(token, tab);
  await ipc.sendTabOffer(target, { token, from: winLabel, transfer: transferOf(tab), x, y }).catch(() => {
    pendingMoves.delete(token);
  });
}

function onTabAccepted(a: TabAccepted): void {
  const tab = pendingMoves.get(a.token);
  if (!tab) return;
  pendingMoves.delete(a.token);
  if (!a.ok) {
    tab.leaving = false;
    strip.render();
    // a window carried onto another one is kept out of sight meanwhile: back at once
    void ipc.showWindow().catch(() => {});
    return;
  }
  // its only tab went over: the window goes, with nothing of it left to ask about
  const rest = session.live().filter((x) => x !== tab);
  if (rest.length === 0) {
    closingWindow = true;
    void getCurrentWindow().destroy().catch(() => {});
    return;
  }
  void releaseTab(tab);
}

const stripHost: strip.StripHost = {
  activate: (tab) => void activateTab(tab),
  close: (tab, opts) => void closeTab(tab, opts),
  closeOthers,
  closeRight,
  newTab: newStartTab,
  reopen: reopenTab,
  canReopen: () => session.closed.length > 0,
  moveToNewWindow: (tab) => void tearOff(tab, null, false),
  reveal: (path) =>
    void revealItemInDir(path).catch((err) => showNotice(t("msg.revealFailed", { err: String(err) }), { kind: "error" })),
  copyPath: (path) => void navigator.clipboard.writeText(path).catch(() => {}),
  saveAs: (tab) => void (async () => (await activateTab(tab)) && (await saveAsFront()))(),
  reordered: reportTabs,
  tearOff: (tab, at) => void tearOff(tab, at, true),
  dragWindow: (tab) =>
    void ipc
      .beginWindowDrag(session.filePath(tab), tabName(tab))
      // without the native watch the window still moves, as by its title bar
      .catch(() => getCurrentWindow().startDragging().catch(() => {})),
  busy: () => pdfInProgress || tabHolds > 0,
};

/* ---- files opened from outside, and the first tab ---- */

// a launch routed to this window: a new tab at the end, or the tab that shows it
function routeOpen(l: ipc.Launch): void {
  if (!l.path) return;
  const opts: OpenOptions = { line: l.line ?? undefined, anchor: l.anchor ?? undefined };
  const open = session.findPath(l.path);
  if (open) {
    void activateTab(open).then((front) => front && jumpIn(opts));
    return;
  }
  openInTab(l.path, { ...opts, atEnd: true });
}

// requests that arrive before the first tab is there wait for it
let bootQueue: ipc.Launch[] | null = [];

// A tab arriving with what it carries (from another window, across a language
// reload): its file, its pasted text with the text it holds now, or a start page
function tabFromTransfer(tr: TabTransfer): session.Tab {
  const p = tr.pasted;
  if (p && typeof p.id === "string" && typeof p.original === "string" && typeof p.content === "string") {
    const paste: Pasted = {
      id: p.id,
      original: p.original,
      title: typeof p.title === "string" ? p.title : pastedTitle(p.content),
      home: typeof p.home === "string" ? p.home : null,
    };
    const tab = session.make({ kind: "pasted", paste });
    tab.doc = pastedDoc(paste, p.content);
    tab.transfer = tr;
    // its dot, while it waits behind
    tab.dirty = tabDirty(tab);
    return tab;
  }
  const tab = session.make(fileOrStart(tr.path ?? null));
  tab.transfer = tr;
  tab.dirty = tabDirty(tab);
  return tab;
}

function firstTab(l: ipc.Launch | null): session.Tab {
  if (l?.transfer) {
    const tab = tabFromTransfer(l.transfer);
    session.insert(tab);
    // the window it comes from lets it go
    if (l.from && l.token) void ipc.sendTabAccepted(l.from, { token: l.token, ok: true }).catch(() => {});
    return tab;
  }
  const path = l?.path ?? null;
  const tab = session.make(fileOrStart(path), path ? { line: l?.line ?? undefined, anchor: l?.anchor ?? undefined } : null);
  session.insert(tab);
  return tab;
}

// The tabs carried across the reload of a language change, unsaved edits and all.
const CARRY_KEY = "reopen-tabs";

function carryTabs(): boolean {
  try {
    const list = session.live();
    sessionStorage.setItem(CARRY_KEY, JSON.stringify({ tabs: list.map(transferOf), active: list.indexOf(latestFront()) }));
    return true;
  } catch {
    return false;
  }
}

function takeCarriedTabs(): session.Tab | null {
  let carried: { tabs?: TabTransfer[]; active?: number } | null = null;
  try {
    carried = JSON.parse(sessionStorage.getItem(CARRY_KEY) ?? "null");
  } catch {
    /* nothing usable */
  }
  sessionStorage.removeItem(CARRY_KEY);
  if (!carried || !Array.isArray(carried.tabs) || carried.tabs.length === 0) return null;
  for (const tr of carried.tabs) {
    const tab = tabFromTransfer(tr);
    // a start page brings nothing back
    if (tab.src.kind === "start") tab.transfer = null;
    session.insert(tab);
  }
  return session.tabs[carried.active ?? 0] ?? session.tabs[0];
}

/** window.__leggimi: what the test kit drives. */
function installTestHooks(): void {
  const hooks: TestHooks = {
    label: winLabel,
    tabs: (): TabInfo[] =>
      session.live().map((x) => {
        const front = x === session.active();
        return {
          id: x.id,
          path: session.filePath(x),
          kind: x.src.kind,
          title: tabName(x),
          active: front,
          dirty: tabDirty(x),
          editing: front ? editing : (x.view?.editing ?? false),
          loaded: front ? currentDoc !== null : x.doc !== null,
        };
      }),
    activate: async (i) => {
      const x = session.live()[i];
      if (x) await activateTab(x);
    },
    close: async (i) => {
      const x = session.live()[i];
      return x ? closeTab(x) : "kept";
    },
    newTab: () => newStartTab("end"),
    openInTab: async (path, o = {}) => {
      openInTab(path, { background: o.background, line: o.line, anchor: o.anchor });
      await tabQueue;
    },
    move: (from, to) => {
      const x = session.live()[from];
      if (!x) return;
      session.move(x, to);
      strip.render();
      reportTabs();
    },
    transfer: (i) => transferOf(session.live()[i]),
    tearOff: async (i) => {
      const x = session.live()[i];
      if (x) await tearOff(x, null, false);
    },
  };
  (window as unknown as { __leggimi: TestHooks }).__leggimi = hooks;
}

// rows of the home and of the folder search: the middle button opens too
function onMiddleClick(el: HTMLElement, fn: (e: MouseEvent) => void): void {
  el.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault(); // no autoscroll
  });
  el.addEventListener("auxclick", (e) => {
    if (e.button === 1) fn(e);
  });
}

/* ---- right-click menus: the document and the files ---- */

// 24-px stroke icons, drawn at 16 px like the toolbar's
const MENU_ICON = {
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  forward: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  text: '<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>',
  find: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  folderFind:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="12" cy="13.5" r="2.5"/><line x1="16" y1="17.5" x2="14" y2="15.5"/>',
  open: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  web: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  window:
    '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="12" y1="11" x2="12" y2="18"/><line x1="8.5" y1="14.5" x2="15.5" y2="14.5"/>',
  tab: '<rect x="2" y="6" width="20" height="15" rx="2"/><path d="M2 10h20"/><path d="M7 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  zoom: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  table:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  clipboard:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  print:
    '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="11"/><polyline points="9 15 12 18 15 15"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};

function closeMenus(): void {
  hideShareMenu();
  hideReadingMenu();
  contextMenu.close();
}

function openFileMenu(path: string, x: number, y: number, opts: { isDir?: boolean; keyboard?: boolean } = {}): void {
  closeMenus();
  contextMenu.openAt(
    [
      !opts.isDir && {
        label: t("file.openNewTab"),
        icon: MENU_ICON.tab,
        kbd: t("file.ctrlClick"),
        run: () => openInTab(path, { background: true }),
      },
      !opts.isDir && {
        label: t("file.openNewWindow"),
        icon: MENU_ICON.window,
        kbd: t("file.shiftClick"),
        run: () => openInNewWindow(path),
      },
      "sep",
      {
        label: t("file.reveal"),
        icon: MENU_ICON.folder,
        run: () =>
          void revealItemInDir(path).catch((err) =>
            showNotice(t("msg.revealFailed", { err: String(err) }), { kind: "error" }),
          ),
      },
      {
        label: t("file.copyPath"),
        icon: MENU_ICON.copy,
        run: () => void navigator.clipboard.writeText(path).catch(() => {}),
      },
      {
        label: t("file.copyLink"),
        hint: t("file.copyLinkHint"),
        icon: MENU_ICON.link,
        run: () => {
          // relative to the document's folder; pasted text has none, the path stays whole
          const rel = currentDoc && currentDoc.dir !== null ? relativePath(currentDoc.dir, path) : path;
          const name = fileName(path).replace(MD_EXT_RE, "");
          navigator.clipboard.writeText(`[${name}](${encodeURI(rel)})`).catch(() => {});
        },
      },
    ],
    x,
    y,
    { keyboard: opts.keyboard },
  );
}

// where WebView2's own menu stays, for the spelling suggestions and
// cut/copy/paste: text fields and the editor's text, not checkboxes or buttons
const TEXT_INPUTS = new Set(["text", "search", "url", "email", "tel", "password", "number"]);
const isTextEditable = (el: Element | null): boolean =>
  !!el &&
  ((el instanceof HTMLInputElement && TEXT_INPUTS.has(el.type)) ||
    el instanceof HTMLTextAreaElement ||
    (el as HTMLElement).isContentEditable);

// The selection inside the article, for a search: its first line, trimmed
// and capped. null when there is none.
function selectionQuery(): string | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  if (!article.contains(sel.getRangeAt(0).commonAncestorContainer)) return null;
  const q = sel.toString().trim().split(/\r?\n/)[0].trim().slice(0, 100);
  return q || null;
}

// a selection of the article, copied like Ctrl+C: the Word-friendly HTML of
// the Share copy for that part, plus the plain text
async function copyRange(range: Range, plain: string): Promise<void> {
  if (!currentDoc) return;
  try {
    await copySelectionAsRichText(article, currentDoc.dir, range);
  } catch {
    await navigator.clipboard.writeText(plain).catch(() => {});
  }
}

// the heading of the section at viewport height y: the last one starting above it
function sectionHeadingAt(y: number): HTMLElement | null {
  let found: HTMLElement | null = null;
  for (const h of article.querySelectorAll<HTMLElement>("h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]")) {
    if (h.getBoundingClientRect().top > y + 2) break;
    found = h;
  }
  return found;
}

// 0-based source line of what is under the pointer: the innermost block that
// knows its line, else the last block starting above y
function sourceLineAt(target: Element, y: number): number | null {
  const el = target.closest<HTMLElement>("[data-source-line]");
  if (el && article.contains(el)) return Number(el.dataset.sourceLine);
  collectPreviewAnchors();
  let line: number | null = null;
  for (const a of previewAnchors) {
    if (a.el.getBoundingClientRect().top > y) break;
    line = a.line;
  }
  return line;
}

// `[Heading](file.md#id)`: the same link as "Copy as Markdown link", to the section
function sectionLink(h: HTMLElement): string {
  const text = (h.textContent ?? "").trim().replace(/([[\]\\])/g, "\\$1");
  // the anchor as written, which also works on GitHub and in other viewers;
  // pasted text has no file name to put before it
  const file = currentDoc?.path ? encodeURI(fileName(currentDoc.path)) : "";
  return `[${text}](${file}#${h.dataset.anchor ?? h.id})`;
}

const isLocalDocLink = (href: string): boolean => !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href);

/**
 * The right-click menu of the document: what is selected, then what is under
 * the pointer (a link, an image, code, a table), then the section and the
 * whole document. Outside the document, only a selection gets a menu (Copy).
 */
function buildDocMenu(target: HTMLElement, y: number): contextMenu.MenuSpec {
  const sel = window.getSelection();
  const range = sel && !sel.isCollapsed && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
  const selText = range ? (sel?.toString() ?? "") : "";
  const inDoc =
    currentDoc !== null && !article.hidden && (article.contains(target) || target === contentPane);
  if (!inDoc) {
    if (!range || !selText.trim() || editorPane.contains(range.commonAncestorContainer)) return [];
    return [
      {
        label: t("ctx.copy"),
        icon: MENU_ICON.copy,
        kbd: keyLabel("Ctrl+C"),
        run: () => void navigator.clipboard.writeText(selText).catch(() => {}),
      },
    ];
  }

  const selected = range !== null && selText.trim() !== "" && article.contains(range.commonAncestorContainer);
  const query = selected ? selectionQuery() : null;
  const link = target.closest("a, area");
  const href = link && article.contains(link) ? linkHref(link) : "";
  const zoomable = target.closest<HTMLElement>("[data-zoomable]");
  const code = target.closest<HTMLElement>(".code-block");
  const table = target.closest<HTMLElement>(".table-block");
  const heading = sectionHeadingAt(y);
  const line = sourceLineAt(target, y);

  return [
    // first, as in a browser; a selection's menu is about the selection
    !selected &&
      navHistory.canBack() && { label: t("ctx.back"), icon: MENU_ICON.back, kbd: "Alt+←", run: () => void goBack() },
    !selected &&
      navHistory.canForward() && {
        label: t("ctx.forward"),
        icon: MENU_ICON.forward,
        kbd: "Alt+→",
        run: () => void goForward(),
      },
    "sep",
    selected && {
      label: t("ctx.copy"),
      icon: MENU_ICON.copy,
      kbd: keyLabel("Ctrl+C"),
      run: () => void copyRange(range!, selText),
    },
    selected && {
      label: t("ctx.copyPlain"),
      icon: MENU_ICON.text,
      run: () => void navigator.clipboard.writeText(selText).catch(() => {}),
    },
    query !== null &&
      !editing && {
        label: t("ctx.findInDoc"),
        icon: MENU_ICON.find,
        kbd: keyLabel("Ctrl+F"),
        run: () => search.openWith(query),
      },
    query !== null && {
      label: t("ctx.findInFolder"),
      icon: MENU_ICON.folderFind,
      kbd: keyLabel("Ctrl+Shift+F"),
      run: () => openFolderSearch(query),
    },
    "sep",
    href !== "" && {
      label: t("ctx.openLink"),
      icon: isLocalDocLink(href) ? MENU_ICON.open : MENU_ICON.web,
      run: () => followLink(href, "here", link),
    },
    href !== "" &&
      isLocalDocLink(href) && {
        label: t("ctx.openNewTab"),
        icon: MENU_ICON.tab,
        kbd: t("file.ctrlClick"),
        run: () => followLink(href, "tab", link),
      },
    href !== "" &&
      isLocalDocLink(href) && {
        label: t("ctx.openNewWindow"),
        icon: MENU_ICON.window,
        kbd: t("file.shiftClick"),
        run: () => followLink(href, "window", link),
      },
    href !== "" && {
      label: t("ctx.copyLinkAddress"),
      icon: MENU_ICON.link,
      run: () => void navigator.clipboard.writeText(href).catch(() => {}),
    },
    zoomable && {
      label: t("ctx.zoom"),
      icon: MENU_ICON.zoom,
      run: () => void lightbox.openFor(zoomable),
    },
    code && {
      label: t("ctx.copyCode"),
      icon: MENU_ICON.code,
      run: () => code.querySelector<HTMLButtonElement>(".code-copy")?.click(),
    },
    // a table opens in the full-window preview too (wide ones read better
    // there); an image inside it already offers its own preview
    !zoomable &&
      table && {
        label: t("ctx.zoom"),
        icon: MENU_ICON.zoom,
        run: () => void lightbox.openFor(table),
      },
    table && {
      label: t("render.copyTable"),
      icon: MENU_ICON.table,
      // its own button, not the one of a table nested in a cell
      run: () => table.querySelector<HTMLButtonElement>(":scope > .table-actions > .table-copy")?.click(),
    },
    "sep",
    heading && {
      label: t("ctx.copySectionLink"),
      hint: (heading.textContent ?? "").trim(),
      icon: MENU_ICON.hash,
      run: () => void navigator.clipboard.writeText(sectionLink(heading)).catch(() => {}),
    },
    line !== null && {
      label: t("ctx.editHere"),
      icon: MENU_ICON.edit,
      kbd: editing ? undefined : keyLabel("Ctrl+E"),
      run: () => void editAt(line),
    },
    "sep",
    !selected && {
      label: t("ctx.copyDoc"),
      icon: MENU_ICON.clipboard,
      kbd: keyLabel("Ctrl+Shift+C"),
      run: () => void copyDocAsRichText(),
    },
    { label: t("share.print"), icon: MENU_ICON.print, kbd: keyLabel("Ctrl+P"), run: () => void printDoc() },
    { label: t("share.pdf"), icon: MENU_ICON.pdf, run: () => void exportDocAsPdf() },
  ];
}

// Shift+F10 and the menu key raise contextmenu too, with no pointer; a
// PointerEvent says so with an empty pointerType
const fromKeyboard = (e: MouseEvent): boolean => {
  const type = (e as Partial<PointerEvent>).pointerType;
  return type !== undefined ? type === "" : e.button !== 2;
};

// where a menu for `el` opens: at the pointer, or under `el` from the keyboard
function menuPoint(e: MouseEvent, el: HTMLElement): { x: number; y: number } {
  if (!fromKeyboard(e)) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  return { x: r.left + 12, y: r.bottom + 2 };
}

// Shift+F10 or the menu key in the document: the menu opens at the
// selection, or at the top of the document
function keyboardMenuPoint(): { x: number; y: number } {
  const p = contentPane.getBoundingClientRect();
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    // a selection scrolled out of sight does not anchor it
    if ((r.width || r.height) && r.bottom > p.top && r.top < p.bottom) return { x: r.left, y: r.bottom + 4 };
  }
  return { x: p.left + 24, y: p.top + 24 };
}

/* ---- the folder search box ---- */

// Ctrl+Shift+F: the file pane comes back and its search box takes the keys,
// with `query` searched right away when given
function openFolderSearch(query?: string | null): void {
  // shown for good, or over the text when the window is too narrow for it
  panes.show("tree");
  if (query) {
    treeSearch.value = query;
    void runFolderSearch();
  }
  treeSearch.focus();
  treeSearch.select();
}

/* ---- links in the document ---- */

// in-article links: hash → in-page scroll, web → default browser, local →
// open in the viewer (or, on request, in a tab or a window of its own). Local links resolve
// like a wiki: `doc`, `doc.md`, `folder/` (its index.md or README.md), with
// an optional `#heading`.
function followLink(href: string, where: Where = "here", link?: Element | null): void {
  const hashAt = href.indexOf("#");
  const target = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const anchor = hashAt >= 0 ? decodeSafe(href.slice(hashAt + 1)) : undefined;
  // [[Note]] as note-taking apps write it (renderer.ts): looked up by name when it is
  // not next to the document
  const wiki = link instanceof HTMLElement && link.dataset.wikilink !== undefined;
  if (!target) {
    if (anchor) jumpToAnchor(anchor);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    // web pages to the browser, mail and phone links to their apps
    if (/^(https?|mailto|tel):/i.test(href)) openUrl(href).catch(() => {});
  } else if (currentDoc && currentDoc.dir !== null) {
    void openLocalLink(currentDoc.dir, decodeSafe(target), anchor, where, wiki);
  } else if (currentDoc) {
    // pasted text is in no folder: a relative link leads nowhere until it is saved
    showNotice(t("msg.pastedLink"), { kind: "info", action: { label: t("tab.saveAs"), fn: () => void saveAsFront() } });
  }
}

// A [[Note]] that is not next to its document, by name, as note-taking apps find it:
// first among the files the pane lists (its folder, as the palette offers them), the
// shallowest; then below the document's folder (find_in_folder). Only the name counts
// when the link names no folder. null: there is none.
async function findByName(dir: string, rel: string): Promise<string | null> {
  const parts = rel.split(/[\\/]/).filter(Boolean);
  const name = parts.pop() ?? "";
  if (!name || parts.includes("..")) return null;
  const tail = [...parts, name].join("\\").toLowerCase();
  const fits = (path: string): boolean => {
    const p = path.toLowerCase();
    return p === tail || p.endsWith("\\" + tail);
  };
  const found: string[] = [];
  if (treeJson) {
    const walk = (n: ipc.TreeNode): void => {
      if (!n.isDir && fits(n.path)) found.push(n.path);
      n.children.forEach(walk);
    };
    try {
      walk(JSON.parse(treeJson) as ipc.TreeNode);
    } catch {
      /* no listing to look in */
    }
  }
  const depth = (p: string): number => p.split("\\").length;
  found.sort((a, b) => depth(a) - depth(b) || a.length - b.length);
  if (found[0]) return found[0];
  return ipc.findInFolder(dir, [...parts, name].join("\\")).catch(() => null);
}

// What a link may hand to its default app; keep in sync with OPEN_EXTERNALLY
// in src-tauri/src/commands.rs (which is the one that decides)
const OPEN_EXTERNALLY =
  /\.(pdf|txt|csv|tsv|json|xml|ya?ml|log|rtf|docx?|xlsx?|pptx?|od[tsp]|vsdx|drawio|msg|eml|png|jpe?g|gif|webp|svg|bmp|avif|tiff?|mp3|wav|m4a|mp4|mov|webm|zip|7z|html?)$/i;

// A local link: a Markdown document opens in the viewer (or a new window), an
// image in the preview, a folder in the file pane. Any other file is never
// read as text: a notice offers it to its default app, or shows it in File
// Explorer when it is not a document (a program, a script).
async function openLocalLink(dir: string, rel: string, anchor: string | undefined, where: Where, wiki = false): Promise<void> {
  // a file on another computer: looking it up would have Windows call that computer (reach.ts)
  if (!reachable(dir, rel)) {
    showNotice(t("msg.otherComputer", { name: rel }), { kind: "info" });
    return;
  }
  const tab = session.active();
  let p = await ipc.resolveDoc(dir, rel).catch(() => null);
  if (!p && wiki) p = await findByName(dir, rel);
  // another tab came forward meanwhile: the link was about the one that left
  if (where === "here" && session.active() !== tab) return;
  if (p && isMarkdownPath(p)) {
    if (where !== "here") openAt(p, where, { anchor });
    // a link to the document on screen moves within it: reading the file
    // again would put the disk's text over the live preview while editing
    else if (isDocAt(currentDoc, p) && !article.hidden && !errorShown) {
      if (anchor) jumpToAnchor(anchor);
    } else void navigate(p, { anchor });
    return;
  }
  if (p && isImagePath(p)) {
    const img = new Image();
    img.alt = fileName(p);
    img.src = convertFileSrc(p);
    if (await img.decode().then(() => true, () => false)) {
      void lightbox.openFor(img);
      return;
    }
  }
  if (p) {
    const open = OPEN_EXTERNALLY.test(p);
    showNotice(t("msg.notMarkdown", { name: fileName(p) }), {
      kind: "info",
      action: open
        ? { label: t("msg.openFile"), fn: () => void ipc.openExternally(p).catch((err) => showNotice(String(err), { kind: "error" })) }
        : { label: t("msg.showInFolder"), fn: () => void revealItemInDir(p).catch(() => {}) },
    });
    return;
  }
  // no file by that name: a folder with Markdown files roots the file pane
  const folder = await ipc.resolvePath(dir, rel).catch(() => null);
  if (folder && (await ipc.listTree(folder).then(() => true, () => false))) {
    browseRoot = folder;
    void refreshTree();
    panes.show("tree");
    return;
  }
  showNotice(t("msg.notFound", { name: rel }));
}

const XLINK = "http://www.w3.org/1999/xlink";
// the address of a link: an <a>, an image-map <area>, an SVG link (xlink:href)
const linkHref = (a: Element): string => a.getAttribute("href") ?? a.getAttributeNS(XLINK, "href") ?? "";

/* ---- F5: the file again, not the app ---- */

// WebView2's reload would restart the app and close the document. F5 and
// Ctrl+R read the file from disk instead, keeping the place; never over
// unsaved edits.
function reloadCurrentDoc(): void {
  // pasted text has no file to read again
  if (!currentDoc || currentDoc.path === null) return;
  if (editing) {
    if (!editorMod?.isDirty()) void reloadFromDisk();
  } else {
    void openFile(currentDoc.path, { preserveScroll: true });
  }
}

// A letter shortcut by the letter it types, so Ctrl+W stays the W on AZERTY
// or Dvorak (where that key types Z or a comma); by the key's position only
// when it types no plain character at all (Greek, Cyrillic), never matching
// otherwise.
const keyIs = (e: KeyboardEvent, letter: string): boolean =>
  e.key.toLowerCase() === letter || (!/^[\x20-\x7e]$/.test(e.key) && e.code === `Key${letter.toUpperCase()}`);

const isReloadKey = (e: KeyboardEvent): boolean =>
  e.key === "F5" || e.key === "BrowserRefresh" || (e.ctrlKey && !e.altKey && keyIs(e, "r"));

// Ctrl+W, Ctrl+F4: the tab (asking about unsaved edits)
const isCloseKey = (e: KeyboardEvent): boolean =>
  e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && !composing(e) && (e.key === "F4" || keyIs(e, "w"));

// Ctrl+Shift+W: the window, as its X button does; the last one ends the app
const isCloseWindowKey = (e: KeyboardEvent): boolean =>
  e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && !composing(e) && keyIs(e, "w");

// an IME composing (Chinese, Japanese): its keys are the IME's, not commands
const composing = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;

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
// on the pane outside the text column, so selecting text stays untouched. A
// middle click that does not drag, on a link, opens it in a new tab.
function wireDragScroll(): void {
  let drag: { id: number; buttons: number; y: number; top: number; moved: boolean; link: Element | null } | null = null;
  let middleLink: Element | null = null;
  contentPane.addEventListener("pointerdown", (e) => {
    const margin = e.button === 0 && e.target === contentPane;
    if (!(e.button === 1 || margin) || lightbox.isOpen()) return;
    if (e.button === 1) e.preventDefault(); // no autoscroll icon
    // the target now: once a drag captures the pointer, the pane is the target
    const link = e.button === 1 ? (e.target as HTMLElement).closest("#article a, #article area") : null;
    // the button's bit in PointerEvent.buttons: 1 left, 4 middle
    drag = { id: e.pointerId, buttons: e.button === 1 ? 4 : 1, y: e.clientY, top: contentPane.scrollTop, moved: false, link };
  });
  contentPane.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    // released where the pane could not hear it (before the drag captured the
    // pointer): the drag is over, or hovering would go on scrolling
    if (!(e.buttons & drag.buttons)) {
      end(e);
      return;
    }
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 3) return;
    if (!drag.moved) {
      drag.moved = true;
      contentPane.classList.add("dragging");
      // Captured only once it is a drag: a click that stays put keeps its
      // target, so the middle button still opens a recent file of the home
      // (its auxclick would otherwise go to the pane).
      try {
        contentPane.setPointerCapture(e.pointerId);
      } catch {
        /* synthetic pointer: capture is a nicety */
      }
    }
    contentPane.scrollTop = drag.top - dy;
  });
  function end(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return;
    contentPane.classList.remove("dragging");
    middleLink = e.type === "pointerup" && !drag.moved ? drag.link : null;
    drag = null;
  }
  // on the window: a button can come up outside the pane before any capture
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  // Chromium's middle-click autoscroll would fight the drag
  contentPane.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    e.preventDefault();
    const link = middleLink;
    const href = link ? linkHref(link) : "";
    middleLink = null;
    if (href) followLink(href, "tab", link);
  });
}

/* ---- file browser ---- */

let treeGen = 0;
// the listing on screen, to redraw only what changed
let treeJson = "";
let watchedRoot = "";

// Lists the pane's folder again (a file opened, a change on disk, the window
// back in front). The rows are rebuilt only when the listing differs, so an
// unrelated change costs no flicker and the focused row keeps the focus.
// Resolves to whether the listing changed.
function refreshTree(): Promise<boolean> {
  if (!browseRoot) return Promise.resolve(false);
  const root = browseRoot;
  const gen = ++treeGen;
  btnUp.disabled = isDriveRoot(root);
  // watched even with no Markdown file in it yet, so the first one shows up
  if (!samePath(root, watchedRoot)) {
    watchedRoot = root;
    ipc.watchTree(root).catch(() => {});
  }
  return ipc
    .listTree(root)
    .then((node) => {
      if (gen !== treeGen) return false; // a newer listing is on its way
      const json = JSON.stringify(node);
      if (json === treeJson) {
        if (currentDoc?.path) tree.setActive(treeRoot, currentDoc.path);
        return false;
      }
      treeJson = json;
      treeRootName.textContent = node.name;
      treeRootName.title = root;
      const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#tree-root [data-path]");
      tree.render(treeRoot, node, currentDoc?.path ?? "", (p, e) => {
        // a file picked in a pane shown over the text: the pane goes
        if (whereFrom(e) === "here") panes.closePeek();
        openFrom(p, e);
      });
      if (focused?.dataset.path) {
        const again = treeRoot.querySelector<HTMLElement>(`[data-path="${CSS.escape(focused.dataset.path)}"]`);
        // a folder's data-path sits on its wrapper, the button inside takes the focus
        (again?.matches(".tree-row") ? again : again?.querySelector<HTMLElement>(":scope > .tree-row"))?.focus({
          preventScroll: true,
        });
      }
      return true;
    })
    .catch(() => {
      if (gen !== treeGen) return false;
      const had = treeJson !== "";
      treeJson = "";
      treeRootName.textContent = "";
      treeRoot.replaceChildren();
      return had;
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
    // how many, for screen readers (WCAG 4.1.3); the list itself says it on screen
    sayCountSoon(search.countWords(hits.length));
  } catch {
    /* folder gone mid-search: keep whatever is on screen */
  }
}

// A search box's count, spoken once typing pauses (300 ms, as the palette does); "" says nothing.
let sayCountTimer = 0;
function sayCountSoon(text: string): void {
  clearTimeout(sayCountTimer);
  if (!text) return;
  sayCountTimer = window.setTimeout(() => notices.announce(text), 300);
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
      file.addEventListener("click", (e) => void openHit(hit.path, q, e));
      onMiddleClick(file, (e) => void openHit(hit.path, q, e));
      searchResults.append(file);
    }
    if (hit.line > 0) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "search-hit";
      row.title = t("pane.lineN", { n: hit.line });
      row.append(...highlightMatch(hit.preview, q));
      row.addEventListener("click", (e) => void openHit(hit.path, q, e, hit.line));
      onMiddleClick(row, (e) => void openHit(hit.path, q, e, hit.line));
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

// `line` (1-based): a new window opens the file there, since the query
// itself cannot travel with it; a new tab takes the query along
async function openHit(path: string, q: string, e: MouseEvent, line?: number): Promise<void> {
  const where = whereFrom(e);
  if (where === "window") {
    openInNewWindow(path, { line });
    return;
  }
  // pasted text in front is never replaced: the file comes in a tab of its own, the query with it
  if (where !== "here" || (session.hasActive() && session.active().src.kind === "pasted" && !session.findPath(path))) {
    if (where === "here") panes.closePeek();
    openInTab(path, { line, find: q, background: where === "tab" });
    return;
  }
  panes.closePeek();
  await navigate(path);
  // carry the query into the document so the match is highlighted in place
  if (isDocAt(currentDoc, path)) search.openWith(q);
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
    void refreshTree();
  }
}

/* ---- reading position, progress bar, reading time ---- */

// A remembered anchor is only honoured while its heading still exists: a
// rewritten document should open at the top, not at a stray offset. The same
// document read again (`same`: a reload, its tab coming back) whose heading was
// renamed meanwhile, as an agent marking a step done does, keeps the place by its
// distance from the top instead (report C-02: it jumped to the top).
function restoreRemembered(saved: ScrollAnchor | null, same = false): boolean {
  if (!saved) return false;
  if (!saved.id) {
    if (saved.offset <= 0) return false;
    restoreScrollAnchor(contentPane, article, saved);
    return true;
  }
  // positions saved before 1.15.1 name the heading by its old id
  if (saved.id && !findHeading(article, saved.id)) {
    if (!same || saved.top === undefined || saved.top <= 0) return false;
    contentPane.scrollTop = Math.min(saved.top, contentPane.scrollHeight - contentPane.clientHeight);
    return true;
  }
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
  // reading positions are kept by file
  if (editing || !currentDoc || currentDoc.path === null || article.hidden) return;
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
    setTabReading(0);
    return;
  }
  const text = article.textContent ?? "";
  const cjk = (text.match(CJK_RE) ?? []).length;
  const words = (text.replace(CJK_RE, " ").match(WORD_RE) ?? []).length;
  const minutes = Math.max(1, Math.ceil(words / WORDS_PER_MIN + cjk / CJK_PER_MIN));
  docMeta.textContent = t("msg.minRead", { n: minutes });
  docMeta.title = t("msg.words", { n: i18n.fmtNumber(words + cjk) });
  docMeta.hidden = false;
  setTabReading(minutes);
}

// The reading time goes to the tab in front (the toolbar no longer has it):
// after the tab's name (strip.ts) and on its card. 0: there is none, a start
// page or an error card.
function setTabReading(minutes: number): void {
  if (!session.hasActive()) return;
  const tab = session.active();
  tab.meta = minutes ? (docMeta.textContent ?? "") : "";
  if (tab.minutes === minutes) return;
  tab.minutes = minutes;
  strip.render();
}

/* ---- outline filter ---- */

const TOC_FILTER_MIN = 8;

// `keep`: a refresh of the same document keeps the query; a new one starts clean
function setupTocFilter(headings: number, keep: boolean): void {
  const show = headings >= TOC_FILTER_MIN;
  tocFilterWrap.hidden = !show;
  if (!show || !keep) tocFilter.value = "";
  toc.setFilter(tocFilter.value, t("pane.noMatches"));
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
  contentPane.scrollTo({ top: keyScrollTarget, behavior: repeat ? "instant" : motion.behavior() });
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
      contentPane.scrollTo({ top: contentPane.scrollHeight, behavior: motion.behavior() });
      return true;
    case "g": {
      const now = performance.now();
      if (now - lastG < 500) {
        lastG = 0;
        contentPane.scrollTo({ top: 0, behavior: motion.behavior() });
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
// settles once the Store build check is back (the card waits for it)
let storeReady: Promise<void> = Promise.resolve();

function scheduleRatePrompt(): void {
  clearTimeout(rateTimer);
  void storeReady.then(() => {
    if (!storeInstall || !rating.due()) return;
    clearTimeout(rateTimer);
    rateTimer = window.setTimeout(() => {
      // another window may have shown it meanwhile; only the window in front asks
      if (editing || !currentDoc || article.hidden || !rateToast.hidden || !rating.due() || !document.hasFocus()) return;
      rating.shown(); // claims the card: due() turns false in every window
      rateToast.hidden = false;
    }, 2000);
  });
}

function hideRateToast(): void {
  clearTimeout(rateTimer);
  rateToast.hidden = true;
}

// Rate: the Store's own rating dialog over this window (it falls back to the
// Store's review page by itself when the dialog cannot be shown)
function rateOnStore(): void {
  rating.done();
  hideRateToast();
  ipc.requestStoreRating().catch(() => ipc.openStoreReview().catch(() => {}));
}

// the help on demand: its page (in the UI language) loads the first time
async function openHelp(): Promise<void> {
  await i18n.loadHelp($("#help-text"));
  // a preview opened meanwhile keeps the screen: the help must not stack on it
  if (!helpDialog.open && !lightbox.isOpen()) helpDialog.showModal();
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
    row.addEventListener("click", (e) => openFrom(r.path, e));
    onMiddleClick(row, (e) => openFrom(r.path, e));
    recentList.append(row);
  }
}

function showError(message: string): void {
  errorShown = true;
  emptyState.hidden = true;
  article.hidden = false;
  article.replaceChildren();
  const card = document.createElement("div");
  card.className = "error-card";
  card.textContent = message;
  article.append(card);
  // an error card is not a read: its tab says no reading time
  docMeta.hidden = true;
  setTabReading(0);
  sectionLine.refresh();
}

function showEmpty(): void {
  errorShown = false;
  article.hidden = true;
  emptyState.hidden = false;
  docMeta.hidden = true;
  setTabReading(0);
  readProgress.hidden = true;
  renderRecents().catch(() => {});
}

// The files picked, a tab each: the first in front (a start page in front
// becomes it), the others behind it, in their order
async function chooseFile(): Promise<void> {
  const picked = await openDialog({
    multiple: true,
    filters: [{ name: t("filter.markdown"), extensions: MD_EXTENSIONS }],
  }).catch(() => null);
  const paths = Array.isArray(picked) ? picked : typeof picked === "string" ? [picked] : [];
  if (paths.length === 0) return;
  openInTab(paths[0]);
  for (const p of paths.slice(1)) openInTab(p, { background: true });
}

// Ctrl+F: while editing, find always means the editor's panel (case, word,
// regexp, replace), wherever the focus is: never a second find bar; while
// reading, the find bar, with the selection to look for
function findInDocument(): void {
  const query = selectionQuery();
  if (editing && editorMod) editorMod.openFind(false);
  else if (query) search.openWith(query);
  else search.open();
}

// a document on screen: a file or pasted text, not the start page or an error card
const docOnScreen = (): boolean => currentDoc !== null && !article.hidden && !errorShown;

// something modal holds the window: the preview, the help, the keys, the palette
const modalOpen = (): boolean => lightbox.isOpen() || helpDialog.open || keysDialog.open || paletteOpen();

/* ---- the command palette (palette.ts, loaded the first time it opens) ---- */

let paletteMod: typeof import("./palette") | null = null;
let paletteLoad: Promise<typeof import("./palette") | null> | null = null;

const paletteOpen = (): boolean => paletteMod?.isOpen() ?? false;

function closePalette(): void {
  if (paletteOpen()) paletteMod?.close();
}

// Ctrl+K, Ctrl+Shift+P: never AltGr (Ctrl+Alt), nor while an IME composes
const isPaletteKey = (e: KeyboardEvent): boolean =>
  e.ctrlKey && !e.altKey && !e.metaKey && !composing(e) && (e.shiftKey ? keyIs(e, "p") : keyIs(e, "k"));

async function openPalette(): Promise<void> {
  closeMenus();
  panes.closePeek();
  strip.cancelDrag();
  const mod = await loadPalette();
  // something modal came while it loaded the first time
  if (mod && !modalOpen()) mod.open();
}

function loadPalette(): Promise<typeof import("./palette") | null> {
  paletteLoad ??= Promise.all([import("./palette"), import("./appCommands")]).then(
    ([pal, cmds]) => {
      pal.init(paletteHost(pal.folderDetail, cmds.buildCommands));
      paletteMod = pal;
      return pal;
    },
    (err) => {
      // tried again at the next Ctrl+K
      paletteLoad = null;
      showNotice(String(err), { kind: "error" });
      return null;
    },
  );
  return paletteLoad;
}

// What the palette lists: the commands, the document's headings, the other
// tabs, the files of the pane's folder and the recent ones
function paletteHost(
  folderDetail: (path: string, root: string | null) => string,
  buildCommands: (h: AppCommandHost) => PaletteCommand[],
): PaletteHost {
  const detail = (path: string): string => folderDetail(path, browseRoot);
  return {
    commands: () => buildCommands(appCommandHost),
    headings: paletteHeadings,
    tabs: (): PaletteTab[] => {
      const front = session.hasActive() ? session.active() : null;
      return session
        .live()
        .filter((x) => x !== front)
        .sort((a, b) => b.shownAt - a.shownAt)
        .map((x) => ({
          key: String(x.id),
          title: tabName(x),
          detail: x.src.kind === "file" ? detail(x.src.path) : t(x.src.kind === "pasted" ? "tab.pasted" : "tab.startPage"),
          kind: x.src.kind,
          activate: () => void activateTab(x),
        }));
    },
    files: () => paletteFiles(detail),
    openFile: (path, where) => openAt(path, where),
    jumpTo: (el) => void toc.jumpTo(el),
    // the palette's "Find «q»": the editor's panel while editing, else the find bar
    findInDoc: (q) => {
      if (editing && editorMod) editorMod.openFind(false, q);
      else search.openWith(q);
    },
    searchFolder: (q) => openFolderSearch(q),
    hasFolder: () => browseRoot !== null,
    hasDocument: docOnScreen,
  };
}

// The outline's headings, each with the sections it is in ("Install › Windows")
function paletteHeadings(): PaletteHeading[] {
  if (!docOnScreen()) return [];
  const heads = toc.headings();
  const levels = heads.map((h) => Number(h.tagName.slice(1)));
  const texts = heads.map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim());
  const tree = outline(levels);
  const now = toc.activeIndex();
  return heads.map((el, i) => ({
    el,
    text: texts[i],
    level: levels[i],
    path: pathOf(tree, i)
      .filter((k) => k !== i)
      .map((k) => texts[k])
      .join(" › "),
    current: i === now,
  }));
}

// The recent files still there, then the pane's folder as it lists it (up to
// 2000 files), without those open in a tab here
async function paletteFiles(detail: (path: string) => string): Promise<PaletteFile[]> {
  const open = new Set(
    session
      .live()
      .map(session.filePath)
      .filter((p): p is string => p !== null)
      .map((p) => p.toLowerCase()),
  );
  const out: PaletteFile[] = [];
  const add = (path: string, openedAt?: number): void => {
    if (!open.has(path.toLowerCase())) out.push({ path, name: fileName(path), detail: detail(path), openedAt });
  };
  const recent = recents.list();
  if (recent.length > 0) {
    const all = recent.map((r) => r.path);
    const alive = new Set((await ipc.existingPaths(all).catch(() => all)).map((p) => p.toLowerCase()));
    for (const r of recent) if (alive.has(r.path.toLowerCase())) add(r.path, r.openedAt);
  }
  let left = 2000;
  const walk = (node: ipc.TreeNode): void => {
    for (const c of node.children) {
      if (left <= 0) return;
      if (c.isDir) walk(c);
      else {
        left--;
        add(c.path);
      }
    }
  };
  if (treeJson) {
    try {
      walk(JSON.parse(treeJson) as ipc.TreeNode);
    } catch {
      /* no listing to offer */
    }
  }
  return out;
}

// the Aa popover, opened by its own button (so it keeps its place in the Tab order), its first choice focused
function openReadingSettings(): void {
  if (!readingMenuOpen()) btnReading.click();
  readingMenu.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
}

// What the commands need of the window: its state as the palette opens, and the actions
const appCommandHost: AppCommandHost = {
  hasDocument: docOnScreen,
  isFile: () => docOnScreen() && currentDoc?.path != null,
  isPasted: () => currentDoc?.path === null,
  isEditing: () => editing,
  isDirty: () => frontChanged(),
  hasOutline: () => toc.headings().length > 0 && !app.classList.contains("no-headings"),
  hasFolder: () => browseRoot !== null,
  canGoUp: () => browseRoot !== null && !isDriveRoot(browseRoot),
  tabCount: () => session.live().length,
  canReopenTab: () => session.closed.length > 0,
  canGoBack: () => navHistory.canBack(),
  canGoForward: () => navHistory.canForward(),
  isPinned: () => pinnedOnTop,
  pasteAsDocument: () => void pasteFromClipboard(),
  chooseFile: () => void chooseFile(),
  toggleEditMode: () => void toggleEditMode(),
  saveFile: () => void saveFile(),
  reloadCurrentDoc: () => reloadCurrentDoc(),
  copyPath: () => {
    const p = currentDoc?.path;
    if (p) void navigator.clipboard.writeText(p).catch(() => {});
  },
  revealInExplorer: () => {
    const p = currentDoc?.path;
    if (p) void revealItemInDir(p).catch((err) => showNotice(t("msg.revealFailed", { err: String(err) }), { kind: "error" }));
  },
  newTab: () => newStartTab("end"),
  reopenTab: () => reopenTab(),
  closeTab: () => closeTabByKey(),
  stepTab: (dir) => stepTab(dir),
  moveTabToNewWindow: () => {
    if (session.hasActive()) void tearOff(latestFront(), null, false);
  },
  newWindow: () => openInNewWindow(null),
  closeWindow: () => void getCurrentWindow().close().catch(() => {}),
  findInDocument: () => findInDocument(),
  searchFolder: () => openFolderSearch(selectionQuery()),
  goUp: () => void goUp(),
  goBack: () => void goBack(),
  goForward: () => void goForward(),
  togglePane: (pane) => panes.toggle(pane, { focus: true }),
  toggleShareMenu: () => toggleShareMenu(),
  copyDocAsRichText: () => void copyDocAsRichText(),
  printDoc: () => void printDoc(),
  exportDocAsPdf: () => void exportDocAsPdf(),
  exportDocAsHtml: () => void exportDocAsHtml(),
  exportDocAsDocx: () => void exportDocAsDocx(),
  togglePin: () => togglePin(),
  bumpReaderSize: (dir) => bumpReaderSize(dir),
  resetReaderSize: () => withReadingAnchor(() => prefs.set({ size: prefs.DEFAULTS.size })),
  openReadingSettings: () => openReadingSettings(),
  toggleKeysDialog: () => toggleKeysDialog(),
  openHelp: () => void openHelp(),
  editorCommands: () => (editing && editorMod ? editorMod.COMMANDS : []),
  runEditorCommand: (id) => editorMod?.runCommand(id),
};

function wireUi(): void {
  notices.init({
    bar: noticeBar,
    icon: $("#notice-icon"),
    msg: $("#notice-msg"),
    action: $<HTMLButtonElement>("#notice-action"),
    close: $<HTMLButtonElement>("#notice-close"),
    status: $("#sr-status"),
    alert: $("#sr-alert"),
  });
  // a notice and the find bar open together: under it where they cannot stand side by side
  bars.init(contentPane, $("#find-bar"), noticeBar);
  // the panes keep the shown/hidden choice themselves, and fold away (or open
  // over the text) when the window is too narrow for them
  panes.init({
    app,
    shell,
    panes: { tree: treePane, toc: tocPane },
    handles: { tree: $("#tree-resizer"), toc: $("#toc-resizer") },
    buttons: { tree: $("#btn-tree"), toc: $("#btn-toc") },
  });
  lightbox.init({
    article,
    pane: contentPane,
    hint: zoomHint,
    dialog: zoomDialog,
    bars: [$("#find-bar"), noticeBar, $("#section-line")],
  });
  wide.init({ article, pane: contentPane });
  tableScroll.init(article);
  // the path of the section being read, at the top of the text while the outline is out of sight
  sectionLine.init({
    app,
    pane: contentPane,
    article,
    line: $("#section-line"),
    readable: () => !editing && currentDoc !== null && !article.hidden && !errorShown,
    headCover: (y) => tableScroll.headCover(contentPane, article, y),
  });

  // from the keyboard (no pointer: detail 0) the keys go into a pane that opens over the text
  $("#btn-tree").addEventListener("click", (e) => panes.toggle("tree", { focus: e.detail === 0 }));
  $("#btn-toc").addEventListener("click", (e) => panes.toggle("toc", { focus: e.detail === 0 }));
  $("#btn-open").addEventListener("click", () => void chooseFile());
  $("#btn-open-empty").addEventListener("click", () => void chooseFile());
  $("#btn-paste-empty").addEventListener("click", () => void pasteFromClipboard());
  // Ctrl+V and Shift+Insert outside the editor and the text fields: a document of its own
  document.addEventListener("paste", onPaste);
  btnPin.addEventListener("click", togglePin);
  wireDragScroll();

  // right-click on a file (tree or title): new window, reveal, copy path, copy link
  treeRoot.addEventListener("contextmenu", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".tree-row");
    if (!row) return;
    const isDir = row.classList.contains("dir");
    const path = isDir ? row.parentElement?.dataset.path : row.dataset.path;
    if (!path) return;
    e.preventDefault();
    const p = menuPoint(e, row);
    openFileMenu(path, p.x, p.y, { isDir, keyboard: fromKeyboard(e) });
  });
  docTitle.addEventListener("contextmenu", (e) => {
    if (!currentDoc || currentDoc.path === null) return;
    e.preventDefault();
    const p = menuPoint(e, docTitle);
    openFileMenu(currentDoc.path, p.x, p.y, { keyboard: fromKeyboard(e) });
  });

  // Every other right-click: Leggimi's menu in the document (and Copy for a
  // selection elsewhere), WebView2's own only in text fields and the editor.
  // Its Back, Refresh, Save as and Share act on the app's page, not the file.
  document.addEventListener("contextmenu", (e) => {
    if (e.defaultPrevented) return; // the file menu took it
    let target = e.target as HTMLElement;
    if (isTextEditable(target)) return;
    e.preventDefault();
    const keyboard = fromKeyboard(e);
    // from the keys with nothing focused, Chromium aims at the top-left corner
    // (the toolbar): the document is what the menu is for
    if (keyboard && currentDoc && !article.hidden && !contentPane.contains(target) && !editorPane.contains(target) && !target.closest("dialog")) {
      target = article;
    }
    const p = keyboard ? keyboardMenuPoint() : { x: e.clientX, y: e.clientY };
    hideShareMenu();
    hideReadingMenu();
    contextMenu.openAt(buildDocMenu(target, p.y), p.x, p.y, { keyboard });
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
    void copyRange(range, sel.toString());
  });
  $("#recent-clear").addEventListener("click", () => {
    recents.clear();
    renderRecents().catch(() => {});
  });
  contentPane.addEventListener("scroll", onContentScroll, { passive: true });
  window.addEventListener("resize", updateProgress);

  // a jump through the outline leaves a place to come back to (and closes
  // the outline when it was shown over the text)
  toc.onJump((h) => {
    panes.closePeek();
    noteJump(h);
  });

  // outline filter
  tocFilter.addEventListener("input", () => {
    const n = toc.setFilter(tocFilter.value, t("pane.noMatches"));
    tocFilterClear.hidden = tocFilter.value.length === 0;
    // the count reaches screen readers once typing pauses (WCAG 4.1.3)
    sayCountSoon(tocFilter.value.trim() ? (n === 0 ? t("pane.noMatches") : n === 1 ? t("toc.countOne") : t("toc.count", { n: i18n.fmtNumber(n) })) : "");
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
  $("#rate-now").addEventListener("click", rateOnStore);
  // answered in another window: the card goes here too
  rating.onChange(() => {
    if (!rateToast.hidden && !rating.due()) hideRateToast();
  });
  $("#rate-later").addEventListener("click", () => {
    rating.later();
    hideRateToast();
  });
  $("#rate-never").addEventListener("click", () => {
    rating.done();
    hideRateToast();
  });
  btnEdit.addEventListener("click", () => void toggleEditMode());
  btnSave.addEventListener("click", () => void saveFile());
  btnShare.addEventListener("click", (e) => {
    e.stopPropagation(); // the document click-away handler must not see this
    toggleShareMenu();
  });
  shareMenu.addEventListener("keydown", (e) =>
    handleMenuKey(e, shareMenu, () => {
      hideShareMenu();
      btnShare.focus();
    }),
  );
  readingMenu.addEventListener("beforetoggle", (e) => {
    if ((e as ToggleEvent).newState !== "open") return;
    hideShareMenu();
    contextMenu.close();
    syncReadingMenu();
    positionMenu(readingMenu, btnReading);
  });
  $("#share-copy").addEventListener("click", () => {
    hideShareMenu();
    void copyDocAsRichText();
  });
  $("#share-print").addEventListener("click", () => {
    hideShareMenu();
    void printDoc();
  });
  $("#export-pdf").addEventListener("click", () => {
    hideShareMenu();
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
    hideShareMenu();
    void exportDocAsHtml();
  });
  $("#export-docx").addEventListener("click", () => {
    hideShareMenu();
    void exportDocAsDocx();
  });
  // the Aa popover closes itself on a click elsewhere
  document.addEventListener("click", (e) => {
    if (!shareMenu.hidden && !shareMenu.contains(e.target as Node)) hideShareMenu();
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
  $("#rs-lang").addEventListener("click", (e) => void pickLanguage(e));
  async function pickLanguage(e: MouseEvent): Promise<void> {
    const opt = (e.target as HTMLElement).closest<HTMLButtonElement>(".rs-opt");
    if (!opt) return;
    const next = opt.dataset.value as i18n.LangPref;
    if (next === i18n.activePref()) return;
    // get_initial_file was consumed at boot: the tabs go across the reload,
    // unsaved edits and undo included; only when they cannot is it asked
    // (pasted text, changed or not, is in no file to come back from)
    if (!carryTabs() && session.live().some((x) => tabDirty(x) || x.src.kind === "pasted")) {
      const ok = await ask(t("msg.langReloadQ"), {
        title: t("msg.discardTitle"),
        kind: "warning",
        okLabel: t("msg.discard"),
        cancelLabel: t("msg.cancel"),
      }).catch(() => false);
      if (!ok) return;
    }
    i18n.setPref(next);
    // WebView2's own parts (its menus, the spelling dictionary) follow at the next start
    await ipc.rememberLanguage(next).catch(() => {});
    location.reload();
  }
  prefs.onChange(() => {
    syncReadingMenu();
    editorMod?.refresh();
    updateProgress();
  });
  theme.onChange(() => syncReadingMenu());
  $("#btn-help").addEventListener("click", () => void openHelp());
  $("#help-close").addEventListener("click", () => helpDialog.close());
  // rating from the help counts: the card does not ask again
  $("#help-rate").addEventListener("click", rateOnStore);
  btnUp.addEventListener("click", () => void goUp());
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
    notice: noticeBar,
    input: $("#find-input"),
    counter: $("#find-count"),
    btnPrev: $("#find-prev"),
    btnNext: $("#find-next"),
    btnClose: $("#find-close"),
    say: (text) => notices.announce(text),
  });

  // F5, Ctrl+R: the file from disk, never WebView2's reload (which restarts
  // the app on the home). In the capture phase, so no dialog or panel
  // can let the key through to the browser.
  // Ctrl+W and Ctrl+F4 close the tab (or the dialog on top of it),
  // Ctrl+Shift+W the window, from anywhere; the keyboard's Back and Forward
  // keys have no text to move through
  window.addEventListener(
    "keydown",
    (e) => {
      // Esc puts a tab being dragged back where it was
      if (e.key === "Escape" && strip.cancelDrag()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (isCloseKey(e)) {
        e.preventDefault();
        // held down, it must not go on to close the next tab too
        if (!e.repeat) closeTabByKey();
        return;
      }
      if (isCloseWindowKey(e)) {
        e.preventDefault();
        if (!e.repeat) getCurrentWindow().close().catch(() => {});
        return;
      }
      if (e.key === "BrowserBack" || e.key === "BrowserForward") {
        e.preventDefault();
        if (!e.repeat && !modalOpen()) {
          void (e.key === "BrowserBack" ? goBack() : goForward());
        }
        return;
      }
      if (!isReloadKey(e)) return;
      e.preventDefault();
      if (e.repeat || modalOpen()) return;
      reloadCurrentDoc();
    },
    true,
  );

  // the mouse's side buttons: Back and Forward, never WebView2's own history
  // (it has none to go to: every link is handled here)
  for (const type of ["mousedown", "mouseup"] as const) {
    window.addEventListener(type, (e) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (type === "mousedown" || modalOpen()) return;
      void (e.button === 3 ? goBack() : goForward());
    });
  }

  document.addEventListener("keydown", (e) => {
    // Esc closes it natively and +/-/0/arrows are handled inside it; F1 too,
    // so a help dialog cannot stack on top of a modal preview
    if (lightbox.isOpen()) return;
    if (e.key === "F1") {
      e.preventDefault();
      // the palette lets F1 through: the help takes its place
      closePalette();
      if (helpDialog.open) helpDialog.close();
      else void openHelp();
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
    // the editor already handled it (Ctrl+B/I format there, Ctrl+S saved once,
    // Ctrl+K made a link)
    if (e.defaultPrevented) return;
    // the command palette: Ctrl+K, or Ctrl+Shift+P as in VS Code (the one left in the editor)
    if (isPaletteKey(e)) {
      e.preventDefault();
      if (!e.repeat) void openPalette();
      return;
    }
    if (e.key === "Escape" && (!shareMenu.hidden || readingMenuOpen() || contextMenu.isOpen())) {
      closeMenus();
      return;
    }
    if (handleTabKey(e)) return;
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
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      if (!e.repeat) openInNewWindow(null);
    } else if (
      e.altKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.metaKey &&
      (e.key === "ArrowLeft" || e.key === "ArrowRight") &&
      !isTextEditable(document.activeElement)
    ) {
      // Back and Forward; in the editor and in text fields Alt+arrows move the
      // caret (a ticked checkbox keeps the focus, and is no text field)
      e.preventDefault();
      void (e.key === "ArrowLeft" ? goBack() : goForward());
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "f") {
      // a selection in the document is what to look for
      e.preventDefault();
      openFolderSearch(selectionQuery());
    } else if (e.ctrlKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      findInDocument();
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
    } else if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "a" && !isTypingTarget(document.activeElement)) {
      // the document, not the whole window: toolbar, file pane and outline stay out
      if (currentDoc && !article.hidden) {
        e.preventDefault();
        window.getSelection()?.selectAllChildren(article);
      }
    } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
      e.preventDefault();
      void chooseFile();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      toggleShareMenu();
    } else if (e.ctrlKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      void toggleEditMode();
    } else if (e.ctrlKey && e.key.toLowerCase() === "s") {
      // always swallow it: WebView2 would otherwise open its save-page dialog
      e.preventDefault();
      void saveFile();
    } else if (e.ctrlKey && e.key.toLowerCase() === "b") {
      e.preventDefault();
      panes.toggle("tree", { focus: true });
    } else if (e.ctrlKey && e.key.toLowerCase() === "i") {
      e.preventDefault();
      panes.toggle("toc", { focus: true });
    } else if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "p") {
      // swallow it even without a document: WebView2 would print the empty UI
      e.preventDefault();
      void printDoc();
    } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "c") {
      e.preventDefault();
      void copyDocAsRichText();
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
  window.addEventListener("beforeprint", () => {
    void enterPrintTheme(); // the light theme is set at once, before its first await
    preparePrintWide();
  });
  window.addEventListener("afterprint", () => {
    if (pdfInProgress) return;
    leavePrintTheme();
    undoPrintWideNow();
  });

  // help dialog links (licence, repository) → default browser
  helpDialog.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href") ?? "";
    if (!/^https?:/i.test(href)) return;
    e.preventDefault();
    openUrl(href).catch(() => {});
  });

  // in-article links (see followLink), image-map areas and SVG links included;
  // Ctrl+click opens a document in a new tab, Shift+click in a new window
  article.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a, area");
    if (!a) return;
    const href = linkHref(a);
    if (!href) return;
    e.preventDefault();
    followLink(href, whereFrom(e), a);
  });

  // task-list checkboxes write the change back to the source
  article.addEventListener("click", (e) => {
    const box = (e.target as HTMLElement).closest<HTMLInputElement>("input.task-list-item-checkbox");
    if (box) void onTaskToggle(box);
  });

  // While editing, a double-click on the preview puts the editor's caret on
  // that word (the same occurrence of a repeated one), with its block at the
  // height it has in the preview, so the synced preview stays put. While
  // reading, a double-click keeps selecting a word, as everywhere else.
  article.addEventListener("dblclick", (e) => {
    if (!editing || !editorMod) return;
    const target = e.target as Element;
    // links, task boxes, buttons and zoomable media keep their own clicks
    if (target.closest("a, button, input, img, summary, .mermaid-diagram, [data-zoomable]")) return;
    const block = target.closest<HTMLElement>("[data-source-line]");
    const line = Number(block?.dataset.sourceLine);
    if (!block || !Number.isFinite(line)) return;
    const sel = window.getSelection();
    let word = "";
    let before: string | undefined;
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed && block.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      word = sel.toString(); // Windows adds the trailing space; placeCaret trims it
      const pre = document.createRange();
      pre.setStart(block, 0);
      pre.setEnd(r.startContainer, r.startOffset);
      before = pre.toString();
    }
    const viewportY = block.getBoundingClientRect().top - contentPane.getBoundingClientRect().top - SYNC_MARGIN;
    // the preview already shows the block where the reader looks: the editor
    // scroll that follows must not re-sync it (the sync maps the editor's top
    // line by interpolation, and source and preview heights differ)
    syncSuppressedUntil = performance.now() + 300;
    editorMod.placeCaret(line, { word, viewportY, before });
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
  // keep the language mirrored for the next start (a choice made before this
  // version lives only in localStorage)
  ipc.rememberLanguage(i18n.activePref()).catch(() => {});
  theme.init();
  prefs.init();
  showVersion().catch(() => {});
  storeReady = showStoreRating().catch(() => {});
  // the document follows the theme: the light or dark image of a <picture>,
  // and the diagrams drawn for it
  theme.onChange((t) => {
    applyScheme(article, theme.schemeOf(t));
    rerenderForTheme(article, theme.schemeOf(t) === "dark").catch(() => {});
  });
  // text settings changed in another window reflow this one: keep the place
  prefs.syncAcrossWindows(withReadingAnchor);
  wireUi();
  // the tabs where the file name was, the window's buttons at the right end
  strip.init(stripHost, $("#toolbar"), docTitle);
  chrome.init();

  // registering this handler makes JS responsible for closing the window,
  // which needs the core:window:allow-destroy capability. One question at a
  // time: a second Ctrl+W or click on X while it is asked changes nothing.
  let askingToClose = false;
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (askingToClose) {
      e.preventDefault();
      return;
    }
    // edits not saved, and pasted text in no file yet, changed or not
    const unsaved = session.live().filter(goesWithWindow);
    closingWindow = true;
    if (unsaved.length === 0) return;
    askingToClose = true;
    // meanwhile a file opened from outside goes to another window
    ipc.setClosing(true).catch(() => {});
    try {
      const q = closeWindowQuestion(unsaved);
      const choice = await askSave(q.text, t(unsaved.length === 1 ? "msg.save" : "msg.saveAll"), q.title);
      let close = choice !== "cancel";
      if (choice === "save") {
        for (const tab of unsaved) {
          if (!(await saveTab(tab))) {
            close = false;
            break;
          }
        }
      } else if (choice === "discard") {
        for (const tab of unsaved) {
          const key = draftKeyOf(tab);
          if (key) drafts.remove(key);
        }
      }
      if (!close) {
        e.preventDefault();
        closingWindow = false;
        ipc.setClosing(false).catch(() => {});
      }
    } finally {
      askingToClose = false;
    }
  });

  // listeners must be live before get_initial_file, or a double-click
  // arriving during startup would be lost
  await ipc.onOpenFile((l) => {
    if (bootQueue) bootQueue.push(l);
    else routeOpen(l);
  });
  await ipc.onFileChanged((change) => {
    if (!session.hasActive()) return;
    // the tabs behind the one in front that show this file
    for (const tab of session.tabs) {
      if (tab === session.active() || tab.closing || !isTabOf(tab, change.path)) continue;
      onBehindFileChanged(tab, change);
    }
    // a replaced watch can still deliver a last batch, about the file before
    if (!currentDoc || currentDoc.path === null || !samePath(change.path, currentDoc.path)) return;
    if (change.kind === "renamed" && change.to) {
      onDocRenamed(change.to);
      return;
    }
    if (change.kind === "removed") {
      onDocRemoved();
      return;
    }
    // there again after a deletion (an Undo in File Explorer): read it anew
    if (docGone) onDocBack();
    if (isOwnWrite(change.path)) return; // echo of our own save (looked at again when the window ends)
    onFrontChanged();
  });
  // files coming and going in the pane's folder; the document may be among them
  await ipc.onTreeChanged(() => {
    // pictures found by name (![[x.png]]) may have moved: looked for again
    forgetFoundFiles();
    void refreshTree().then((changed) => {
      // the search reads every file: again only when files came or went
      if (changed && treeSearch.value.trim()) void runFolderSearch();
    });
    void checkDocOnDisk();
  });
  // Back in front: what changed on disk meanwhile shows up, and the folder's
  // watch is renewed, since Windows can drop one without a word
  await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused) return;
    if (browseRoot) ipc.watchTree(browseRoot, true).catch(() => {});
    void refreshTree();
    void checkDocOnDisk();
  });
  await getCurrentWebview().onDragDropEvent((event) => {
    const type = event.payload.type;
    if (type === "enter") app.classList.add("dropping");
    else if (type === "leave") app.classList.remove("dropping");
    else if (type === "drop") {
      app.classList.remove("dropping");
      // several documents: a tab each, the first in front; let go on the tab
      // strip, they go where they were let go
      const mds = event.payload.paths.filter(isMarkdownPath);
      const img = event.payload.paths.find(isImagePath);
      if (mds.length > 0) {
        const x = event.payload.position.x / devicePixelRatio;
        const y = event.payload.position.y / devicePixelRatio;
        const r = strip.rect();
        const onStrip = x >= r.left && x <= r.right && y >= r.top - 8 && y <= r.bottom + 8;
        const at = onStrip ? strip.indexAtClient(x) : undefined;
        mds.forEach((p, i) => openInTab(p, { background: i > 0, index: at === undefined ? undefined : at + i }));
      } else if (img && editing) void insertDroppedImage(img);
    }
  });

  // tabs carried between windows
  await ipc.onTabHover((h) => {
    if (!closingWindow) void strip.showGhost(h);
  });
  await ipc.onTabHoverEnd(() => strip.hideGhost());
  await ipc.onTabOffer((o) => void acceptOffer(o));
  await ipc.onTabAccepted(onTabAccepted);
  await ipc.onWindowDragDrop((d) => void offerWindowTab(d.target, d.x, d.y));

  // The first tab: the file asked for (or a tab torn off another window), the
  // tabs of before a language change, or the start page. Back and Forward
  // survive that reload too.
  navHistory.load();
  const initial = await ipc.getInitialFile().catch(() => null);
  const front = takeCarriedTabs() ?? firstTab(initial);
  sessionStorage.removeItem("reopen");
  strip.render();
  await activateTab(front);
  const early = bootQueue ?? [];
  bootQueue = null;
  for (const l of early) routeOpen(l);
  installTestHooks();
  // pasted text a crash left unsaved: offered once the first tab is on screen
  void recoverPastedDrafts();

  await ipc.showWindow().catch(() => {});
  windowShown = true;
}

// The window is born hidden and only the end of boot() shows it: a step that throws
// would leave Leggimi running out of sight, seemingly not starting (report B-11). It
// shows anyway, with what could be drawn and the error in a notice.
boot().catch((err: unknown) => {
  console.error("boot failed", err);
  void ipc.showWindow().catch(() => {});
  windowShown = true;
  try {
    showNotice(String(err), { kind: "error" });
  } catch {
    /* the page itself is not there: the window at least shows */
  }
});
