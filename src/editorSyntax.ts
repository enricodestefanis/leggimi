// What the editor's Markdown parser knows beyond GFM, and the colours it
// paints with (2.4, the "structured" look). The parser follows the preview
// (renderer.ts): ==highlight== as markdown-it-mark, $ and $$ math as
// mathAsOnGitHub, [[wikilinks]] as wikilinkRule, front matter as
// markdown-it-front-matter, so the source is coloured the way the page will
// read it. Every line keeps the same height: no colour here changes a size.

import { HighlightStyle } from "@codemirror/language";
import { yamlLanguage } from "@codemirror/lang-yaml";
import { parseMixed } from "@lezer/common";
import { Tag, styleTags, tags as t } from "@lezer/highlight";
import type { BlockContext, InlineContext, Line, MarkdownConfig } from "@lezer/markdown";

/** Tags of the editor's own: nodes the stock Markdown tags share with code (TaskMarker is `atom`). */
export const mdTags = {
  taskMarker: Tag.define(),
  linkTitle: Tag.define(),
  inlineCode: Tag.define(),
  listMark: Tag.define(),
  highlight: Tag.define(),
  math: Tag.define(),
  wikiLink: Tag.define(),
  calloutMark: Tag.define(),
};

const PUNCT = /[\p{S}\p{P}]/u;
const isSpace = (s: string): boolean => /\s|^$/.test(s);

// ==highlight==: delimiters as GFM's ~~, with the preview's limits (a third
// "=" or one just before makes it plain text: "a === b", "x==y" are not marks)
const HighlightDelim = { resolve: "Highlight", mark: "HighlightMark" };
function parseHighlight(cx: InlineContext, next: number, pos: number): number {
  if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 || cx.char(pos + 2) === 61 || cx.char(pos - 1) === 61) return -1;
  const before = cx.slice(pos - 1, pos);
  const after = cx.slice(pos + 2, pos + 3);
  const sBefore = isSpace(before);
  const sAfter = isSpace(after);
  const pBefore = PUNCT.test(before);
  const pAfter = PUNCT.test(after);
  return cx.addDelimiter(
    HighlightDelim,
    pos,
    pos + 2,
    !sAfter && (!pAfter || sBefore || pBefore),
    !sBefore && (!pBefore || sAfter || pAfter),
  );
}

// ---- $ and $$, as the preview reads them (renderer.ts: inlineDisplayMath, closingDollar)

const isWordChar = (c: string): boolean => /\w/.test(c);

