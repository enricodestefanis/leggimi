// Paste and read, 2.3: what the clipboard holds, as the Markdown a pasted tab
// opens.
//
// The clipboard brings plain text and, from a browser, a chat app, Word,
// Teams or Excel, an HTML flavour beside it. A chat's Copy button gives
// Markdown as the plain text; a selection made with the mouse gives the
// page's text, its structure only in the HTML; a terminal draws its tables
// with box characters. So, in this order:
//   1. tables drawn with box characters in the plain text (Claude Code, psql,
//      MySQL) win: the plain text is read, those tables made Markdown tables;
//   2. plain text that already reads as Markdown is read as it is;
//   3. else HTML carrying structure the plain text lacks (headings, tables,
//      code, lists, emphasis, links, math) is turned into Markdown, with
//      turndown, loaded on the first paste that needs it;
//   4. else the plain text, as it came.
// On the way, an answer wrapped whole in a ```markdown block is unwrapped and
// \( \) / \[ \] become $ / $$ as the renderer reads them (renderer.ts,
// mathAsOnGitHub).
//
// Pure: no IPC, nothing of main.ts. The HTML is parsed into an inert document
// (DOMParser): no picture loads, no script runs, nothing of it reaches the page.

import type TurndownService from "turndown";
import { pastedText } from "./docs";

export interface PasteInput {
  text: string | null;
  html?: string | null;
}

/** what was done: the HTML turned into Markdown, terminal tables, a ```markdown wrapper taken off, \( \) and \[ \] made $ and $$ */
export type PasteChange = "html" | "box-table" | "tab-table" | "fence" | "math";

export interface PasteResult {
  /** the Markdown to open as the pasted tab's text ("" when there is nothing) */
  markdown: string;
  /** what was done to get it; [] when the text is used as it came */
  changes: PasteChange[];
  /** the plain text as it came (normalized like docs.ts pastedText), for "Show as copied" */
  plain: string;
}

/** The Markdown a paste opens. Lazy: turndown is loaded on the first call that needs it. Never throws. */
export async function convertPaste(input: PasteInput): Promise<PasteResult> {
  const plain = pastedText(input.text ?? "");
  let html: Converted | null = null;
  if (input.html) {
    try {
      html = await fromHtml(plain, input.html);
    } catch {
      html = null;
    }
  }
  return { ...(html ?? fromPlain(plain)), plain };
}

interface Converted {
  markdown: string;
  changes: PasteChange[];
}

/* ---------------------------------------------------------------- plain text */

function fromPlain(plain: string): Converted {
  const changes: PasteChange[] = [];
  let text = plain;
  const inner = unwrapFence(text);
  if (inner !== null) {
    text = inner;
    changes.push("fence");
  }
  const tabled = tablesFromBoxes(text);
  if (tabled !== text) {
    text = tabled;
    changes.push("box-table");
  }
  const tabbed = tablesFromTabs(text);
  if (tabbed !== text) {
    text = tabbed;
    changes.push("tab-table");
  }
  const math = mathAsDollars(text);
  if (math !== text) {
    text = math;
    changes.push("math");
  }
  return { markdown: text, changes };
}

// lines a loop pushes one by one: a spread of a million lines would overflow the stack
function append<T>(to: T[], from: readonly T[]): void {
  for (const x of from) to.push(x);
}

const nonSpace = (s: string): number => s.replace(/\s+/g, "").length;

/* ---- fenced code, which nothing here touches ---- */

interface Fence {
  ch: string;
  len: number;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

// a backtick fence's info string has no backticks (```js`x` is inline code)
function opensFence(line: string): Fence | null {
  const m = FENCE_OPEN.exec(line);
  if (!m || (m[1][0] === "`" && m[2].includes("`"))) return null;
  return { ch: m[1][0], len: m[1].length };
}

function closesFence(line: string, fence: Fence): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

/** true for each line inside a fenced code block, its fences included (unclosed: to the end, as CommonMark) */
function codeMask(lines: readonly string[]): boolean[] {
  const mask = new Array<boolean>(lines.length).fill(false);
  let fence: Fence | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence) {
      mask[i] = true;
      if (closesFence(lines[i], fence)) fence = null;
      continue;
    }
    fence = opensFence(lines[i]);
    if (fence) mask[i] = true;
  }
  return mask;
}

/* ---- a whole answer in a ```markdown block ---- */

/**
 * The text inside, when the whole text (blank lines around aside) is one
 * ```markdown / ```md / ~~~ block: up to its LAST closing fence, so that
 * blocks inside it survive. null when it is not one such block (text around
 * it, two blocks, fences inside that do not pair up).
 */
function unwrapFence(text: string): string | null {
  if (!/^\s*(?:`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*\n/i.test(text)) return null;
  const lines = text.split("\n");
  let a = 0;
  let b = lines.length - 1;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b].trim()) b--;
  const open = /^([ \t]*)(`{3,}|~{3,})[ \t]*(?:markdown|md)[ \t]*$/i.exec(lines[a]);
  const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(lines[b]);
  if (!open || !close || b === a || close[1][0] !== open[2][0] || close[1].length < open[2].length) return null;
  const inner = lines.slice(a + 1, b);
  if (!inner.some((l) => l.trim())) return null;
  // the fences inside must pair up: one left open means the wrapper closed
  // earlier and more text follows it, two blocks and not one
  let fence: Fence | null = null;
  for (const raw of inner) {
    const line = raw.replace(/^[ \t]+/, "");
    if (fence) {
      if (closesFence(line, fence)) fence = null;
    } else fence = opensFence(line);
  }
  if (fence) return null;
  // the wrapper's own indentation comes off its lines, as CommonMark reads them
  const indent = open[1];
  return inner.map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : indent ? l.replace(/^[ \t]+/, "") : l)).join("\n");
}

/* ---- tables a terminal draws ---- */

// the vertical lines of the box-drawing block a row is cut by, and the horizontal ones of a rule
const V = /[│┃║┆┇┊┋╎╏]/;
const V_ALL = /[│┃║┆┇┊┋╎╏]/g;
const H = /[─━═┄┅┈┉╌╍╴╶╸╺╼╾]/;
// Claude Code's mark before a message
const MARK = /^[⏺●][ \t]+/;
const PSQL_RULE = /^-+(?:\+-+)+$/;

interface BoxLine {
  rule: boolean;
  /** u: box-drawing characters; a: + - | (MySQL, psql with borders) */
  family: "u" | "a";
  body: string;
}

function boxLine(raw: string): BoxLine | null {
  let t = raw.trim();
  if (MARK.test(t)) t = t.replace(MARK, "");
  if (!t) return null;
  if (/^[\u2500-\u257F]+$/.test(t)) return H.test(t) ? { rule: true, family: "u", body: t } : null;
  if (/^\+(?:[-=:]+\+)+$/.test(t)) return { rule: true, family: "a", body: t };
  // a row: cut by vertical lines, and no other box character (a tree's ├── is no row)
  if (V.test(t) && !/[\u2500-\u257F]/.test(t.replace(V_ALL, ""))) return { rule: false, family: "u", body: t };
  if (t.length > 2 && t[0] === "|" && t[t.length - 1] === "|") return { rule: false, family: "a", body: t };
  return null;
}

