import { EditorSelection, EditorState, type Line } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleTabFocusMode } from "@codemirror/commands";
import { search, searchKeymap, searchPanelOpen, findNext, findPrevious } from "@codemirror/search";
import { syntaxHighlighting, syntaxTree, HighlightStyle } from "@codemirror/language";
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import { t } from "./i18n";
import {
  COMMANDS,
  commandById,
  activeFormats,
  iconHtml,
  spellCompartment,
  spellAttrs,
  spellcheckEnabled,
  openFind as openFindCmd,
  openReplace as openReplaceCmd,
  syncSearchPanel,
  searchPanelClosed,
} from "./editCommands";
import { mountFormatBar } from "./formatBar";

export interface EditorCallbacks {
  onDocChanged(): void;
  onDirtyChanged(dirty: boolean): void;
  onScroll(): void;
  /** the caret or selection moved without an edit (click, arrows, drag) */
  onCaretMoved(): void;
  requestSave(): void;
  /** an image was pasted into the editor */
  onImagePasted(file: File): void;
}

let view: EditorView | null = null;
let callbacks: EditorCallbacks | null = null;
// LF-normalized snapshot of the last saved content; CM works in LF internally
let lastSaved = "";
let eol: "\n" | "\r\n" = "\n";
let dirty = false;
// the format bar listens for the formats under the caret
let formatsListener: ((active: Set<string>) => void) | null = null;

