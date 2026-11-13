// The table editor (2.4): in a GFM table, Tab lines the columns up and
// selects the next cell, Shift+Tab the previous one, Tab in the last cell
// adds a row, and Enter at the end of the last row adds one too (Enter on an
// empty last row leaves the table). Cells are read from the text's pipes, as
// the preview (markdown-it) and the editor's parser read them: only \| keeps
// a pipe inside a cell, a pipe in inline code splits it. Widths count what
// shows: CJK and emoji take two columns, combining marks none.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, type EditorState } from "@codemirror/state";
import type { Command } from "@codemirror/view";

type Align = "" | "l" | "c" | "r";

interface Row {
  cells: string[];
  /** where each cell's text starts and ends in the line, for the caret */
  spans: { from: number; to: number }[];
}

interface Table {
  firstLine: number;
  lastLine: number;
  prefix: string;
  rows: Row[];
  aligns: Align[];
  cols: number;
}

/** The Table node around `pos`, or null. */
function tableNode(state: EditorState, pos: number): { from: number; to: number } | null {
  for (const side of [-1, 1] as const) {
    for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(pos, side); n; n = n.parent) {
      if (n.name === "Table") return n;
    }
  }
  return null;
}

// indent and quote markers in front of a row
const PREFIX = /^[ \t]*(?:>[ \t]?)*[ \t]*/;

function splitRow(text: string, prefixLen: number): Row {
  const cells: string[] = [];
  const spans: { from: number; to: number }[] = [];
  let start = prefixLen;
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (text[start] === "|") start++;
  let cellFrom = start;
  let trailingPipe = false;
  const push = (from: number, to: number): void => {
    let a = from;
    let b = to;
    while (a < b && /\s/.test(text[a])) a++;
    while (b > a && /\s/.test(text[b - 1])) b--;
    cells.push(text.slice(a, b));
    spans.push({ from, to });
  };
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "|") {
      push(cellFrom, i);
      cellFrom = i + 1;
      trailingPipe = i === end - 1;
    }
  }
  if (!trailingPipe) push(cellFrom, end);
  return { cells, spans };
}

function readTable(state: EditorState, pos: number): Table | null {
  const node = tableNode(state, pos);
  if (!node) return null;
  const doc = state.doc;
  const firstLine = doc.lineAt(node.from).number;
  const lastLine = doc.lineAt(node.to).number;
  if (lastLine - firstLine < 1) return null;
  const prefix = PREFIX.exec(doc.line(firstLine).text)![0];
  const rows: Row[] = [];
  for (let n = firstLine; n <= lastLine; n++) {
    const text = doc.line(n).text;
    rows.push(splitRow(text, PREFIX.exec(text)![0].length));
  }
  const aligns = rows[1].cells.map((c): Align => {
    const left = c.startsWith(":");
    const right = c.endsWith(":") && c.length > 1;
    return left && right ? "c" : right ? "r" : left ? "l" : "";
  });
  const cols = Math.max(...rows.map((r) => r.cells.length));
  return { firstLine, lastLine, prefix, rows, aligns, cols };
}

const WIDE = (cp: number): boolean =>
  (cp >= 0x1100 && cp <= 0x115f) ||
  (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
  (cp >= 0xac00 && cp <= 0xd7a3) ||
  (cp >= 0xf900 && cp <= 0xfaff) ||
  (cp >= 0xfe30 && cp <= 0xfe4f) ||
  (cp >= 0xff00 && cp <= 0xff60) ||
  (cp >= 0xffe0 && cp <= 0xffe6) ||
  (cp >= 0x1f300 && cp <= 0x1faff) ||
  (cp >= 0x20000 && cp <= 0x3fffd);

/** Columns a text takes in a monospace font. */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (/\p{M}/u.test(ch) || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    w += WIDE(cp) || /\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  }
  return w;
}

function pad(text: string, width: number, align: Align): { text: string; lead: number } {
  const room = Math.max(0, width - textWidth(text));
  const lead = align === "r" ? room : align === "c" ? Math.floor(room / 2) : 0;
  return { text: " ".repeat(lead) + text + " ".repeat(room - lead), lead };
}

function delimiter(width: number, align: Align): string {
  if (align === "c") return ":" + "-".repeat(Math.max(1, width - 2)) + ":";
  if (align === "l") return ":" + "-".repeat(Math.max(2, width - 1));
  if (align === "r") return "-".repeat(Math.max(2, width - 1)) + ":";
  return "-".repeat(Math.max(3, width));
}