function splitRow(line: BoxLine): string[] {
  const sep = line.family === "u" ? V : /\|/;
  const s = line.body;
  const parts = s.split(line.family === "u" ? V_ALL : "|");
  const bordered = sep.test(s[0]) && sep.test(s[s.length - 1]) && parts.length >= 2;
  return (bordered ? parts.slice(1, -1) : parts).map((c) => c.trim());
}

interface BoxTable {
  /** the lines [start, end) it takes */
  start: number;
  end: number;
  header: string[];
  rows: string[][];
}

// The row each group of lines makes: a cell's lines joined by a space.
function joined(group: string[][], n: number): string[] {
  return Array.from({ length: n }, (_, k) =>
    group
      .map((r) => r[k])
      .filter(Boolean)
      .join(" "),
  );
}

// A run of box lines as a table: rules split it into rows. With a rule
// between every row (Claude Code's way), the lines between two rules are one
// row whose cells wrapped; with a rule under the header only (MySQL, Rich),
// every line below it is a row, but in a box-drawn table a line with an
// empty first cell carries on the row above. null: not a table of two or
// more columns.
function tableOf(run: BoxLine[]): { header: string[]; rows: string[][] } | null {
  if (!run.some((r) => r.rule)) return null;
  let a = 0;
  let b = run.length;
  while (a < b && run[a].rule) a++;
  while (b > a && run[b - 1].rule) b--;
  const segs: string[][][] = [[]];
  let n = -1;
  for (let i = a; i < b; i++) {
    const line = run[i];
    if (line.rule) {
      if (segs[segs.length - 1].length) segs.push([]);
      continue;
    }
    const cells = splitRow(line);
    if (n < 0) n = cells.length;
    if (cells.length !== n) return null;
    segs[segs.length - 1].push(cells);
  }
  if (n < 2 || !segs[0].length) return null;
  if (segs.length >= 3) return { header: joined(segs[0], n), rows: segs.slice(1).map((g) => joined(g, n)) };
  const head = segs.length === 2 ? segs[0] : segs[0].slice(0, 1);
  const body = segs.length === 2 ? segs[1] : segs[0].slice(1);
  const groups: string[][][] = [];
  for (const cells of body) {
    const last = groups[groups.length - 1];
    if (run[0].family === "u" && last && !cells[0] && cells.some(Boolean)) last.push(cells);
    else groups.push([cells]);
  }
  return { header: joined(head, n), rows: groups.map((g) => joined(g, n)) };
}

// psql's own form: a header, a rule of - and + under it, rows cut by |
function psqlAt(lines: readonly string[], code: readonly boolean[], i: number): BoxTable | null {
  const rule = (lines[i + 1] ?? "").trim();
  if (code[i + 1] || !PSQL_RULE.test(rule) || !lines[i].includes("|")) return null;
  const n = rule.split("+").length;
  const cells = (s: string): string[] | null => {
    const parts = s.split("|");
    return parts.length === n ? parts.map((c) => c.trim()) : null;
  };
  const header = cells(lines[i]);
  if (!header) return null;
  const rows: string[][] = [];
  let j = i + 2;
  for (; j < lines.length && !code[j] && lines[j].trim(); j++) {
    const c = cells(lines[j]);
    if (!c) break;
    rows.push(c);
  }
  return { start: i, end: j, header, rows };
}

/** The tables drawn with box characters in `lines`, outside fenced code. */
function boxTables(lines: readonly string[], code: readonly boolean[]): BoxTable[] {
  const found: BoxTable[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = code[i] ? null : boxLine(lines[i]);
    if (!first) {
      const psql = code[i] ? null : psqlAt(lines, code, i);
      if (psql) {
        found.push(psql);
        i = psql.end;
      } else i++;
      continue;
    }
    const run = [first];
    let j = i + 1;
    for (; j < lines.length && !code[j]; j++) {
      const b = boxLine(lines[j]);
      if (!b || b.family !== first.family) break;
      run.push(b);
    }
    const t = tableOf(run);
    if (t) found.push({ start: i, end: j, ...t });
    i = j;
  }
  return found;
}

function gfmTable(header: string[], rows: string[][]): string[] {
  const cell = (s: string): string => s.replace(/\|/g, "\\|");
  const line = (cells: string[]): string => `| ${cells.map(cell).join(" | ")} |`;
  const out = [line(header), `| ${header.map(() => "---").join(" | ")} |`];
  for (const r of rows) out.push(line(r));
  return out;
}

/** `text` with its box-drawn tables as Markdown tables, a blank line around each; the rest as it is. */
function tablesFromBoxes(text: string): string {
  if (!/[\u2500-\u257F]|^[ \t]*(?:\+[-=]|-+\+-)/m.test(text)) return text;
  const lines = text.split("\n");
  const found = boxTables(lines, codeMask(lines));
  if (!found.length) return text;
  const out: string[] = [];
  let at = 0;
  for (const t of found) {
    append(out, lines.slice(at, t.start));
    if (out.length && out[out.length - 1].trim()) out.push("");
    append(out, gfmTable(t.header, t.rows));
    if (t.end < lines.length && lines[t.end].trim()) out.push("");
    at = t.end;
  }
  append(out, lines.slice(at));
  return out.join("\n");
}

/* ---- tables as tab-separated lines ---- */

// A table copied as plain text alone comes as lines of cells split by tabs: what a
// chat page's selection gives once its HTML is gone (saved in a .txt, sent by mail),
// Excel's own text, a TSV. Two lines or more in a row, outside code, each with the
// same number of cells (2 or more) and not starting with a tab (code indented with
// tabs): a Markdown table, its first line the header.
function tablesFromTabs(text: string): string {
  if (!text.includes("\t")) return text;
  const lines = text.split("\n");
  const code = codeMask(lines);
  // a list item, a quote or a heading is Markdown already, tab or not
  const marked = /^\s*(?:[-*+]|\d{1,9}[.)]|>|#{1,6})(?:[ \t]|$)/;
  const cells = (s: string): number => (/^\t|^ {4}/.test(s) || !s.includes("\t") || !s.trim() || marked.test(s) ? 0 : s.split("\t").length);
  const out: string[] = [];
  let changed = false;
  for (let i = 0; i < lines.length; ) {
    const n = code[i] ? 0 : cells(lines[i]);
    let j = i + 1;
    if (n >= 2) while (j < lines.length && !code[j] && cells(lines[j]) === n) j++;
    if (n < 2 || j - i < 2) {
      out.push(lines[i]);
      i++;
      continue;
    }
    const rows = lines.slice(i, j).map((l) => l.split("\t").map((c) => c.trim()));
    if (out.length && out[out.length - 1].trim()) out.push("");
    append(out, gfmTable(rows[0], rows.slice(1)));
    if (j < lines.length && lines[j].trim()) out.push("");
    changed = true;
    i = j;
  }
  return changed ? out.join("\n") : text;
}

/* ---- \( \) and \[ \] ---- */

// what display math holds that a citation "\[1\]" or a word in brackets does not
const TEX_LIKE = /[\\^_{}=+\-*/<>]/;
const BLANK_LINE = /\n[ \t]*\n/g;