// Colors come from the app's CSS variables, so the editor follows the
// light/dark toggle without being reconfigured.
const appTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "var(--editor-font-size, 14px)",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
  },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.6",
    padding: "12px 0 48px",
  },
  ".cm-content": { caretColor: "var(--accent)", padding: "0 12px 0 6px" },
  ".cm-cursor": { borderLeftColor: "var(--accent)" },
  // CM paints the selection in a layer *behind* the lines, so the active-line
  // tint must stay translucent or it hides a selection within the line
  ".cm-selectionBackground": {
    backgroundColor: "color-mix(in srgb, var(--accent) 16%, transparent) !important",
  },
  "&.cm-focused .cm-selectionBackground, &.cm-focused ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent) !important",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--text) 4%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--text-muted)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
  // the "/" menu
  ".cm-tooltip.cm-tooltip-autocomplete": {
    border: "1px solid var(--border)",
    borderRadius: "10px",
    backgroundColor: "var(--surface)",
    boxShadow: "var(--shadow)",
    padding: "4px",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--sans)",
    fontSize: "13px",
    maxHeight: "min(340px, 50vh)",
    minWidth: "240px",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "6px 10px 6px 6px",
    borderRadius: "7px",
    color: "var(--text)",
    lineHeight: "1.3",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "var(--accent-soft)",
    color: "var(--text)",
  },
  ".cm-slash-icon": {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "28px",
    height: "28px",
    borderRadius: "7px",
    border: "1px solid var(--border)",
    backgroundColor: "var(--bg)",
    color: "var(--text-muted)",
  },
  "li[aria-selected] .cm-slash-icon": { color: "var(--accent)", borderColor: "transparent" },
  ".cm-slash-icon .cmd-glyph": { fontSize: "11px", fontWeight: "700", letterSpacing: "-0.02em" },
  ".cm-completionLabel": { flex: "1" },
  ".cm-completionMatchedText": { textDecoration: "none", fontWeight: "600" },
  ".cm-completionDetail": {
    marginLeft: "12px",
    fontStyle: "normal",
    fontSize: "11.5px",
    color: "var(--text-muted)",
  },
  // find & replace panel (@codemirror/search), styled like the app's bars.
  // CodeMirror stacks panels at z-index 300, above the app's menus (40), so
  // the format bar's dropdowns opened under the panel; the scroller is its
  // own stacking context, so 1 still keeps the panel over the text.
  ".cm-panels": { backgroundColor: "var(--surface)", color: "var(--text)", border: "none", zIndex: "1" },
  // Ctrl+F: the find row only (Ctrl+H shows the replace row too)
  ".cm-search.cm-search-find-only [name=replace], .cm-search.cm-search-find-only [name=replaceAll]": {
    display: "none",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search": {
    fontFamily: "var(--sans)",
    fontSize: "12.5px",
    padding: "6px 8px",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "4px 6px",
  },
  ".cm-panel.cm-search br": { display: "none" },
  // the replace controls start their own row, under the find field: a <br> is
  // no flex item, so a full-width ::after breaks the line and `order` moves
  // the replace field and buttons after it (the close button stays on row 1)
  ".cm-panel.cm-search::after": { content: '""', flexBasis: "100%", height: "0", order: "1" },
  ".cm-panel.cm-search.cm-search-find-only::after": { display: "none" },
  ".cm-panel.cm-search [name=replace], .cm-panel.cm-search [name=replaceAll]": { order: "2" },
  // the field, buttons and close button below also dress the go-to-line
  // dialog (further down), so both bars read alike
  ".cm-panel.cm-search .cm-textfield, .cm-panel.cm-dialog .cm-textfield": {
    font: "inherit",
    fontSize: "12.5px",
    minWidth: "180px",
    padding: "4px 8px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    backgroundColor: "var(--bg)",
    color: "var(--text)",
    outline: "none",
  },
  ".cm-panel.cm-search .cm-textfield:focus, .cm-panel.cm-dialog .cm-textfield:focus": {
    borderColor: "var(--accent)",
  },
  ".cm-panel.cm-search .cm-button, .cm-panel.cm-dialog .cm-button": {
    font: "inherit",
    fontSize: "12px",
    padding: "4px 8px",
    border: "1px solid var(--border)",
    borderRadius: "6px",
    backgroundImage: "none",
    backgroundColor: "var(--surface)",
    color: "var(--text)",
    cursor: "pointer",
  },
  // --surface-2 is all but the surface itself in dark and black
  ".cm-panel.cm-search .cm-button:hover, .cm-panel.cm-dialog .cm-button:hover": {
    backgroundColor: "var(--surface-hover)",
  },
  ".cm-panel.cm-search label": {
    fontSize: "12px",
    color: "var(--text-muted)",
    display: "inline-flex",
    alignItems: "center",
    gap: "3px",
    marginLeft: "4px",
  },
  ".cm-panel.cm-search input[type=checkbox]": { accentColor: "var(--accent)", margin: "0" },
  ".cm-panel.cm-search [name=close], .cm-panel.cm-dialog .cm-dialog-close": {
    position: "static",
    marginLeft: "auto",
    padding: "0 6px",
    fontSize: "16px",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  // Go to line (Ctrl+Alt+G) is CodeMirror's dialog under the text. Its own
  // style knows only a light editor: a white field and a pale button under
  // the dark themes' light text could not be read. A <label> holds the
  // prompt and the field, then come the Go button and the close button.
  ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
  ".cm-panel.cm-dialog": {
    fontFamily: "var(--sans)",
    fontSize: "12.5px",
    padding: "6px 8px",
    display: "flex",
    alignItems: "center",
    gap: "6px",
  },
  ".cm-panel.cm-dialog form": { display: "flex", alignItems: "center", gap: "6px" },
  ".cm-panel.cm-dialog label": {
    fontSize: "12px",
    color: "var(--text-muted)",
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
  },
  // a line number ("120", "+5", "50%", "12:4"), not a search phrase
  ".cm-panel.cm-dialog .cm-textfield": { minWidth: "0", width: "7em" },
  ".cm-searchMatch": { backgroundColor: "rgba(250, 204, 21, 0.4)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#f59e0b", color: "#1a1915" },
});

// Keys as the app displays them ("Ctrl+Shift+X") → CodeMirror ("Mod-Shift-x")
function cmKey(shortcut: string): string {
  return shortcut
    .split("+")
    .map((k) => (k === "Ctrl" ? "Mod" : k.length === 1 ? k.toLowerCase() : k))
    .join("-");
}

const formatKeymap = COMMANDS.filter((c) => c.shortcut).map((c) => ({
  key: c.key ?? cmKey(c.shortcut!),
  run: c.run,
  preventDefault: true,
}));

