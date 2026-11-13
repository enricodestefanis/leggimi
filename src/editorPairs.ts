// Pairs that close themselves while typing Markdown (2.4). ( [ { and " are
// CodeMirror's closeBrackets, given Markdown's own list below; the backtick
// and the emphasis markers are handled here, because closeBrackets would
// leave a stray backtick when a line becomes ``` and would pair * _ ~ = on
// an empty selection, which breaks "* item" lists. The apostrophe is never
// paired: Italian prose is full of them (l'altro).

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, type Command, type KeyBinding } from "@codemirror/view";

/**
 * closeBrackets' settings for Markdown text only: inside a fenced block the
 * block's language brings its own (there ' and ` do close, as code wants).
 * A bracket closes before a space, a line end or these characters.
 */
export const markdownBrackets: Extension = markdownLanguage.data.of({
  closeBrackets: { brackets: ["(", "[", "{", '"'], before: ")]}:;>.,!?" },
});

const CODE = new Set(["FencedCode", "CodeBlock", "InlineCode", "Frontmatter", "InlineMath"]);

/**
 * Is `pos` inside code, where Markdown's pairs do not apply? Strictly inside:
 * a selection that starts on an inline code span's first backtick is not in
 * it (so `code` selected and * typed becomes *`code`*), and a caret right
 * after an inline code's closing backtick is out of it.
 */
function inCode(state: EditorState, pos: number, side: -1 | 1): boolean {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
    if (!CODE.has(n.name)) continue;
    if (n.from < pos && (pos < n.to || (pos === n.to && n.name !== "InlineCode" && n.name !== "InlineMath"))) return true;
  }
  return false;
}

const isWord = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);

// the start of a line where a fence may begin: indent, quote markers, a list marker
const FENCE_START = /^[ \t]*(?:>[ \t]?)*(?:(?:[-*+]|\d+[.)])[ \t]+)?``$/;

// a code block (not inline code): its language's rules hold there
const BLOCKS = new Set(["FencedCode", "CodeBlock", "Frontmatter"]);
function inBlock(state: EditorState, pos: number): boolean {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, -1); n; n = n.parent) {
    if (BLOCKS.has(n.name) && n.from < pos && pos <= n.to) return true;
  }
  return false;
}

function typeBacktick(view: EditorView): boolean {
  const { state } = view;
  // the closer of an inline code span typed by hand is stepped over, inside the span too
  const stepsOver = (pos: number): boolean => state.sliceDoc(pos, pos + 1) === "`" && !inBlock(state, pos);
  if (state.selection.ranges.some((r) => (r.empty ? inCode(state, r.head, -1) && !stepsOver(r.head) : inCode(state, r.from, 1)))) {
    return false;
  }
  const tr = state.changeByRange((range) => {
    if (!range.empty) {
      return {
        changes: [
          { from: range.from, insert: "`" },
          { from: range.to, insert: "`" },
        ],
        range: EditorSelection.range(range.anchor + 1, range.head + 1),
      };
    }
    const pos = range.head;
    const next = state.sliceDoc(pos, pos + 1);
    const prev = state.sliceDoc(pos - 1, pos);
    const line = state.doc.lineAt(pos);
    const before = state.sliceDoc(line.from, pos);
    // ``` being typed: the third one is just a backtick, the fence has no closer on its line
    if (FENCE_START.test(before)) return { changes: { from: pos, insert: "`" }, range: EditorSelection.cursor(pos + 1) };
    // the closer typed by hand: step over it
    if (next === "`") return { range: EditorSelection.cursor(pos + 1) };
    // against a word it closes or opens a span already written: no pair
    if ((prev && isWord(prev)) || (next && isWord(next))) {
      return { changes: { from: pos, insert: "`" }, range: EditorSelection.cursor(pos + 1) };
    }
    return { changes: { from: pos, insert: "``" }, range: EditorSelection.cursor(pos + 1) };
  });
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.type" }));
  return true;
}

// * _ ~ =: with every range selected, wrap each and keep its inside selected,
// so typing the marker twice makes **bold**, ~~strike~~, ==highlight==
function wrapSelection(view: EditorView, ch: string): boolean {
  const { state } = view;
  const ranges = state.selection.ranges;
  if (ranges.some((r) => r.empty)) return false;
  if (ranges.some((r) => inCode(state, r.from, 1) || inCode(state, r.to, -1))) return false;
  const tr = state.changeByRange((range) => ({
    changes: [
      { from: range.from, insert: ch },
      { from: range.to, insert: ch },
    ],
    range: EditorSelection.range(range.anchor + 1, range.head + 1),
  }));
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input.type" }));
  return true;
}

/** Typing ` and * _ ~ = (the input handler; it gives way during IME composition). */
export const markdownPairInput: Extension = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.compositionStarted || view.state.readOnly || text.length !== 1) return false;
  const main = view.state.selection.main;
  if (from !== main.from || to !== main.to) return false;
  if (text === "`") return typeBacktick(view);
  if (text === "*" || text === "_" || text === "~" || text === "=") return wrapSelection(view, text);
  return false;
});

// Backspace between the two backticks of an empty pair takes both away (as
// closeBrackets does for its own pairs); not inside `` or ``` runs
const deleteBacktickPair: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  if (state.sliceDoc(pos - 1, pos) !== "`" || state.sliceDoc(pos, pos + 1) !== "`") return false;
  if (state.sliceDoc(pos - 2, pos - 1) === "`" || state.sliceDoc(pos + 1, pos + 2) === "`") return false;
  if (inCode(state, pos, -1)) return false;
  view.dispatch({ changes: { from: pos - 1, to: pos + 1 }, userEvent: "delete.backward", scrollIntoView: true });
  return true;
};

/**
 * Enter at the end of a fence's opening line, when the block is not closed:
 * a line for the code and the closing fence under it, the caret in between.
 * The tree must cover the whole document: a partial one shows every fence
 * open. "Not closed" = that FencedCode holds a single CodeMark.
 */
const closeFenceOnEnter: Command = (view) => {
  const { state } = view;
  if (state.selection.ranges.length !== 1 || !state.selection.main.empty) return false;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  if (pos !== line.to || !/(?:`{3,}|~{3,})[^`]*$/.test(line.text)) return false;
  const tree = ensureSyntaxTree(state, state.doc.length, 50);
  if (!tree) return false;
  let fence: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(pos, -1);
  while (fence && fence.name !== "FencedCode") fence = fence.parent;
  if (!fence || state.doc.lineAt(fence.from).number !== line.number) return false;
  const marks = fence.getChildren("CodeMark");
  if (marks.length !== 1) return false;
  const open = marks[0];
  const fenceText = state.sliceDoc(open.from, open.to);
  // the closing fence lines up with the opening one: quote markers stay,
  // a list marker becomes spaces
  const indent = state.sliceDoc(line.from, open.from).replace(/(?:[-*+]|\d+[.)])(?=[ \t])/g, (m) => " ".repeat(m.length));
  view.dispatch({
    changes: { from: pos, insert: `\n${indent}\n${indent}${fenceText}` },
    selection: EditorSelection.cursor(pos + 1 + indent.length),
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
};

/** Keys that go before Markdown's own (Prec.high, placed ahead of markdown() in the extensions). */
export const pairKeys: readonly KeyBinding[] = [
  { key: "Enter", run: closeFenceOnEnter },
  { key: "Backspace", run: deleteBacktickPair },
];
