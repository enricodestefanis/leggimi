// What a tab can show: a file read from disk (ipc.MarkdownDoc), or text
// pasted from the clipboard that is in no file yet (PastedDoc). A pasted
// document has no path and no folder: nothing is read, watched or written for
// it until it is saved as a file. It is named after its own text.

import type { MarkdownDoc } from "./ipc";

/** Text pasted from the clipboard, as its tab keeps it. */
export interface Pasted {
  /** unique, and kept across windows and reloads: its draft, Ctrl+Shift+T */
  id: string;
  /** the text as it was pasted, with "\n" line ends: "changed" means different from it */
  original: string;
  /** from its first heading or line (pastedTitle), following the text until it is saved; "" when it has none */
  title: string;
  /** the folder the file pane showed when it was pasted, where "Save as…" starts; null: none */
  home: string | null;
}

/** Pasted text on screen: a MarkdownDoc's shape, with no file behind it. */
export interface PastedDoc {
  path: null;
  dir: null;
  /** the text being read, with "\n" line ends */
  content: string;
  modified: 0;
  paste: Pasted;
}

export type Doc = MarkdownDoc | PastedDoc;

const PASTED = "pasted:";

/** What the drafts and the Back list know pasted text by. */
export const pastedKey = (p: Pasted): string => `${PASTED}${p.id}`;

/** A document's key: its file's path, or `pasted:<id>`. */
export const docKey = (d: Doc): string => (d.path !== null ? d.path : pastedKey(d.paste));

/** A key of docKey's that names pasted text (a file's path starts with a drive or \\, never so). */
export const isPastedKey = (key: string): boolean => key.startsWith(PASTED);

/** The id in a key of pastedKey's. */
export const pastedIdOf = (key: string): string => key.slice(PASTED.length);

/** A new paste's id: its time, then a little randomness (two windows pasting in the same millisecond). */
export const newPasteId = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/** Pasted text on screen, reading `content`. */
export const pastedDoc = (paste: Pasted, content: string): PastedDoc => ({ path: null, dir: null, content, modified: 0, paste });

/**
 * Text from the clipboard as a document holds it: "\n" line ends (Windows
 * copies "\r\n"), without a byte-order mark or the NUL some programs leave
 * at the end.
 */
export const pastedText = (raw: string): string => raw.replace(/^﻿/, "").replace(/\u0000+$/, "").replace(/\r\n?/g, "\n");

/* ---- what pasted text is called ---- */

const MAX_TITLE = 80;
const MAX_NAME = 80;
// how much of a line is read for a title of 80 characters: a whole minified
// file pasted as one line must not make some patterns take seconds
const LINE_MAX = 2000;
const head = (s: string): string => (s.length > LINE_MAX ? s.slice(0, LINE_MAX) : s);

/**
 * The title of pasted text: its first level-1 heading ("# Title", or a line
 * underlined with ===), else its first line with text, as the reader sees it
 * (no Markdown), at most 80 characters. Code blocks and a leading front matter
 * hold no heading. "" when there is no text at all.
 */