// CodeMirror's defaults without Ctrl+M: it switches Tab from indenting to
// moving the focus, for as long as the window lives, with nothing on screen
// to say so, one Shift away from Ctrl+Shift+M (inline code). Escape then Tab
// still moves the focus out of the editor.
const baseKeymap = defaultKeymap.filter((b) => b.run !== toggleTabFocusMode);

// "/" at the start of a line opens a menu of blocks; typing filters it
const blockCommands = COMMANDS.filter((c) => c.block);

function slashSource(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const m = /^(\s*)\/(\w*)$/.exec(line.text.slice(0, ctx.pos - line.from));
  if (!m) return null;
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock" || n.name === "HTMLBlock") return null;
  }
  // match the start of any word of the label or keywords: "/t" finds Table,
  // Task list and Tip, not everything that merely contains a "t"
  const q = m[2].toLowerCase();
  const options: Completion[] = blockCommands
    .filter((c) => !q || `${c.label} ${c.keywords ?? ""}`.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
    .map((c) => ({
      label: c.label,
      detail: c.shortcut,
      type: c.id,
      apply: (view, _completion, from, to) => {
        view.dispatch({ changes: { from, to }, userEvent: "input.format" });
        c.run(view);
      },
    }));
  if (!options.length) return null;
  return { from: line.from + m[1].length, options, filter: false };
}

const slashMenu = autocompletion({
  override: [slashSource],
  icons: false,
  addToOptions: [
    {
      render: (completion) => {
        const span = document.createElement("span");
        span.className = "cm-slash-icon";
        span.innerHTML = iconHtml(commandById.get(completion.type ?? "")?.icon ?? "", 15);
        return span;
      },
      position: 20,
    },
  ],
});

const mdHighlight = HighlightStyle.define([
  { tag: tags.heading, fontWeight: "700", color: "var(--text)" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: tags.link, color: "var(--accent)" },
  { tag: tags.url, color: "var(--accent)" },
  { tag: tags.monospace, color: "var(--text-muted)" },
  { tag: tags.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: tags.meta, color: "var(--text-muted)" },
  { tag: tags.processingInstruction, color: "var(--text-muted)" },
  { tag: tags.labelName, color: "var(--accent)" },
]);

function computeDirty(): void {
  if (!view || !callbacks) return;
  const nowDirty = view.state.doc.toString() !== lastSaved;
  if (nowDirty !== dirty) {
    dirty = nowDirty;
    callbacks.onDirtyChanged(dirty);
  }
}

export function mount(host: HTMLElement, cb: EditorCallbacks): void {
  if (view) return;
  callbacks = cb;
  const bar = document.createElement("div");
  bar.id = "format-bar";
  const editorHost = document.createElement("div");
  editorHost.id = "editor-host";
  host.append(bar, editorHost);
  view = new EditorView({
    parent: editorHost,
    state: makeState(""),
  });
  onActiveFormats(mountFormatBar(bar, runCommand));
  // scrollDOM survives setState(), so one listener covers the app's lifetime
  view.scrollDOM.addEventListener("scroll", () => callbacks?.onScroll(), { passive: true });
}

// CodeMirror's own UI strings in the interface language: the find panel's
// fields and buttons, go to line, and the screen-reader announcements
const cmPhrases = EditorState.phrases.of({
  Find: t("cm.find"),
  Replace: t("cm.replace"),
  next: t("cm.next"),
  previous: t("cm.previous"),
  all: t("cm.all"),
  "match case": t("cm.matchCase"),
  regexp: t("cm.regexp"),
  "by word": t("cm.byWord"),
  replace: t("cm.replaceOne"),
  "replace all": t("cm.replaceAll"),
  close: t("cm.close"),
  "current match": t("cm.currentMatch"),
  "on line": t("cm.onLine"),
  "replaced $ matches": t("cm.replacedMatches"),
  "replaced match on line $": t("cm.replacedOnLine"),
  "Go to line": t("cm.gotoLine"),
  go: t("cm.go"),
  Completions: t("cm.completions"),
  "Selection deleted": t("cm.selectionDeleted"),
});

