import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  scrollPastEnd,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import { COMMANDS, commandById, activeFormats, iconHtml } from "./editCommands";
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
});

// Keys as the app displays them ("Ctrl+Shift+X") → CodeMirror ("Mod-Shift-x")
function cmKey(shortcut: string): string {
  return shortcut
    .split("+")
    .map((k) => (k === "Ctrl" ? "Mod" : k.length === 1 ? k.toLowerCase() : k))
    .join("-");
}

const formatKeymap = COMMANDS.filter((c) => c.shortcut).map((c) => ({
  key: cmKey(c.shortcut!),
  run: c.run,
  preventDefault: true,
}));

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

function makeState(content: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      drawSelection(),
      highlightActiveLine(),
      history(),
      EditorView.lineWrapping,
      scrollPastEnd(),
      markdown({ base: markdownLanguage, codeLanguages: languages }),
      slashMenu,
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
        ...formatKeymap,
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          callbacks?.onDocChanged();
          computeDirty();
        }
        if (update.docChanged || update.selectionSet) formatsListener?.(activeFormats(update.state));
        if (update.selectionSet && !update.docChanged) callbacks?.onCaretMoved();
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