function nextBlank(s: string, from: number): number {
  BLANK_LINE.lastIndex = from;
  const m = BLANK_LINE.exec(s);
  return m ? m.index : s.length;
}

// Where math can close in a text: the backslash of each \) and \] (an odd
// run of backslashes before the bracket) and each blank line, found in one
// walk, so that a thousand formulas, or a thousand never closed, are no
// thousand walks
interface Closers {
  paren: number[];
  bracket: number[];
  blanks: number[];
}

function closersIn(s: string): Closers {
  const paren: number[] = [];
  const bracket: number[] = [];
  const blanks: number[] = [];
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === "\\") {
      let n = 1;
      while (s[k + n] === "\\") n++;
      const after = s[k + n];
      if (n % 2 === 1 && after === ")") paren.push(k + n - 1);
      else if (n % 2 === 1 && after === "]") bracket.push(k + n - 1);
      k += n - 1;
    } else if (c === "\n") {
      let j = k + 1;
      while (s[j] === " " || s[j] === "\t") j++;
      if (s[j] === "\n") blanks.push(k);
    }
  }
  return { paren, bracket, blanks };
}

// the first value of a sorted list at or after x, or -1
function firstFrom(list: readonly number[], x: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo < list.length ? list[lo] : -1;
}

// What the math pass writes: pieces joined once at the end (a string grown
// and sliced again at each formula would copy the text over and over), and
// the line being written, which a $$ block needs to know
class Written {
  private parts: string[] = [];
  /** what was written since the last line end */
  line = "";

  push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    const nl = s.lastIndexOf("\n");
    this.line = nl >= 0 ? s.slice(nl + 1) : this.line + s;
  }

  /** the last n characters written on this line taken back */
  cut(n: number): void {
    let k = Math.min(n, this.line.length);
    this.line = this.line.slice(0, this.line.length - k);
    while (k > 0 && this.parts.length) {
      const last = this.parts[this.parts.length - 1];
      if (last.length <= k) {
        this.parts.pop();
        k -= last.length;
      } else {
        this.parts[this.parts.length - 1] = last.slice(0, last.length - k);
        k = 0;
      }
    }
  }

  text(): string {
    return this.parts.join("");
  }
}

/** `text` with \( … \) as $…$ and \[ … \] as $$ on lines of their own, outside fenced code and code spans. */
function mathAsDollars(text: string): string {
  if (!/\\[([]/.test(text)) return text;
  const lines = text.split("\n");
  const code = codeMask(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    if (code[i]) {
      out.push(lines[i++]);
      continue;
    }
    let j = i;
    while (j < lines.length && !code[j]) j++;
    out.push(mathIn(lines.slice(i, j).join("\n")));
    i = j;
  }
  return out.join("\n");
}

// a run of n backticks closing the code span opened by one at `from` (same length, before `stop`, a blank line); -1: none
function closingTicks(s: string, from: number, n: number, stop: number): number {
  for (let k = s.indexOf("`", from); k >= 0 && k < stop; k = s.indexOf("`", k)) {
    let r = 1;
    while (s[k + r] === "`") r++;
    if (r === n) return k;
    k += r;
  }
  return -1;
}

function mathIn(s: string): string {
  const out = new Written();
  const closers = closersIn(s);
  let i = 0;
  // the next blank line, found again only once passed
  let blank = -1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      if (blank < i) blank = nextBlank(s, i);
      const end = closingTicks(s, i + n, n, blank);
      const to = end >= 0 ? end + n : i + n;
      out.push(s.slice(i, to));
      i = to;
      continue;
    }
    if (ch === "\\") {
      let n = 1;
      while (s[i + n] === "\\") n++;
      const next = s[i + n];
      // an odd run: its last backslash escapes the bracket
      if (n % 2 === 1 && (next === "(" || next === "[")) {
        const open = i + n - 1;
        out.push(s.slice(i, open));
        const end = mathAt(s, open, next === "[", out, closers);
        if (end >= 0) {
          i = end;
          continue;
        }
        out.push(s.slice(open, open + 2));
        i = open + 2;
        continue;
      }
      out.push(s.slice(i, i + n));
      i += n;
      continue;
    }
    let j = i + 1;
    while (j < s.length && s[j] !== "`" && s[j] !== "\\") j++;
    out.push(s.slice(i, j));
    i = j;
  }
  return out.text();
}

// The math opened at `open` (a backslash before "(" or "["), written the
// renderer's way: the index just past what was read, or -1 when it is no
// math (no closing, a blank line first, empty) and nothing was written.
function mathAt(s: string, open: number, display: boolean, out: Written, closers: Closers): number {
  // a formula holds no blank line, and is not that long
  const blank = firstFrom(closers.blanks, open);
  const stop = Math.min(blank < 0 ? s.length : blank, open + 4000);
  const close = firstFrom(display ? closers.bracket : closers.paren, open + 2);
  if (close < 0 || close + 2 > stop) return -1;
  const inner = s.slice(open + 2, close);
  let end = close + 2;
  if (!display) {
    const t = inner.replace(/\s*\n\s*/g, " ").trim();
    if (!t || t.includes("$")) return -1;
    // a word right after: GitHub's $`…`$, which may touch it
    const tight = /\w/.test(s[end] ?? "");
    if (tight && t.includes("`")) return -1;
    out.push(tight ? `$\`${t}\`$` : `$${t}$`);
    return end;
  }
  // on lines of their own, in the quote and the list item the formula was in
  const before = out.line;
  const quote = /^(?:[ \t]*>[ \t]?)+/.exec(before)?.[0] ?? "";
  const inLine = before.slice(quote.length);
  const own = !inLine.trim();
  const item = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+/.exec(inLine);
  const lead = /^[ \t]*/.exec(inLine)?.[0] ?? "";
  const indent = quote + (!own && item ? " ".repeat(item[0].length) : lead);
  const body = inner
    .split("\n")
    .map((l) => (quote ? l.replace(/^(?:[ \t]*>)+[ \t]?/, "") : l).trim())
    .filter(Boolean);
  if (!body.length || !TEX_LIKE.test(inner)) return -1;
  if (own) out.cut(before.length);
  else {
    out.cut(before.length - before.replace(/[ \t]+$/, "").length);
    out.push("\n");
  }
  out.push([`${indent}$$`, ...body.map((l) => indent + l), `${indent}$$`].join("\n"));
  while (s[end] === " " || s[end] === "\t") end++;
  // text after it on its line goes on a line of its own
  if (end < s.length && s[end] !== "\n") out.push(`\n${indent}`);
  return end;
}

/* ---------------------------------------------------------------- HTML */

const MAX_HTML = 8 * 1024 * 1024;

function parseHtml(raw: string): Document | null {
  if (raw.length > MAX_HTML) return null;
  let html = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  // a CF_HTML header ("Version:0.9 StartHTML:…") before the markup
  if (/^Version:\s*\d/.test(html)) {
    const lt = html.indexOf("<");
    html = lt >= 0 ? html.slice(lt) : "";
  }
  // Excel's fragment: rows without their table, which the parser would drop
  if (/<t[rdh][\s>]/i.test(html) && !/<table[\s>]/i.test(html)) html = `<table>${html}</table>`;
  if (!html.trim()) return null;
  // an inert document: nothing in it loads or runs
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.body ? doc : null;
}