interface Layout {
  lines: string[];
  /** per row, per column: where the cell's text starts in its line, and its length */
  cells: { from: number; length: number }[][];
}

function layout(table: Table, extraRow: boolean): Layout {
  const rows = table.rows.map((r) => r.cells);
  if (extraRow) rows.push([]);
  const { cols, aligns, prefix } = table;
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(3, ...rows.filter((_, i) => i !== 1).map((cells) => textWidth(cells[c] ?? ""))),
  );
  const lines: string[] = [];
  const cells: { from: number; length: number }[][] = [];
  rows.forEach((row, i) => {
    let line = prefix + "|";
    const at: { from: number; length: number }[] = [];
    for (let c = 0; c < cols; c++) {
      if (i === 1) {
        const d = delimiter(widths[c], aligns[c] ?? "");
        at.push({ from: line.length + 1, length: d.length });
        line += " " + d + " |";
      } else {
        const text = row[c] ?? "";
        const p = pad(text, widths[c], aligns[c] ?? "");
        at.push({ from: line.length + 1 + p.lead, length: text.length });
        line += " " + p.text + " |";
      }
    }
    lines.push(line);
    cells.push(at);
  });
  return { lines, cells };
}

/** The caret's row and column in the table (row 1 is the delimiter row). */
function cellAt(state: EditorState, table: Table, pos: number): { row: number; col: number } {
  const line = state.doc.lineAt(pos);
  const row = line.number - table.firstLine;
  const offset = pos - line.from;
  const spans = table.rows[row].spans;
  let col = spans.findIndex((s) => offset <= s.to);
  if (col < 0) col = spans.length - 1;
  return { row, col: Math.max(0, Math.min(table.cols - 1, col)) };
}

function apply(state: EditorState, table: Table, out: Layout, row: number, col: number) {
  const doc = state.doc;
  const from = doc.line(table.firstLine).from;
  const to = doc.line(table.lastLine).to;
  const text = out.lines.join("\n");
  let start = from;
  for (let i = 0; i < row; i++) start += out.lines[i].length + 1;
  const cell = out.cells[row][col];
  return state.update({
    changes: { from, to, insert: text },
    selection: EditorSelection.range(start + cell.from, start + cell.from + cell.length),
    scrollIntoView: true,
    userEvent: "input.format",
  });
}

function move(dir: 1 | -1): Command {
  return (view) => {
    const { state } = view;
    if (state.selection.ranges.length !== 1) return false;
    const table = readTable(state, state.selection.main.head);
    if (!table) return false;
    let { row, col } = cellAt(state, table, state.selection.main.head);
    let extra = false;
    col += dir;
    if (col >= table.cols) {
      col = 0;
      row++;
    } else if (col < 0) {
      col = table.cols - 1;
      row--;
    }
    if (row === 1) row += dir;
    if (row < 0) {
      row = 0;
      col = 0;
    }
    if (row >= table.rows.length) {
      extra = true;
      row = table.rows.length;
      col = 0;
    }
    view.dispatch(apply(state, table, layout(table, extra), row, col));
    return true;
  };
}

/** Tab in a table: line it up, select the next cell (a row is added after the last). */
export const nextCell = move(1);
/** Shift+Tab in a table: line it up, select the previous cell. */
export const previousCell = move(-1);

/** Enter at the end of a table's last row: a new row; on an empty last row, out of the table. */
export const tableEnter: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  if (state.selection.ranges.length !== 1 || !sel.empty) return false;
  const table = readTable(state, sel.head);
  if (!table) return false;
  const line = state.doc.lineAt(sel.head);
  if (line.number !== table.lastLine || state.sliceDoc(sel.head, line.to).trim() !== "") return false;
  const last = table.rows[table.rows.length - 1];
  if (table.rows.length > 2 && last.cells.every((c) => !c)) {
    // an empty last row: it goes, and the caret leaves the table
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: "" },
      selection: EditorSelection.cursor(line.from),
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }
  view.dispatch(apply(state, table, layout(table, true), table.rows.length, 0));
  return true;
};

/** Line the table under the caret up, the caret staying in its cell. */
export const formatTable: Command = (view) => {
  const { state } = view;
  const table = readTable(state, state.selection.main.head);
  if (!table) return false;
  const { row, col } = cellAt(state, table, state.selection.main.head);
  view.dispatch(apply(state, table, layout(table, false), row, col));
  return true;
};