export function pastedTitle(text: string): string {
  const lines = text.replace(/^﻿/, "").split(/\r\n?|\n/);
  let fence: { ch: string; len: number } | null = null;
  let comment = false;
  // the paragraph going on, which a line of === under it makes a heading
  let para: string[] | null = null;
  // inside a list item, a quote or an HTML block: a line there is no paragraph of its own
  let nested = false;
  // the paragraph going on opened with a terminal table's border (┌───┬───┐, +----+)
  let boxed = false;
  // the first line with text, for a text with no heading (read once it is needed)
  let first = "";
  const candidate = (text: () => string): void => {
    if (!first) first = drawn(text());
  };
  for (let i = frontMatterEnd(lines); i < lines.length; i++) {
    const line = head(lines[i]);
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      // code: its text as written
      else candidate(() => line.trim());
      continue;
    }
    if (comment) {
      if (lines[i].includes("-->")) comment = false;
      continue;
    }
    if (!line.trim()) {
      para = null;
      nested = false;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // a backtick fence's info string has no backticks (```js`x` is inline code)
    if (open && !(open[1][0] === "`" && open[2].includes("`"))) {
      fence = { ch: open[1][0], len: open[1].length };
      para = null;
      continue;
    }
    const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (atx) {
      const level1 = atx[1].length === 1;
      // a level-1 heading is read whole; another one only while there is no first line yet
      const title = level1 || !first ? (/^#*$/.test(atx[2] ?? "") ? "" : inline(atx[2] ?? "")) : "";
      if (level1 && title) return finish(title);
      candidate(() => title);
      para = null;
      nested = false;
      continue;
    }
    if (para && !nested && /^ {0,3}=+[ \t]*$/.test(line)) {
      const title = inline(head(para.join(" ")));
      if (title) return finish(title);
      para = null;
      continue;
    }
    // a level-2 underline, or a rule: no title in either
    if ((para && !nested && /^ {0,3}-+[ \t]*$/.test(line)) || /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line)) {
      para = null;
      nested = false;
      continue;
    }
    if (!para && /^ {0,3}<!--/.test(line)) {
      comment = !lines[i].includes("-->");
      continue;
    }
    if (/^ {0,3}>/.test(line) || /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/.test(line) || (!para && /^ {0,3}<[A-Za-z/?!]/.test(line))) {
      candidate(() => clean(line));
      para = null;
      nested = true;
      continue;
    }
    if (para) {
      para.push(line);
      // a terminal table: its border opened the paragraph, its first row with text names it
      if (boxed) candidate(() => clean(line));
      continue;
    }
    // an indented code block: its text as written
    if (!nested && /^(?: {4}|\t)/.test(line)) {
      candidate(() => line.trim());
      continue;
    }
    // a link's definition shows nothing
    if (/^ {0,3}\[[^\]]+\]:/.test(line)) continue;
    if (!nested) {
      para = [line];
      boxed = !drawn(line.trim());
    }
    candidate(() => clean(line));
  }
  return finish(first);
}

// A leading front matter as the renderer reads it (markdown-it-front-matter):
// "---" at the very start, up to a line of as many dashes or "..."; unclosed,
// it runs to the end. The index of the first line after it.
function frontMatterEnd(lines: string[]): number {
  const open = /^-{3,}/.exec(lines[0] ?? "");
  if (!open) return 0;
  for (let i = 1; i < lines.length; i++) {
    const close = /^ {0,3}(-{3,})[ \t]*$/.exec(lines[i]);
    if ((close && close[1].length >= open[0].length) || /^[ \t]*\.\.\.$/.test(lines[i])) return i + 1;
  }
  return lines.length;
}

function closesFence(line: string, fence: { ch: string; len: number }): boolean {
  const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return !!m && m[1][0] === fence.ch && m[1].length >= fence.len;
}

