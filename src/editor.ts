import { EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";

export interface EditorCallbacks {
  onDocChanged(): void;
  onDirtyChanged(dirty: boolean): void;
  onScroll(): void;
  requestSave(): void;
}

let view: EditorView | null = null;
let callbacks: EditorCallbacks | null = null;
// LF-normalized snapshot of the last saved content; CM works in LF internally
let lastSaved = "";
let eol: "\n" | "\r\n" = "\n";
let dirty = false;

// Colors come from the app's CSS variables, so the editor follows the
// light/dark toggle without being reconfigured.
const appTheme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "14px",
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
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--accent-soft) !important",
  },
  ".cm-activeLine": { backgroundColor: "var(--surface-2)" },
  ".cm-gutters": {
    backgroundColor: "var(--bg)",
    color: "var(--text-muted)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-2)", color: "var(--text)" },
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
  view = new EditorView({
    parent: host,
    state: makeState(""),
  });
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
      markdown({ base: markdownLanguage, codeLanguages: languages }),
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
        indentWithTab,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          callbacks?.onDocChanged();
          computeDirty();
        }
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