function makeState(content: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      cmPhrases,
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      highlightActiveLine(),
      history(),
      EditorView.lineWrapping,
      scrollPastEnd(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      slashMenu,
      search({ top: true }),
      spellCompartment.of(spellAttrs(spellcheckEnabled())),
      syntaxHighlighting(mdHighlight),
      appTheme,
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            callbacks?.requestSave();
            return true;
          },
        },
        // also from inside the panel's fields, so Ctrl+F / Ctrl+H switch its face
        { key: "Mod-f", run: openFindCmd, scope: "editor search-panel", preventDefault: true },
        { key: "Mod-h", run: openReplaceCmd, scope: "editor search-panel", preventDefault: true },
        ...formatKeymap,
        indentWithTab,
        ...historyKeymap,
        ...searchKeymap,
        ...baseKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          callbacks?.onDocChanged();
          computeDirty();
        }
        if (update.docChanged || update.selectionSet) formatsListener?.(activeFormats(update.state));
        if (update.selectionSet && !update.docChanged) callbacks?.onCaretMoved();
        // a panel opened by any path (F3 too) gets the right face
        const panelWas = searchPanelOpen(update.startState);
        const panelIs = searchPanelOpen(update.state);
        if (panelIs && !panelWas) syncSearchPanel(update.view);
        else if (panelWas && !panelIs) searchPanelClosed();
      }),
      // clipboard images (screenshots) land as files; text paste stays native.
      // Native file *drops* never reach the DOM here — Tauri intercepts them.
      EditorView.domEventHandlers({
        paste: (e) => {
          const file = [...(e.clipboardData?.items ?? [])]
            .find((i) => i.kind === "file" && i.type.startsWith("image/"))
            ?.getAsFile();
          if (!file) return false;
          e.preventDefault();
          callbacks?.onImagePasted(file);
          return true;
        },
      }),
    ],
  });
}

export function setContent(content: string): void {
  if (!view) return;
  eol = content.includes("\r\n") ? "\r\n" : "\n";
  const normalized = content.replace(/\r\n/g, "\n");
  lastSaved = normalized;
  dirty = false;
  // a fresh state also resets the undo history and cursor
  view.setState(makeState(normalized));
  callbacks?.onDirtyChanged(false);
  formatsListener?.(activeFormats(view.state));
}

/** Put a recovered draft in the buffer; `lastSaved` (the file) stays, so it is dirty. */
export function loadDraft(text: string): void {
  if (!view) return;
  view.setState(makeState(text));
  dirty = text !== lastSaved;
  callbacks?.onDirtyChanged(dirty);
  formatsListener?.(activeFormats(view.state));
  // setState fires no update listener: tell the preview (and the draft
  // timer) by hand, or the restored text shows only after the next keystroke
  callbacks?.onDocChanged();
}

/** Ctrl+F / Ctrl+H pressed outside the text (preview, toolbar) while editing. */
export function openFind(withReplace: boolean): void {
  if (!view) return;
  if (withReplace) openReplaceCmd(view);
  else openFindCmd(view);
}

/** F3 / Shift+F3 outside the text: next or previous match (opens the panel without a query). */
export function findStep(dir: 1 | -1): void {
  if (!view) return;
  if (dir === 1) findNext(view);
  else findPrevious(view);
}