// A line as its text reads: the markers that open it go (Claude Code's ⏺
// before a message, quotes, list items, task boxes, a heading's #s, a table's
// outer pipes or a terminal table's outer lines), then the inline Markdown.
function clean(line: string): string {
  const s = line
    .replace(/^[ \t]*⏺[ \t]*/, "")
    .replace(/^(?:[ \t]*>)+/, "")
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/, "")
    .replace(/^[ \t]*\[[ xX]\](?:[ \t]+|$)/, "")
    .replace(/^[ \t]*#{1,6}(?:[ \t]+|$)/, "")
    .replace(/[ \t]+#+[ \t]*$/, "")
    .replace(/^[ \t]*[|│┃║]/, "")
    .replace(/[|│┃║][ \t]*$/, "");
  // a line of markup only (a table's ----|----, a lone "===", a terminal
  // table's ┌───┬───┐): no text
  return /^[\s|:=\-*_#>+~`.\u2500-\u257F]*$/.test(s) ? "" : inline(s);
}

// A line a terminal draws a table's border with (┌───┬───┐, +----+----+): no
// title, even in code
function drawn(text: string): string {
  return /^[\s\u2500-\u257F]+$/.test(text) || /^\s*\+[-=+:]*[-=][-=+:]*\+\s*$/.test(text) ? "" : text;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  copy: "©",
  reg: "®",
  trade: "™",
  euro: "€",
};

// The inline Markdown of a line as the reader sees it: code spans and
// backslash escapes keep what they hold, links and images their text, HTML
// tags and the marks of emphasis go.
function inline(s: string): string {
  const kept: string[] = [];
  const keep = (x: string): string => `${kept.push(x) - 1}`;
  let t = s
    .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, code: string) =>
      keep(/^ .* $/.test(code) ? code.slice(1, -1) : code),
    )
    .replace(/\\([!-/:-@[-`{-~])/g, (_m, ch: string) => keep(ch))
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<((?:https?|ftp|mailto):[^\s<>]+|[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/gi, (_m, url: string) => keep(url))
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, "")
    // footnote references, then images (alt text) and links (their text)
    .replace(/\[\^[^\]\s]+\]/g, "")
    .replace(/!\[([^\]]*)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g, "$1")
    .replace(/\[([^\]]*)\](?:\((?:[^()]|\([^()]*\))*\)|\[[^\]]*\])/g, "$1");
  // emphasis in pairs, as Markdown reads it: a lone * or a snake_case name stays
  for (let pass = 0; pass < 4; pass++) {
    const before = t;
    t = t
      .replace(/(\*{1,3})(?=\S)(.*?\S)\1(?!\*)/g, "$2")
      .replace(/(^|[^\p{L}\p{N}_])(_{1,3})(?=\S)(.*?\S)\2(?![\p{L}\p{N}_])/gu, "$1$3")
      .replace(/~~(?=\S)(.*?\S)~~/g, "$1");
    if (t === before) break;
  }
  t = t
    .replace(/`/g, "")
    .replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m;
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : m;
    });
  return t.replace(/(\d+)/g, (_m, i: string) => kept[Number(i)] ?? "").replace(/\s+/g, " ").trim();
}

// One line, at most 80 characters: cut at a word's end when one is near, "…" after
function finish(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  const g = graphemes(one);
  if (g.length <= MAX_TITLE) return one;
  let cut = g.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(" ");
  if (space >= MAX_TITLE - 21) cut = cut.slice(0, space);
  return `${cut.join("").replace(/[\s,;:.\-–—]+$/, "")}…`;
}

// Intl.Segmenter is newer than the library the code is typed against (WebView2 and Node have it)
type Segmenter = new (locale?: string, o?: { granularity: "grapheme" }) => { segment(s: string): Iterable<{ segment: string }> };

// The characters a reader counts: an emoji with its modifiers, a letter with
// its accents, are one (a cut never splits them)
function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: Segmenter }).Segmenter;
  return Seg ? Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment) : Array.from(s);
}

// Windows' device names: a file named so, with any extension, is the device
const DEVICE = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;

/**
 * A title as a Windows file name (without its extension): no character
 * Windows refuses, no dot or space at the end (Windows drops them), at most
 * 80 characters, never a device name (CON, NUL, COM1… get a "_"). "" when
 * nothing is left: the caller has its own name for it.
 */
export function fileSafeName(title: string): string {
  const tidy = (s: string): string => s.replace(/[. ]+$/, "");
  let name = tidy(
    title
      .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  const g = graphemes(name);
  if (g.length > MAX_NAME) g.length = MAX_NAME;
  // a name has room for 255 UTF-16 units: whole characters only, the extension's room kept
  while (g.join("").length > 200) g.pop();
  name = tidy(g.join(""));
  const dot = name.indexOf(".");
  const base = (dot < 0 ? name : name.slice(0, dot)).replace(/ +$/, "");
  return DEVICE.test(base) ? `${base}_${name.slice(base.length)}` : name;
}