async function fromHtml(plain: string, raw: string): Promise<Converted | null> {
  const doc = parseHtml(raw);
  if (!doc) return null;
  const body = doc.body;
  // the markers this converter makes for itself, if the page brought its own: never trusted
  for (const el of [...body.querySelectorAll("x-raw, x-math, x-task")]) el.remove();
  const maths = takeMath(doc, body);
  sanitize(body);
  codeTables(doc, body);
  const shown = shownLines(body);
  const lines = plain.split("\n");
  const code = codeMask(lines);
  // 1. a terminal's tables win, unless the page shows those very lines as code
  if (boxTables(lines, code).some((t) => !lines.slice(t.start, t.end).every((l) => shown.code.has(key(l))))) return null;
  // a source file shown as such (an editor's copy, VS Code's: coloured spans in a monospaced
  // block with pre white space): its text is the Markdown, its colours and bold no structure
  if (mostlySource(body)) return null;
  // 2. Markdown already: a mark the page does not show is the source's
  const signs = markdownSigns(lines, shown.all);
  if (signs.strong) return null;
  // 3. structure in the HTML that the plain text lacks
  prepare(doc, body);
  const kinds = structure(body);
  for (const k of signs.explains) kinds.delete(k);
  if (!kinds.size) return null;
  // a flavour holding much less text than the plain one is not the same copy
  const chars = nonSpace(plain);
  if (chars && shown.chars < chars / 2) return null;
  let md = tidy((await turndown()).turndown(body));
  if (!md.trim()) return null;
  const changes: PasteChange[] = ["html"];
  if (maths && md.includes("$")) changes.push("math");
  const inner = unwrapFence(md);
  if (inner !== null) {
    md = inner.endsWith("\n") ? inner : `${inner}\n`;
    changes.push("fence");
  }
  return { markdown: md, changes };
}

const PRE_SPACE = /white-space\s*:\s*pre/i;

// 90 % of the text or more inside elements styled as source (pre white space, or a
// monospaced font): the outermost ones are counted once
function mostlySource(body: HTMLElement): boolean {
  const total = nonSpace(body.textContent ?? "");
  if (!total) return false;
  let mono = 0;
  let last: Element | null = null;
  for (const el of body.querySelectorAll("[style]")) {
    if (last?.contains(el)) continue;
    const st = el.getAttribute("style") ?? "";
    if (!PRE_SPACE.test(st) && !(/font-family/i.test(st) && MONO.test(st))) continue;
    mono += nonSpace(el.textContent ?? "");
    last = el;
  }
  return mono >= 0.9 * total;
}

/* ---- walking a tree without recursion (a page can nest deep) ---- */

interface Visit {
  /** false: do not go into it */
  enter?(el: Element): boolean | void;
  leave?(el: Element): void;
  text?(t: Text): void;
}

function walk(root: Node, on: Visit): void {
  let node: Node | null = root.firstChild;
  while (node) {
    let down = false;
    if (node.nodeType === 3) on.text?.(node as Text);
    else if (node.nodeType === 1) {
      down = on.enter?.(node as Element) !== false && !!node.firstChild;
      if (!down) on.leave?.(node as Element);
    }
    if (down) {
      node = node.firstChild;
      continue;
    }
    while (node && node !== root && !node.nextSibling) {
      node = node.parentNode;
      if (node && node !== root) on.leave?.(node as Element);
    }
    node = node && node !== root ? node.nextSibling : null;
  }
}

/* ---- math: the TeX, read before anything strips it ---- */

function mathNode(doc: Document, tex: string, display: boolean): Element {
  const el = doc.createElement("x-math");
  el.setAttribute("data-tex", tex.trim());
  if (display) el.setAttribute("data-display", "");
  el.textContent = tex.trim() || "m";
  return el;
}

// KaTeX (Claude, ChatGPT, Leggimi's own copy), MathML with its TeX
// (Wikipedia), MathJax 2's script: each formula becomes an <x-math> with its
// TeX. MathML without TeX keeps its text. The number made.
function takeMath(doc: Document, body: HTMLElement): number {
  let made = 0;
  for (const s of [...body.querySelectorAll('script[type^="math/tex" i]')]) {
    // MathJax 2: its rendering sits just before the script
    for (let prev = s.previousElementSibling; prev && /\bMathJax/.test(prev.getAttribute("class") ?? ""); ) {
      const p = prev.previousElementSibling;
      prev.remove();
      prev = p;
    }
    s.replaceWith(mathNode(doc, s.textContent ?? "", /mode\s*=\s*display/i.test(s.getAttribute("type") ?? "")));
    made++;
  }
  for (const m of [...body.querySelectorAll("math")]) {
    if (!m.isConnected) continue;
    const ann = m.querySelector('annotation[encoding="application/x-tex" i], annotation[encoding="TeX" i]');
    const box = m.closest(".katex-display") ?? m.closest(".katex, .mwe-math-element, mjx-container, .MathJax") ?? m;
    const display = m.getAttribute("display") === "block" || box.classList.contains("katex-display") || box.getAttribute("display") === "true";
    // Leggimi's own copy: its sanitizer took <semantics> and <annotation> out
    // of the MathML and left the TeX as a bare text of <math> (KaTeX's own
    // MathML has none)
    const bare = [...m.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue ?? "").join("");
    const tex = ann?.textContent ?? bare;
    if (tex.trim()) {
      box.replaceWith(mathNode(doc, tex, display));
      made++;
    } else box.replaceWith(doc.createTextNode(m.textContent ?? ""));
  }
  // KaTeX's drawn half, where a selection cut its MathML half off
  for (const el of [...body.querySelectorAll(".katex-html")]) el.remove();
  return made;
}

/* ---- what a page's copy holds that is no text ---- */

const DROP =
  "script, style, noscript, template, button, svg, canvas, iframe, frame, object, embed, video, audio, select, textarea, " +
  "datalist, meter, progress, dialog, title, meta, link, base, input:not([type='checkbox' i]), [hidden], " +
  "[style*='display:none' i], [style*='display: none' i], [style*='visibility:hidden' i], [style*='visibility: hidden' i], " +
  "pre [aria-hidden='true']";

function sanitize(body: HTMLElement): void {
  for (const el of [...body.querySelectorAll(DROP)]) el.remove();
}