export function getContent(): string {
  if (!view) return "";
  const text = view.state.doc.toString();
  return eol === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export function currentText(): string {
  return view?.state.doc.toString() ?? "";
}

export function markSaved(): void {
  if (!view) return;
  lastSaved = view.state.doc.toString();
  if (dirty) {
    dirty = false;
    callbacks?.onDirtyChanged(false);
  }
}

export function isDirty(): boolean {
  return dirty;
}

export function focus(): void {
  view?.focus();
}

// re-measure after an external font-size change (the Aa popover)
export function refresh(): void {
  view?.requestMeasure();
}

/** Run a command from the format bar and hand the focus back to the text. */
export function runCommand(id: string): void {
  const cmd = commandById.get(id);
  if (!view || !cmd) return;
  cmd.run(view);
  view.focus();
}

export function onActiveFormats(listener: (active: Set<string>) => void): void {
  formatsListener = listener;
  if (view) listener(activeFormats(view.state));
}

/** Replace one 0-based line of the buffer (the preview's checkbox toggles). */
export function replaceLine(line: number, text: string): void {
  if (!view || line < 0 || line >= view.state.doc.lines) return;
  const l = view.state.doc.line(line + 1);
  view.dispatch({ changes: { from: l.from, to: l.to, insert: text }, userEvent: "input.format" });
}

export function insertAtCursor(text: string): void {
  if (!view) return;
  view.dispatch(view.state.replaceSelection(text));
  view.focus();
}

// 0-based fractional source line at the top of the editor viewport. The
// fraction walks smoothly through the visual rows of a wrapped logical line.
export function topVisibleLine(): number {
  if (!view) return 0;
  const h = view.scrollDOM.getBoundingClientRect().top - view.documentTop;
  const block = view.lineBlockAtHeight(h);
  const line = view.state.doc.lineAt(block.from);
  const frac = block.height > 0 ? Math.min(1, Math.max(0, (h - block.top) / block.height)) : 0;
  return line.number - 1 + frac;
}

/** 0-based line of the caret, or null when it is scrolled out of view. */
export function visibleCaretLine(): number | null {
  if (!view) return null;
  const head = view.state.selection.main.head;
  const coords = view.coordsAtPos(head);
  const box = view.scrollDOM.getBoundingClientRect();
  if (!coords || coords.bottom < box.top || coords.top > box.bottom) return null;
  return view.state.doc.lineAt(head).number - 1;
}

export function isAtTop(): boolean {
  return (view?.scrollDOM.scrollTop ?? 0) < 1;
}

export function lineCount(): number {
  return view?.state.doc.lines ?? 1;
}

// One-shot jump to a 0-based source line (edit-mode entry). Moves the caret
// too: a caret left at line 1 would fling both panes to the top on the first
// arrow key. Selection-only dispatches do not fire onDocChanged.
export function scrollToLine(line: number): void {
  if (!view) return;
  const n = Math.max(1, Math.min(view.state.doc.lines, Math.floor(line) + 1));
  const pos = view.state.doc.line(n).from;
  view.dispatch({
    selection: { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 12 }),
  });
}

// A double-click on the preview names a block (its source line) and a word
// read there; these find that word in the block's source.

// Letters (with their combining marks) and digits: what a whole word does
// not touch on either side.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}]";

// The preview curls straight quotes (markdown-it's typographer) and the
// source keeps them straight: l’ is l'. One UTF-16 unit for another, so
// offsets stay valid.
const straighten = (s: string): string => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

// A link's or an image's target: (address "title"), with one level of
// parentheses allowed inside.
const TARGET = String.raw`\([^()\n]*(?:\([^()\n]*\)[^()\n]*)*\)`;

// Prose source as the preview shows it: comments, images, link targets and
// HTML tags become spaces of the same length (offsets stay valid). A word
// read in the preview is never in there, and a word in a link's address
// would throw off the count of a repeated word. Code spans stay as written.
const HIDDEN = new RegExp(
  [
    "(`+)[\\s\\S]*?\\1", // a code span, kept
    "<!--[\\s\\S]*?(?:-->|$)", // a comment
    String.raw`!\[[^\]\n]*\]` + TARGET, // an image
    String.raw`\]` + TARGET, // a link's target
    String.raw`<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?\/?>`, // an HTML tag
  ].join("|"),
  "g",
);

function shownText(source: string): string {
  return straighten(source).replace(HIDDEN, (m: string, ticks?: string) => (ticks ? m : m.replace(/[^\n]/g, " ")));
}

// Each match of `word` in `text`. Whitespace in the word matches any run of
// whitespace: a line break in the source is a space in the preview.
function matchesOf(text: string, word: string, ignoreCase: boolean, whole: boolean): { from: number; to: number }[] {
  const body = word
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  const re = new RegExp(whole ? `(?<!${WORD_CHAR})${body}(?!${WORD_CHAR})` : body, ignoreCase ? "giu" : "gu");
  return [...text.matchAll(re)].map((m) => ({ from: m.index ?? 0, to: (m.index ?? 0) + m[0].length }));
}