/** The first "$$" in [from, to) not escaped by a "\": its position, or -1. */
function dollarsIn(cx: InlineContext, from: number, to: number): number {
  const text = cx.slice(from, to);
  for (let i = text.indexOf("$$"); i >= 0; i = text.indexOf("$$", i + 1)) {
    let slashes = 0;
    while (text[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) return from + i;
  }
  return -1;
}

function mathElement(cx: InlineContext, from: number, to: number, mark: number): number {
  return cx.addElement(cx.elt("InlineMath", from, to, [cx.elt("MathMark", from, from + mark), cx.elt("MathMark", to - mark, to)]));
}

function parseMath(cx: InlineContext, next: number, pos: number): number {
  if (next !== 36 /* $ */) return -1;
  const prev = cx.slice(pos - 1, pos);
  if (cx.char(pos + 1) === 36) {
    // $$…$$ within the text: no space or tab just inside on its line
    let close = prev === "$" || prev === "\\" || cx.char(pos + 2) === 36 ? -1 : dollarsIn(cx, pos + 2, cx.end);
    if (close >= 0) {
      const math = cx.slice(pos + 2, close);
      if (cx.char(close + 2) === 36 || !math.trim() || /^[ \t]+\S/.test(math) || /\S[ \t]+$/.test(math)) close = -1;
    }
    // not math: both dollars are text, so the second opens nothing
    return close < 0 ? pos + 2 : mathElement(cx, pos, close + 2, 2);
  }
  // $…$: a dollar after a letter or digit, or before a space, is money
  const following = cx.slice(pos + 1, pos + 2);
  if (prev === "$" || prev === "\\" || isWordChar(prev) || !following || /\s/.test(following)) return -1;
  if (following === "`") {
    // $`…`$, GitHub's form for math holding Markdown's own characters
    const end = cx.slice(pos + 3, cx.end).indexOf("`$");
    if (end >= 0) return mathElement(cx, pos, pos + 3 + end + 2, 1);
  }
  const rest = cx.slice(pos + 1, cx.end);
  for (let i = rest.indexOf("$"); i >= 0; i = rest.indexOf("$", i + 1)) {
    let slashes = 0;
    while (rest[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2) continue;
    const end = pos + 1 + i;
    const after = cx.slice(end + 1, end + 2);
    return end > pos + 1 && after !== "$" && !isWordChar(after) && !/\s/.test(cx.slice(end - 1, end))
      ? mathElement(cx, pos, end + 1, 1)
      : -1;
  }
  return -1;
}

// ---- [[wikilinks]] and ![[embeds]], as renderer.ts wikilinkRule

function parseWikiLink(cx: InlineContext, next: number, pos: number): number {
  const embed = next === 33; /* ! */
  const open = pos + (embed ? 1 : 0);
  if (cx.char(open) !== 91 || cx.char(open + 1) !== 91) return -1;
  const rel = cx.slice(open + 2, cx.end).indexOf("]]");
  if (rel < 0) return -1;
  const close = open + 2 + rel;
  const inner = cx.slice(open + 2, close);
  if (!inner.trim() || /[[\]\r\n]/.test(inner)) return -1;
  const after = cx.char(close + 2);
  if (after === 40 /* ( */ || after === 93 /* ] */) return -1;
  if (!embed && cx.char(open - 1) === 91) return -1;
  if (!embed && /^\s*toc\s*$/i.test(inner)) return -1;
  return cx.addElement(
    cx.elt("WikiLink", pos, close + 2, [cx.elt("WikiMark", pos, open + 2), cx.elt("WikiMark", close, close + 2)]),
  );
}

// ---- > [!NOTE] / > [!tip]- Title: the callout's marker, at the start of a paragraph

function parseCalloutMark(cx: InlineContext, next: number, pos: number): number {
  if (next !== 91 || pos !== cx.offset) return -1;
  const m = /^\[![A-Za-z][\w-]*\][+-]?/.exec(cx.slice(pos, Math.min(cx.end, pos + 64)));
  return m ? cx.addElement(cx.elt("CalloutMark", pos, pos + m[0].length)) : -1;
}

// ---- front matter: "---" on the very first line, as markdown-it-front-matter 0.2.4
// reads it: three dashes or more (anything may follow them), closed by a line of
// at least as many dashes and nothing but spaces after, or by the line after a
// "..."; unclosed, it runs to the end of the document, as in the preview.

function parseFrontmatter(cx: BlockContext, line: Line): boolean {
  if (cx.lineStart !== 0 || line.text.charCodeAt(0) !== 45 /* - */) return false;
  const open = /^-+/.exec(line.text)![0].length;
  if (open < 3) return false;
  const from = 0;
  const marks = [cx.elt("FrontmatterMark", from, open)];
  const contentFrom = line.text.length + 1;
  let end = line.text.length;
  let contentEnd = end;
  let prev = "";
  const closing = new RegExp(`^ {0,3}-{${open},}[ \\t]*$`);
  for (;;) {
    // a "..." line ends it too (YAML's end of document), itself inside
    if (prev === "...") {
      cx.nextLine();
      break;
    }
    if (!cx.nextLine()) break;
    const at = cx.lineStart;
    if (closing.test(line.text)) {
      contentEnd = Math.max(contentFrom, at - 1);
      end = at + line.text.length;
      const dash = line.text.indexOf("-");
      marks.push(cx.elt("FrontmatterMark", at + dash, at + line.text.trimEnd().length));
      cx.nextLine();
      break;
    }
    end = contentEnd = at + line.text.length;
    prev = line.text;
  }
  const children = [marks[0]];
  if (contentEnd > contentFrom) children.push(cx.elt("FrontmatterContent", contentFrom, contentEnd));
  if (marks[1]) children.push(marks[1]);
  cx.addElement(cx.elt("Frontmatter", from, end, children));
  return true;
}

/** The Markdown parser's extensions: what the preview reads and stock GFM does not. */
export const mdExtensions: MarkdownConfig[] = [
  {
    // the preview has none of these: H~2~O, 10:30:45 (":30:") and ^2^ read as text there
    remove: ["Subscript", "Superscript", "Emoji"],
    defineNodes: [
      { name: "Highlight", style: { "Highlight/...": mdTags.highlight } },
      { name: "HighlightMark", style: t.processingInstruction },
      { name: "InlineMath", style: { "InlineMath/...": mdTags.math } },
      { name: "MathMark", style: t.processingInstruction },
      { name: "WikiLink", style: { "WikiLink/...": mdTags.wikiLink } },
      { name: "WikiMark", style: t.processingInstruction },
      { name: "CalloutMark", style: mdTags.calloutMark },
      // no style of its own: an inherited one would cover the YAML's colours inside
      { name: "Frontmatter", block: true },
      { name: "FrontmatterMark", style: t.processingInstruction },
      { name: "FrontmatterContent" },
    ],
    parseInline: [
      { name: "Highlight", parse: parseHighlight, after: "Emphasis" },
      // before the Escape parser has a say only for "$": "\$" stays the escape's
      { name: "InlineMath", parse: parseMath, after: "Escape" },
      // before Link, which reads [[x]] as a link in brackets, and before Image ("!")
      { name: "WikiLink", parse: parseWikiLink, before: "Link" },
      { name: "CalloutMark", parse: parseCalloutMark, before: "WikiLink" },
    ],
    parseBlock: [{ name: "Frontmatter", parse: parseFrontmatter, before: "HorizontalRule" }],
    // the YAML inside the front matter in YAML's colours
    wrap: parseMixed((node) => (node.name === "FrontmatterContent" ? { parser: yamlLanguage.parser } : null)),
  },
  {
    // the stock tags these nodes share with code: a later rule for a node replaces the earlier one.
    // InlineCode's own tag carries the chip; CodeText (a code block whose language is unknown or
    // not loaded yet) keeps `monospace`, which paints no background
    props: [
      styleTags({
        TaskMarker: mdTags.taskMarker,
        LinkTitle: mdTags.linkTitle,
        InlineCode: mdTags.inlineCode,
        ListMark: mdTags.listMark,
      }),
    ],
  },
];

// Colours from the app's CSS variables (base.css, code.css), so the editor
// follows the theme without being reconfigured. Markdown marks are muted
// text, which clears AA in every theme, on the line being edited too; the
// code inside fences takes the preview's colours (--syn-*).
export const highlightStyle = HighlightStyle.define([
  // ---- Markdown
  { tag: t.heading, fontWeight: "700", color: "var(--text)" },
  { tag: [t.heading1, t.heading2], fontWeight: "700", color: "var(--accent-text)" },
  { tag: t.strong, fontWeight: "650" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  {
    tag: [t.link, mdTags.wikiLink],
    color: "var(--accent-text)",
    textDecoration: "underline",
    textDecorationColor: "color-mix(in srgb, var(--accent-text) 40%, transparent)",
    textUnderlineOffset: "2px",
  },
  { tag: t.url, color: "var(--text-muted)", textDecoration: "none" },
  { tag: mdTags.inlineCode, backgroundColor: "var(--editor-chip)", borderRadius: "3px" },
  { tag: t.quote, color: "var(--text-muted)", fontStyle: "italic" },
  { tag: mdTags.listMark, color: "var(--accent-text)", fontWeight: "700" },
  { tag: mdTags.taskMarker, color: "var(--text-muted)" },
  { tag: mdTags.highlight, backgroundColor: "var(--editor-mark)", color: "var(--mark-text)", borderRadius: "2px" },
  { tag: mdTags.math, color: "var(--syn-title)" },
  { tag: mdTags.calloutMark, fontWeight: "700", fontStyle: "normal" },
  { tag: mdTags.linkTitle, color: "var(--syn-string)", textDecoration: "none" },
  { tag: t.labelName, color: "var(--accent-text)" },
  { tag: t.contentSeparator, color: "var(--text-muted)" },
  { tag: t.escape, color: "var(--text-muted)" },
  { tag: t.character, color: "var(--syn-constant)" },

  // ---- code (and HTML written in the Markdown)
  {
    tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier, t.self, t.typeName],
    color: "var(--syn-keyword)",
  },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.className, t.definition(t.typeName), t.macroName],
    color: "var(--syn-title)",
  },
  { tag: [t.standard(t.variableName), t.standard(t.name), t.special(t.name)], color: "var(--syn-builtin)" },
  {
    tag: [t.number, t.integer, t.float, t.bool, t.null, t.atom, t.unit, t.literal, t.color, t.constant(t.name), t.special(t.variableName), t.propertyName, t.attributeName],
    color: "var(--syn-constant)",
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.docString, t.attributeValue], color: "var(--syn-string)" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: "var(--syn-comment)" },
  { tag: t.tagName, color: "var(--syn-tag)" },
  { tag: [t.meta, t.annotation, t.angleBracket], color: "var(--text-muted)" },
  { tag: t.inserted, color: "var(--syn-add)" },
  { tag: t.deleted, color: "var(--syn-del)" },

  // ---- last, so it wins on the marks inside headings, links, emphasis: # ** ` [ ]( ) > - ==
  { tag: t.processingInstruction, color: "var(--text-muted)", textDecoration: "none", backgroundColor: "transparent" },
]);