const MONO = /consolas|monospace|courier|menlo|cascadia|\bmono\b/i;
const LANG_LABEL = /^[A-Za-z][\w+#.-]{0,24}$/;

// Leggimi's own copy (share.ts flattenCodeBlocks) and Outlook's: a code block
// as a table of one cell in a monospace font, its language in a row above
function codeTables(doc: Document, body: HTMLElement): void {
  for (const table of [...body.querySelectorAll("table")]) {
    const rows = [...table.rows];
    if (rows.length < 1 || rows.length > 2 || rows.some((r) => r.cells.length !== 1)) continue;
    const cell = rows[rows.length - 1].cells[0];
    if (!MONO.test(cell.getAttribute("style") ?? "") && !MONO.test(table.getAttribute("style") ?? "")) continue;
    const label = rows.length === 2 ? (rows[0].cells[0].textContent ?? "").trim() : "";
    if (rows.length === 2 && !LANG_LABEL.test(label)) continue;
    const pre = doc.createElement("pre");
    const code = doc.createElement("code");
    code.textContent = preText(cell).replace(/\n$/, "");
    if (label) code.setAttribute("class", `language-${label.toLowerCase()}`);
    pre.append(code);
    table.replaceWith(pre);
  }
}

// line breaks where blocks and <br> are, non-breaking spaces as spaces
const LINE_BLOCKS = /^(?:DIV|P|LI|TR|TABLE|H[1-6]|PRE|BLOCKQUOTE|UL|OL|SECTION|ARTICLE)$/;

function preText(root: Element): string {
  let out = "";
  const newline = (): void => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  walk(root, {
    text: (t) => {
      out += (t.nodeValue ?? "").replace(/\u00a0/g, " ");
    },
    enter: (el) => {
      if (el.nodeName === "BR") out += "\n";
      else if (LINE_BLOCKS.test(el.nodeName)) newline();
    },
    leave: (el) => {
      if (LINE_BLOCKS.test(el.nodeName)) newline();
    },
  });
  return out;
}

/* ---- the lines the page shows ---- */

interface Shown {
  /** every line of text the HTML shows, as key() has it */
  all: Set<string>;
  /** the lines inside its <pre> */
  code: Set<string>;
  /** characters that are not spaces */
  chars: number;
}

const key = (s: string): string =>
  (s.length > 4000 ? s.slice(0, 4000) : s)
    .replace(/[\s\u200b]+/g, " ")
    .trim()
    .slice(0, 1000);

const BLOCKS = new Set(
  "ADDRESS ARTICLE ASIDE BLOCKQUOTE CAPTION DD DETAILS DIALOG DIV DL DT FIELDSET FIGCAPTION FIGURE FOOTER FORM H1 H2 H3 H4 H5 H6 HEADER HGROUP HR LI MAIN NAV OL P PRE SECTION SUMMARY TABLE TBODY TD TFOOT TH THEAD TR UL".split(" "),
);

function shownLines(body: HTMLElement): Shown {
  const all = new Set<string>();
  const code = new Set<string>();
  let line = "";
  let pre = 0;
  let chars = 0;
  const flush = (): void => {
    const k = key(line);
    if (k) {
      all.add(k);
      if (pre) code.add(k);
    }
    line = "";
  };
  walk(body, {
    text: (t) => {
      const s = t.nodeValue ?? "";
      chars += nonSpace(s);
      if (!pre) {
        line += s;
        return;
      }
      const parts = s.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i) flush();
        line += parts[i];
      }
    },
    enter: (el) => {
      if (el.nodeName === "BR" || BLOCKS.has(el.nodeName)) flush();
      if (el.nodeName === "PRE") pre++;
    },
    leave: (el) => {
      if (BLOCKS.has(el.nodeName)) flush();
      if (el.nodeName === "PRE") pre--;
    },
  });
  flush();
  return { all, code, chars };
}

/* ---- does the plain text read as Markdown ---- */

type Kind = "heading" | "table" | "code" | "quote" | "list" | "rule" | "emphasis" | "link" | "inline-code" | "math" | "strike" | "task";