// `word` in a block's text. With `before` (the preview's text of the block
// in front of the clicked word), the same occurrence of a repeated word:
// both sides count the loose way, any case and inside longer words too.
// Without it, the first match: a whole word in the exact case, then in any
// case, then inside a longer word (a Chinese word has no spaces around it).
function findWord(text: string, word: string, before?: string): { from: number; to: number } | null {
  if (before !== undefined) {
    const all = matchesOf(text, word, true, false);
    const n = matchesOf(straighten(before), word, true, false).length;
    return all.length ? all[Math.min(n, all.length - 1)] : null;
  }
  for (const [ignoreCase, whole] of [[false, true], [true, true], [false, false], [true, false]] as const) {
    const [first] = matchesOf(text, word, ignoreCase, whole);
    if (first) return first;
  }
  return null;
}

// The source of the preview block starting at `first`: up to the next blank
// line, at most 60 lines. A fenced code block keeps its blank lines and
// runs to the closing fence; its text starts below the opening fence.
function blockRange(state: EditorState, first: Line): { from: number; to: number; code: boolean } {
  const { doc } = state;
  const fence = /^ {0,3}(`{3,}|~{3,})/.exec(first.text);
  const closing = fence ? new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*$`) : null;
  let to = first.to;
  for (let n = first.number + 1; n <= Math.min(doc.lines, first.number + 59); n++) {
    const l = doc.line(n);
    if (closing ? closing.test(l.text) : !l.text.trim()) break;
    to = l.to;
  }
  return { from: fence ? Math.min(first.to + 1, to) : first.from, to, code: !!fence };
}

/**
 * A double-click on the preview while editing: the caret goes to the
 * 0-based source `line` (the start of the block clicked) and selects `word`
 * when the block's source has it (from `line` to the next blank line, at
 * most 60 lines; exact case first, then any case). `before`, the block's
 * preview text in front of the word (a Range from the block's start to the
 * selection's start), picks the same occurrence of a repeated word.
 * Without a match the caret goes to the line start. The line lands
 * `viewportY` px below the top of the editor's visible area (where the
 * block sits in the preview, so the synced preview does not jump), kept
 * within the view's height. Focuses the editor.
 */
export function placeCaret(line: number, opts: { word?: string; viewportY?: number; before?: string } = {}): void {
  if (!view || !Number.isFinite(line)) return;
  const { state } = view;
  const first = state.doc.line(Math.max(1, Math.min(state.doc.lines, Math.floor(line) + 1)));
  const block = blockRange(state, first);
  const word = straighten(opts.word?.trim() ?? "");
  let hit: { from: number; to: number } | null = null;
  if (word && word.length <= 200) {
    const source = state.sliceDoc(block.from, block.to);
    hit = findWord(block.code ? straighten(source) : shownText(source), word, opts.before);
  }
  const selection = hit
    ? EditorSelection.single(block.from + hit.from, block.from + hit.to)
    : EditorSelection.single(first.from);
  // within the view with a row to spare; negative too, since a tall block's
  // start can be above the top in the preview as well
  const room = Math.max(0, view.scrollDOM.clientHeight - 2 * view.defaultLineHeight);
  const wanted = opts.viewportY ?? NaN;
  const y = Number.isFinite(wanted) ? Math.max(-room, Math.min(room, wanted)) : 12;
  view.dispatch({
    selection,
    effects: EditorView.scrollIntoView(first.from, { y: "start", yMargin: y }),
  });
  view.focus();

  // The source can wrap taller than the preview, so a word far down its
  // block may still land outside the view. CodeMirror scrolls in its
  // measure, which runs first in the next frame; then bring the word in.
  const doc = view.state.doc;
  const range = view.state.selection.main;
  requestAnimationFrame(() => {
    if (!view || view.state.doc !== doc || !view.state.selection.main.eq(range)) return;
    const box = view.scrollDOM.getBoundingClientRect();
    const at = view.coordsAtPos(range.head);
    if (!box.height || (at && at.top >= box.top && at.bottom <= box.bottom)) return;
    view.dispatch({ effects: EditorView.scrollIntoView(range, { y: "nearest", yMargin: 24 }) });
  });
}