// one of these says the text is Markdown
const STRONG: RegExp[] = [
  /^ {0,3}#{1,6}[ \t]+\S/,
  /^ {0,3}(?:`{3,}|~{3,})/,
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$|^ {0,3}\|[ \t]*:?-+:?[ \t]*\|[ \t]*$/,
  /^ {0,3}[-*+][ \t]+\[[ xX]\](?:[ \t]|$)/,
  /\*\*(?=\S)[^*\n]*?\S\*\*|(?:^|[^\w])__(?=\S)[^_\n]*?\S__(?!\w)/,
  /\[[^\]\n]+\]\([^)\s]+(?:[ \t]+"[^"\n]*")?\)/,
  /`[^`\n]+`/,
];

// these say little alone (a typed "- " or "1." is common); each explains a
// kind of structure the HTML may have, which then is no reason to use it
const WEAK: [RegExp, Kind][] = [
  [/^ {0,3}[-*+][ \t]+\S/, "list"],
  [/^ {0,3}\d{1,9}[.)][ \t]+\S/, "list"],
  [/^ {0,3}>/, "quote"],
  [/^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/, "rule"],
  [/(?:^|[^\w*])\*(?=[^\s*])[^*\n]*?[^\s*]\*(?![\w*])|(?:^|[^\w])_(?=[^\s_])[^_\n]*?[^\s_]_(?!\w)/, "emphasis"],
  [/\$\$|\\\(|\\\[|(?:^|[^\w$\\])\$(?=\S)[^$\n]*?\S\$(?![\w$])/, "math"],
];

// A strong sign on a line the page does not show as it is (a "## Title" the
// page shows as "Title") means the plain text is the Markdown source: a
// chat's Copy button. A "# comment" the page shows in a code block is text.
function markdownSigns(lines: readonly string[], shown: Set<string>): { strong: boolean; explains: Set<Kind> } {
  const explains = new Set<Kind>();
  let looked = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    if (++looked > 5000) break;
    const line = raw.length > 1000 ? raw.slice(0, 1000) : raw;
    for (const [re, kind] of WEAK) if (!explains.has(kind) && re.test(line)) explains.add(kind);
    if (shown.has(key(raw))) continue;
    // a table's row as a selection gives it ("#\tName\tRole": a "#" column of numbers) is
    // cells split by tabs, not Markdown: Markdown's tables use pipes
    if (/\S\t+\S/.test(line.trim())) continue;
    if (STRONG.some((re) => re.test(line))) return { strong: true, explains };
  }
  return { strong: false, explains };
}

/* ---- the HTML's structure ---- */

const filled = (el: Element): boolean => !!el.textContent?.trim();

// <b style="font-weight:normal"> (Google Docs wraps a whole copy in one), <i style="font-style:normal">
function unstyled(el: Element): boolean {
  const style = el.getAttribute("style") ?? "";
  return /^(?:B|STRONG)$/.test(el.nodeName)
    ? /font-weight\s*:\s*(?:normal|[1-5]00)\b/i.test(style)
    : /^(?:I|EM)$/.test(el.nodeName) && /font-style\s*:\s*normal/i.test(style);
}

const BOLD_STYLE = /font-weight\s*:\s*(?:bold(?:er)?|[6-9]00)\b/i;
const ITALIC_STYLE = /font-style\s*:\s*(?:italic|oblique)/i;
const STRIKE_STYLE = /text-decoration(?:-line)?\s*:[^;]*line-through/i;

function above(el: Element, test: (e: Element) => boolean): boolean {
  for (let e = el.parentElement; e; e = e.parentElement) if (test(e)) return true;
  return false;
}

const isBold = (e: Element): boolean =>
  (/^(?:B|STRONG|H[1-6]|TH)$/.test(e.nodeName) && !unstyled(e)) || (e.nodeName === "SPAN" && BOLD_STYLE.test(e.getAttribute("style") ?? ""));
const isItalic = (e: Element): boolean =>
  (/^(?:I|EM)$/.test(e.nodeName) && !unstyled(e)) || (e.nodeName === "SPAN" && ITALIC_STYLE.test(e.getAttribute("style") ?? ""));
const isStrike = (e: Element): boolean =>
  /^(?:DEL|S|STRIKE)$/.test(e.nodeName) || (e.nodeName === "SPAN" && STRIKE_STYLE.test(e.getAttribute("style") ?? ""));

// the marks a styled <span> stands for (Google Docs, Word): "**", "*", "~~", in that order
function spanMarks(el: Element): string {
  const style = el.getAttribute("style") ?? "";
  let marks = "";
  if (BOLD_STYLE.test(style) && !above(el, isBold)) marks += "**";
  if (ITALIC_STYLE.test(style) && !above(el, isItalic)) marks += "*";
  if (STRIKE_STYLE.test(style) && !above(el, isStrike)) marks += "~~";
  return marks;
}

function isDataTable(t: HTMLTableElement): boolean {
  if (t.getAttribute("role") === "presentation" || t.querySelector("table")) return false;
  const rows = [...t.rows];
  return rows.length > 0 && (rows.some((r) => r.cells.length >= 2) || !!t.querySelector("th"));
}

const SCHEME = /^(?:https?:|mailto:)/i;

function structure(body: HTMLElement): Set<Kind> {
  const kinds = new Set<Kind>();
  const has = (sel: string, kind: Kind, ok: (el: Element) => boolean = filled): void => {
    for (const el of body.querySelectorAll(sel)) {
      if (ok(el)) {
        kinds.add(kind);
        return;
      }
    }
  };
  has("h1, h2, h3, h4, h5, h6", "heading");
  has("table", "table", (t) => isDataTable(t as HTMLTableElement));
  // a page that is one plain <pre> (a raw file) is its text, not a code block
  const pres = body.querySelectorAll("pre");
  if (pres.length > 1 || (pres.length === 1 && (codeLanguage(pres[0]) || nonSpace(pres[0].textContent ?? "") < 0.9 * nonSpace(body.textContent ?? "")))) {
    kinds.add("code");
  }
  has("blockquote", "quote");
  has("ul > li, ol > li", "list");
  has("hr", "rule", () => true);
  has("strong, b, em, i", "emphasis", (el) => filled(el) && !unstyled(el));
  has("span[style]", "emphasis", (el) => filled(el) && spanMarks(el) !== "");
  // a link reading as its own address is text a chat linked by itself
  has("a[href]", "link", (el) => {
    const href = (el.getAttribute("href") ?? "").trim();
    return filled(el) && SCHEME.test(href) && (el.textContent ?? "").trim() !== href;
  });
  has("code", "inline-code", (el) => filled(el) && !el.closest("pre"));
  has("x-math", "math", () => true);
  has("del, s, strike", "strike");
  has("x-task", "task", () => true);
  return kinds;
}

/* ---- the HTML made ready for turndown ---- */

const KNOWN_LANGS = new Set(
  ("bash sh shell zsh fish powershell ps1 pwsh cmd bat batch dos console terminal text plaintext txt markdown md python py " +
    "javascript js typescript ts tsx jsx json jsonc json5 yaml yml toml ini xml html css scss sass less sql mysql postgresql " +
    "postgres psql plsql tsql sqlite c cpp c++ csharp cs c# java kotlin kt swift go golang rust rs ruby rb php perl r scala " +
    "dart lua haskell elixir erlang clojure fsharp f# vb vba vbnet dax mermaid latex tex diff dockerfile docker makefile make " +
    "nginx graphql http csv excel output objectivec objective-c groovy julia matlab")
    .split(" "),
);

function codeLanguage(pre: Element): string {
  const code = pre.querySelector("code");
  const lang =
    pre.getAttribute("data-lang") || classLang(code) || classLang(pre) || code?.getAttribute("data-language") || pre.getAttribute("data-language") || "";
  return /^[\w+#.-]{1,30}$/.test(lang) ? lang.toLowerCase() : "";
}

function classLang(el: Element | null): string {
  const m = /(?:^|\s)(?:language|lang)-([\w+#.-]+)/i.exec(el?.getAttribute("class") ?? "");
  return m ? m[1] : "";
}

function textOutside(root: Element, inner: Element): string {
  let s = "";
  walk(root, {
    enter: (el) => el !== inner,
    text: (t) => {
      s += t.nodeValue ?? "";
    },
  });
  return s;
}

const BLOCKY = "p, pre, table, ul, ol, h1, h2, h3, h4, h5, h6, blockquote";

const isLabel = (el: Element): boolean =>
  /^(?:DIV|SPAN)$/.test(el.nodeName) && LANG_LABEL.test((el.textContent ?? "").trim()) && !el.querySelector(BLOCKY);

const hasTextBefore = (node: Node): boolean => {
  for (let n = node.previousSibling; n; n = n.previousSibling) if (n.nodeType === 3 && n.nodeValue?.trim()) return true;
  return false;
};

// The bar a chat app draws over a code block, its language in it (its Copy
// button already gone): what comes right before the <pre>, or before the
// wrapper it sits in, a few levels up. `depth` > 0: found from a wrapper.
function headerBefore(pre: Element, body: Element): { el: Element; depth: number } | null {
  let node: Element = pre;
  for (let depth = 0; depth < 4; depth++) {
    let prev = node.previousElementSibling;
    while (prev && !prev.textContent?.trim()) prev = prev.previousElementSibling;
    if (prev) return isLabel(prev) ? { el: prev, depth } : null;
    if (hasTextBefore(node)) return null;
    const up = node.parentElement;
    if (!up || up === body || /^(?:LI|TD|TH|BLOCKQUOTE|DETAILS|SECTION|ARTICLE|MAIN|BODY)$/.test(up.nodeName)) return null;
    node = up;
  }
  return null;
}

// a code block's language from its header bar, and the bar out of the way,
// so that "python" and "Copy" never stick to the code
function codeHeader(pre: Element, body: Element): void {
  const own = codeLanguage(pre);
  const codes = pre.querySelectorAll("code");
  if (!own && codes.length === 1) {
    const label = textOutside(pre, codes[0]).trim();
    if (LANG_LABEL.test(label)) {
      pre.setAttribute("data-lang", label.toLowerCase());
      return;
    }
  }
  const h = headerBefore(pre, body);
  if (!h) return;
  const label = (h.el.textContent ?? "").trim().toLowerCase();
  const fits = own ? label === own || KNOWN_LANGS.has(label) || h.depth > 0 : h.depth > 0 || KNOWN_LANGS.has(label);
  if (!fits) return;
  if (!own) pre.setAttribute("data-lang", label);
  h.el.remove();
}

// Leggimi's own copy (share.ts wordifyTaskLists): "☐  text" paragraphs, a
// task list again
function taskParagraphs(doc: Document, body: HTMLElement): void {
  let list: HTMLElement | null = null;
  for (const p of [...body.querySelectorAll("p")]) {
    const first = p.firstChild;
    const m = first?.nodeType === 3 ? /^[\s\u00a0]*([☐☑☒])[\s\u00a0]+/.exec(first.nodeValue ?? "") : null;
    if (!m || !first) continue;
    first.nodeValue = (first.nodeValue ?? "").slice(m[0].length);
    if (!list || p.previousElementSibling !== list) {
      list = doc.createElement("ul");
      p.before(list);
    }
    const li = doc.createElement("li");
    const box = doc.createElement("x-task");
    if (m[1] !== "☐") box.setAttribute("data-checked", "");
    box.textContent = "☐";
    li.append(box, doc.createTextNode(" "), ...p.childNodes);
    list.append(li);
    p.remove();
  }
}

// Leggimi's own copy of a GitHub alert (share.ts wordifyAlerts): a box with a
// coloured left border, its title opened by a sign
const ALERT_SIGNS: [string, string][] = [
  ["ℹ", "NOTE"],
  ["💡", "TIP"],
  ["❗", "IMPORTANT"],
  ["⚠", "WARNING"],
  ["⛔", "CAUTION"],
];

function alerts(doc: Document, body: HTMLElement): void {
  for (const div of [...body.querySelectorAll("div")]) {
    if (!/border-left/i.test(div.getAttribute("style") ?? "")) continue;
    const title = div.firstElementChild;
    if (!title || !/^(?:P|DIV)$/.test(title.nodeName)) continue;
    const sign = ALERT_SIGNS.find(([s]) => (title.textContent ?? "").trim().startsWith(s));
    if (!sign) continue;
    title.remove();
    const mark = doc.createElement("x-raw");
    mark.setAttribute("data-md", `[!${sign[1]}]\n`);
    mark.textContent = "!";
    let first = div.firstElementChild;
    if (!first || first.nodeName !== "P") {
      first = doc.createElement("p");
      div.prepend(first);
    }
    first.prepend(mark);
    const quote = doc.createElement("blockquote");
    quote.append(...div.childNodes);
    div.replaceWith(quote);
  }
}

// Word's lists are paragraphs (mso-list), their bullet or number in a span
// Word ignores: lists again, nested by their level
function wordLists(doc: Document, body: HTMLElement): void {
  const items = [...body.querySelectorAll("p")].filter(
    (p) => /mso-list\s*:\s*l\d+/i.test(p.getAttribute("style") ?? "") || /^MsoListParagraph/i.test(p.className),
  );
  let stack: { level: number; list: HTMLElement }[] = [];
  for (const p of items) {
    if (!stack.length || p.previousElementSibling !== stack[0].list) stack = [];
    const level = Number(/level(\d+)/i.exec(p.getAttribute("style") ?? "")?.[1] ?? "1");
    const ignore = p.querySelector('span[style*="mso-list" i]');
    const marker = (ignore?.textContent ?? "").replace(/[\s\u00a0]+/g, "");
    ignore?.remove();
    const ordered = /^(?:\d+|[a-z]|[ivxlcdm]+)[.)]$/i.test(marker);
    while (stack.length && stack[stack.length - 1].level > level) stack.pop();
    let top = stack[stack.length - 1];
    if (!top || top.level < level) {
      const list = doc.createElement(ordered ? "ol" : "ul");
      if (top) (top.list.lastElementChild ?? top.list).append(list);
      else p.before(list);
      top = { level, list };
      stack.push(top);
    }
    const li = doc.createElement("li");
    li.append(...p.childNodes);
    top.list.append(li);
    p.remove();
  }
}

function prepare(doc: Document, body: HTMLElement): void {
  // the checkboxes of a task list (the other inputs are gone)
  for (const box of [...body.querySelectorAll("input")]) {
    const task = doc.createElement("x-task");
    if (box.hasAttribute("checked")) task.setAttribute("data-checked", "");
    task.textContent = "☐";
    box.replaceWith(task);
  }
  taskParagraphs(doc, body);
  alerts(doc, body);
  wordLists(doc, body);
  for (const pre of [...body.querySelectorAll("pre")]) codeHeader(pre, body);
}

/* ---- turndown, and the rules of its that GitHub's Markdown needs ---- */

let service: Promise<TurndownService> | null = null;

function turndown(): Promise<TurndownService> {
  service ??= import("turndown").then(({ default: Turndown }) => build(new Turndown({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    fence: "```",
    emDelimiter: "*",
    strongDelimiter: "**",
    br: "  ",
  }))).catch((err: unknown) => {
    service = null;
    throw err;
  });
  return service;
}

// Text as Markdown reads it: what would turn into markup is escaped, and only
// that ("snake_case", "2 * 3", "[1]]" stay as they are written)
function escapeText(s: string): string {
  const word = /[\p{L}\p{N}]/u;
  return s
    .replace(/\\(?=[!-/:-@[-`{-~]|$)/g, "\\\\")
    .replace(/\*/g, (m, i: number, t: string) => (/\s/.test(t[i - 1] ?? " ") && /\s/.test(t[i + 1] ?? " ") ? m : "\\*"))
    .replace(/_/g, (m, i: number, t: string) => (word.test(t[i - 1] ?? "") && word.test(t[i + 1] ?? "") ? m : "\\_"))
    .replace(/[`[\]]/g, "\\$&")
    .replace(/~~/g, "\\~\\~")
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/&(?=#?[A-Za-z0-9]{1,32};)/g, "\\&")
    .replace(/^([ \t]*)([-+*])(?=[ \t]|$|-)/, "$1\\$2")
    .replace(/^([ \t]*)(#{1,6})(?=[ \t]|$)/, "$1\\$2")
    .replace(/^([ \t]*)>/, "$1\\>")
    .replace(/^([ \t]*)(=+)/, "$1\\$2")
    .replace(/^([ \t]*)(\d{1,9})([.)])(?=[ \t]|$)/, "$1$2\\$3")
    .replace(/^([ \t]*)(~{3,})/, "$1\\$2");
}

const CELL_A = "\uE000";
const CELL_B = "\uE001";
const ROW_A = "\uE002";
const ROW_B = "\uE003";
const CAP_A = "\uE004";
const CAP_B = "\uE005";

// "#id" of a heading the copy holds (Leggimi's own copy keeps them): the
// pasted text makes the same heading, so the link still goes there; a page's
// "#cite_note-1" goes nowhere in it
function toHeading(node: HTMLElement, href: string): boolean {
  if (!/^#./.test(href)) return false;
  let id = href.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    /* as written */
  }
  return /^H[1-6]$/.test(node.ownerDocument.getElementById(id)?.nodeName ?? "");
}

const is =
  (...names: string[]) =>
  (node: HTMLElement): boolean =>
    names.includes(node.nodeName);

function tableMarkdown(content: string, node: HTMLElement): string {
  const caption = [...content.matchAll(/\uE004([\s\S]*?)\uE005/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .join(" ");
  const rows = [...content.matchAll(/\uE002([\s\S]*?)\uE003/g)].map((m) => [...m[1].matchAll(/\uE000([\s\S]*?)\uE001/g)].map((c) => c[1]));
  const layout =
    node.getAttribute("role") === "presentation" || !!node.querySelector("table") || (rows.every((r) => r.length <= 1) && !node.querySelector("th"));
  if (!rows.length || layout) {
    const blocks = rows.length ? rows.flat().map((c) => c.trim()) : [content.replace(/[\uE000-\uE005]/g, "").trim()];
    return `\n\n${[caption, ...blocks].filter(Boolean).join("\n\n")}\n\n`;
  }
  const width = Math.max(...rows.map((r) => r.length));
  const cell = (c: string): string =>
    c
      .trim()
      .replace(/[ \t]*\n[\s]*/g, "<br>")
      .replace(/\|/g, "\\|");
  const line = (cells: string[]): string => `| ${Array.from({ length: width }, (_, i) => cell(cells[i] ?? "")).join(" | ")} |`;
  const out = [line(rows[0]), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...rows.slice(1).map(line)];
  return `\n\n${caption ? `${caption}\n\n` : ""}${out.join("\n")}\n\n`;
}

function build(td: TurndownService): TurndownService {
  td.escape = escapeText;

  td.addRule("math", {
    filter: is("X-MATH"),
    replacement: (_content, node) => {
      const tex = node.getAttribute("data-tex") ?? "";
      if (!tex.trim()) return "";
      if (node.hasAttribute("data-display") && !node.closest("td, th, h1, h2, h3, h4, h5, h6, a")) {
        const lines = tex
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        return `\n\n$$\n${lines.join("\n")}\n$$\n\n`;
      }
      const t = tex.replace(/\s+/g, " ").trim();
      const next = node.nextSibling?.textContent?.[0] ?? "";
      return /\w/.test(next) && !t.includes("`") ? `$\`${t}\`$` : `$${t}$`;
    },
  });
  td.addRule("task", {
    filter: is("X-TASK"),
    replacement: (_content, node) => {
      const done = node.hasAttribute("data-checked");
      return node.closest("li") ? (done ? "[x] " : "[ ] ") : done ? "☑ " : "☐ ";
    },
  });
  td.addRule("raw", { filter: is("X-RAW"), replacement: (_content, node) => node.getAttribute("data-md") ?? "" });

  td.addRule("codeBlock", {
    filter: is("PRE"),
    replacement: (_content, node) => {
      const codes = node.querySelectorAll("code");
      const text = preText(codes.length === 1 ? codes[0] : node)
        .replace(/^\n+/, "")
        .replace(/\s+$/, "");
      if (!text) return "";
      const runs = text.match(/^[ \t]*`{3,}/gm) ?? [];
      const longest = Math.max(2, ...runs.map((r) => r.trim().length));
      const fence = "`".repeat(longest + 1);
      return `\n\n${fence}${codeLanguage(node)}\n${text}\n${fence}\n\n`;
    },
  });

  td.addRule("tableCell", {
    filter: ["th", "td"],
    replacement: (content, node) => {
      const span = Math.min(20, Math.max(1, Number(node.getAttribute("colspan")) || 1));
      return CELL_A + content + CELL_B + (CELL_A + CELL_B).repeat(span - 1);
    },
  });
  td.addRule("tableRow", { filter: "tr", replacement: (content) => ROW_A + content + ROW_B });
  td.addRule("tableSection", { filter: ["thead", "tbody", "tfoot"], replacement: (content) => content });
  td.addRule("tableCaption", { filter: "caption", replacement: (content) => CAP_A + content + CAP_B });
  td.addRule("table", { filter: "table", replacement: (content, node) => tableMarkdown(content, node) });

  td.addRule("listItem", {
    filter: "li",
    replacement: (content, node) => {
      const parent = node.parentNode as HTMLElement | null;
      let prefix = "- ";
      if (parent?.nodeName === "OL") {
        const start = Number(parent.getAttribute("start") ?? "1");
        const index = Array.prototype.indexOf.call(parent.children, node) as number;
        prefix = `${(Number.isFinite(start) ? start : 1) + Math.max(0, index)}. `;
      }
      // an item of one paragraph (ChatGPT's and Google Docs' <li><p>) keeps the list tight
      const paras = [...node.children].filter((c) => BLOCKS.has(c.nodeName) && !/^(?:UL|OL)$/.test(c.nodeName)).length;
      const loose = paras > 1 && /\n$/.test(content);
      let text = content.replace(/^\n+/, "").replace(/\n+$/, "");
      if (!loose) text = text.replace(/\n{2,}(?=(?:[-*+]|\d{1,9}[.)])[ \t])/g, "\n");
      text = `${text}${loose ? "\n" : ""}`.replace(/^\[([ x])\] +/, "[$1] ").replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
      return prefix + text + (node.nextSibling ? "\n" : "");
    },
  });

  td.addRule("heading", {
    filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
    replacement: (content, node) => {
      const text = content.replace(/\s*\n+\s*/g, " ").trim();
      return text ? `\n\n${"#".repeat(Number(node.nodeName[1]))} ${text}\n\n` : "";
    },
  });

  // links to the web and to a heading; a page's own relative links mean
  // nothing in text that has no folder: their text stays
  td.addRule("link", {
    filter: "a",
    replacement: (content, node) => {
      const href = (node.getAttribute("href") ?? "").trim();
      if (!content.trim()) return "";
      if (!(SCHEME.test(href) || toHeading(node, href)) || content.includes("\n")) return content;
      if ((node.textContent ?? "").trim() === href && !/[\s<>]/.test(href)) return `<${href}>`;
      const dest = /[\s()<>]/.test(href) ? `<${href.replace(/[<>]/g, encodeURIComponent)}>` : href;
      return `[${content}](${dest})`;
    },
  });
  // a pasted text has no folder, and the app shows no picture from the web: the picture's words
  td.addRule("image", {
    filter: "img",
    replacement: (_content, node) => escapeText((node.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim()),
  });

  td.addRule("strike", {
    filter: is("DEL", "S", "STRIKE"),
    replacement: (content) => (content.trim() ? `~~${content}~~` : content),
  });
  td.addRule("mark", { filter: "mark", replacement: (content) => (content.trim() ? `==${content}==` : content) });
  td.addRule("inlineHtml", {
    filter: is("SUP", "SUB", "KBD"),
    replacement: (content, node) => {
      if (!content.trim() || content.includes("\n") || node.querySelector("a")) return content;
      const tag = node.nodeName.toLowerCase();
      return `<${tag}>${content}</${tag}>`;
    },
  });
  td.addRule("unstyled", { filter: (node) => unstyled(node), replacement: (content) => content });
  td.addRule("styledSpan", {
    filter: (node) => node.nodeName === "SPAN" && spanMarks(node) !== "",
    replacement: (content, node) => {
      if (!content.trim() || content.includes("\n")) return content;
      const marks = spanMarks(node);
      return marks + content + [...marks.matchAll(/\*\*|\*|~~/g)].map((m) => m[0]).reverse().join("");
    },
  });
  return td;
}

// blank lines at most one at a time, no spaces at line ends but a hard
// break's, outside code; one line end at the end
function tidy(md: string): string {
  const lines = md.split("\n");
  const code = codeMask(lines);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (!code[i]) {
      if (!line.trim()) line = "";
      else line = line.replace(/[ \t]+$/, (m) => (m.length >= 2 && lines[i + 1]?.trim() && !code[i + 1] ? "  " : ""));
      if (!line && (!out.length || (!out[out.length - 1] && !code[i - 1]))) continue;
    }
    out.push(line);
  }
  const text = out.join("\n").replace(/\s+$/, "");
  return text ? `${text}\n` : "";
}
