import MarkdownIt from "markdown-it";
import type { RenderRule } from "markdown-it/lib/renderer.mjs";
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import mark from "markdown-it-mark";
import footnote from "markdown-it-footnote";
import frontMatter from "markdown-it-front-matter";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";

import { findInFolder, resolvePath } from "./ipc";
import callouts from "./callouts";
import { dropAppProtocol, namesAppProtocol, reachable } from "./reach";
import { unmark as unmarkZoomable } from "./lightbox";
import * as fm from "./frontmatter";
import { t } from "./i18n";
import { tableToTsv } from "./tables";
import { collectMedia, restoreMedia } from "./media";

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

/* ---- heading ids ---- */

// GitHub's heading ids (github-slugger): lower case, punctuation and symbols
// dropped, each space a hyphen: "1. Introduzione" → "1-introduzione", "Q&A" →
// "qa", "Attività" → "attività". Tables of contents written for GitHub, or by
// AI assistants, link to these. A title with nothing left (only emoji or
// punctuation) keeps its old id. Also what [[Note#Heading]] points to.
export function headingSlug(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "").replace(/ /g, "-") || legacySlug(title);
}

// markdown-it-anchor's default slug, the ids up to 1.15.0: "1.-introduzione",
// "q%26a", "attivit%C3%A0"
function legacySlug(title: string): string {
  try {
    return encodeURIComponent(title.trim().toLowerCase().replace(/\s+/g, "-"));
  } catch {
    return ""; // a lone surrogate, on which those versions could not render at all
  }
}

// markdown-it-anchor's numbering of repeated slugs: "a", "a-1", "a-2"…
function uniqueSlug(slug: string, taken: Set<string>): string {
  let unique = slug;
  for (let i = 1; taken.has(unique); i++) unique = `${slug}-${i}`;
  taken.add(unique);
  return unique;
}

/* ---- the parser ---- */

const md: MarkdownIt = MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
  highlight: (code, lang) => {
    if (lang && lang !== "mermaid" && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
      } catch {
        /* fall back to plain escaping */
      }
    }
    return "";
  },
})
  .use(anchor, { tabIndex: false, slugify: headingSlug })
  // no <label> around the item's text: only the box toggles (and writes the
  // file), not a click in the text
  .use(taskLists, { enabled: true, label: false })
  // KaTeX joins on demand: see loadKatex
  // GitHub's alerts and the callouts of note-taking apps (callouts.ts)
  .use(callouts)
  // ==highlighted== text, as Obsidian and others write it: <mark>
  .use(mark)
  .use(footnote)
  // the plugin reports the YAML through a callback; md.render is synchronous,
  // so the value belongs to the render in flight
  .use(frontMatter, (yaml: string) => {
    pendingFrontMatter = yaml;
  });

// A heading whose id changed in 1.15.1 keeps the old one, numbered as it was
// then, in data-legacy-id: reading positions remembered and links written
// before still land (retargetLegacyLinks, findHeading in state.ts).
md.core.ruler.after("anchor", "legacy_heading_ids", (state) => {
  const taken = new Set<string>();
  state.tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    // the title as markdown-it-anchor reads it: text and inline code
    const title = (state.tokens[i + 1].children ?? [])
      .filter((c) => c.type === "text" || c.type === "code_inline")
      .map((c) => c.content)
      .join("");
    const legacy = uniqueSlug(legacySlug(title), taken);
    if (legacy && legacy !== token.attrGet("id")) token.attrSet("data-legacy-id", legacy);
  });
});

// Link only what is written as an address: with a scheme (https://…,
// mailto:…), an e-mail address, or from "www." as on GitHub. Bare domains
// stay text: "README.md" or "main.rs" in prose would otherwise become web
// links, .md and .rs being country domains.
md.linkify.set({ fuzzyLink: false });
md.linkify.add("www.", {
  validate: (text, pos, self) => {
    // the start of an address, not the middle of a path or of a longer host
    // name (C:\sites\www.example.com, dev-www.example.com)
    if (/[./\\@-]/.test(text.charAt(pos - 5))) return 0;
    // host and path as linkify-it's own http: rule reads them; its src_*
    // patterns are strings, and rebuilt (dropping this cache) when it recompiles
    const src = self.re as unknown as Record<string, string>;
    self.re.www ??= new RegExp(`^${src.src_host_port_strict}${src.src_path}`, "i");
    return self.re.www.exec(text.slice(pos))?.[0].length ?? 0;
  },
  normalize: (match) => {
    match.url = `http://${match.url}`;
  },
});

// The text stays as typed: no (c) → ©, (tm) → ™, -- → –, ... → … (a "--line"
// in prose is a flag, not a dash); quotes still curl.
md.disable("replacements");

/* ---- wikilinks: [[Note]] and ![[picture.png]] ---- */

// The links of Obsidian, Logseq, Foam and GitHub's wikis, read as ordinary links: [[Note]],
// [[Note|shown text]], [[Note#Heading]], [[#Heading]], [[Note#^block]], [[folder/Note]]. Each
// becomes <a class="wikilink" href="Note.md" data-wikilink="Note">: the href is the note
// beside the document; main.ts looks further in the folder when that is not there. There is
// no index of notes, so no link shows as broken. ![[picture.png|300]] shows the picture
// (rewriteLocalUrls looks for it in the folder's tree too); ![[Note]] and other files are a
// link (class "embed"), not the note's text.

const PICTURE_EXT_RE = /\.(?:png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
// a file's extension, as far as a name can tell: a letter, then letters or digits, after the
// last dot ("v2.3" and "2026.11.13" are names of notes, without one)
const EXT_RE = /\.[a-z][a-z0-9]{0,7}$/i;
const MD_EXT_RE = /\.(?:md|markdown|mdown|mkdn?|mkd|mdwn|mdtxt|mdtext)$/i;
// "https:", "mailto:", "C:": not the name of a note
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

// a name as a relative URL: "#" and "?" are part of a file's name, not a fragment or a query
const nameUrl = (name: string): string => encodeURI(name).replace(/[?#]/g, (c) => encodeURIComponent(c));

type Wikilink =
  | { kind: "link"; href: string; target: string; text: string }
  | { kind: "picture"; name: string; src: string; alt: string; width?: string; height?: string };

// What a [[…]] holds (`inner`, without its brackets), or null when it is no wikilink.
function readWikilink(inner: string, embed: boolean): Wikilink | null {
  // "\|", as a table cell needs it, is the alias's bar too
  const body = inner.replace(/\\\|/g, "|");
  const bar = body.indexOf("|");
  const ref = (bar < 0 ? body : body.slice(0, bar)).trim();
  const after = bar < 0 ? "" : body.slice(bar + 1);
  try {
    if (embed && PICTURE_EXT_RE.test(ref)) {
      // ![[picture.png|300]], |300x200, |the alt text
      let alt = ref;
      let width: string | undefined;
      let height: string | undefined;
      for (const part of bar < 0 ? [] : after.split("|").map((s) => s.trim())) {
        const size = /^(\d{1,5})(?:x(\d{1,5}))?$/.exec(part);
        if (size) [width, height] = [size[1], size[2]];
        else if (part) alt = part;
      }
      return { kind: "picture", name: ref, src: nameUrl(ref), alt, width, height };
    }
    const hash = ref.indexOf("#");
    const target = (hash < 0 ? ref : ref.slice(0, hash)).trim();
    const sections = hash < 0 ? [] : ref.slice(hash + 1).split("#").map((s) => s.trim()).filter(Boolean);
    if ((!target && sections.length === 0) || SCHEME_RE.test(target)) return null;
    const last = sections.length ? sections[sections.length - 1] : "";
    // a block (#^id) has no anchor here: the note itself
    const block = last.startsWith("^");
    const note = !target || MD_EXT_RE.test(target) || !EXT_RE.test(target);
    // a heading's id as the renderer makes it; another file's fragment as written (a PDF's #page=3)
    const fragment = !last || block ? "" : note ? `#${headingSlug(last)}` : `#${encodeURI(sections.join("#"))}`;
    const file = !target ? "" : EXT_RE.test(target) ? target : `${target}.md`;
    const href = file ? nameUrl(file) + fragment : fragment || "#";
    // "Note › Heading"; another file (a PDF's #page=3) by its name
    const shown = target ? [target, ...(block || !note ? [] : sections)] : sections;
    return { kind: "link", href, target, text: after.trim() || shown.join(" › ") };
  } catch {
    return null; // a lone surrogate: encodeURI cannot write it
  }
}

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const embed = src.charCodeAt(state.pos) === 0x21; /* ! */
  const open = state.pos + (embed ? 1 : 0);
  if (!src.startsWith("[[", open)) return false;
  const close = src.indexOf("]]", open + 2);
  if (close < 0 || close + 2 > state.posMax) return false;
  const inner = src.slice(open + 2, close);
  // nothing in it, or a bracket or a line break: not a wikilink
  if (!inner.trim() || /[[\]\r\n]/.test(inner)) return false;
  // [[1]](https://…) is a link whose text is in brackets; [[[x]]] is brackets (CommonMark)
  if (src.charCodeAt(close + 2) === 0x28 /* ( */ || src.charCodeAt(close + 2) === 0x5d /* ] */) return false;
  if (!embed && open > 0 && src.charCodeAt(open - 1) === 0x5b /* [ */) return false;
  // [[TOC]] is the table of contents (renderTocPlaceholders)
  if (!embed && /^\s*toc\s*$/i.test(inner)) return false;
  // [[label]] around a reference the document defines ([label]: /url) is that link in brackets
  const refs = (state.env as { references?: Record<string, unknown> } | undefined)?.references;
  if (refs && refs[state.md.utils.normalizeReference(inner)] !== undefined) return false;
  const link = readWikilink(inner, embed);
  // no link inside a link (<a href> written in HTML: markdown-it counts them in linkLevel,
  // which its types leave out)
  if (!link || (link.kind === "link" && ((state as { linkLevel?: number }).linkLevel ?? 0) > 0)) return false;
  if (!silent) {
    if (link.kind === "picture") {
      const img = state.push("image", "img", 0);
      img.attrs = [
        ["src", link.src],
        ["alt", ""],
      ];
      if (link.width) img.attrs.push(["width", link.width]);
      if (link.height) img.attrs.push(["height", link.height]);
      img.attrs.push(["data-embed", link.name]);
      const alt = new state.Token("text", "", 0);
      alt.content = link.alt;
      img.children = [alt];
      img.content = link.alt;
      img.markup = "![[";
    } else {
      const a = state.push("link_open", "a", 1);
      // the target from the source as written: the typographer only ever curls the text
      a.attrs = [
        ["class", embed ? "wikilink embed" : "wikilink"],
        ["href", link.href],
        ["data-wikilink", link.target],
      ];
      a.markup = embed ? "![[" : "[[";
      state.push("text", "", 0).content = link.text;
      state.push("link_close", "a", -1).markup = "]]";
    }
  }
  state.pos = close + 2;
  return true;
}

// before "link", which would read [[…]] as text in brackets; "!" first, before "image"
md.inline.ruler.before("link", "wikilink", wikilinkRule);

let pendingFrontMatter: string | null = null;

// Tag every rendered block with its source line for editor→preview scroll sync.
// Fence attrs land on the <code> element; blocks that drop attrs are stamped below.
// A heading's id is also kept aside in data-hid: see restoreHeadingIds.
md.core.ruler.push("source_line_map", (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1) {
      token.attrSet("data-source-line", String(token.map[0]));
    }
    if (token.type === "heading_open") {
      const id = token.attrGet("id");
      if (id) token.attrSet("data-hid", id);
    }
  }
});

// GitHub's "tagfilter" (GFM): these tags change how the HTML parser reads
// everything after them, so one named in prose ("the <title> tag") would
// swallow the rest of the document, and a <style> would restyle the app.
// As on GitHub they show as text. noscript too: DOMPurify drops it whole.
const TAGFILTER_RE = /<(?=\/?(?:title|textarea|style|xmp|iframe|noembed|noframes|script|plaintext|noscript)(?:[\s/>]|$))/gi;

md.core.ruler.push("tagfilter", (state) => {
  for (const token of state.tokens) {
    if (token.type === "html_block") {
      token.content = token.content.replace(TAGFILTER_RE, "&lt;");
    } else if (token.type === "inline") {
      for (const child of token.children ?? []) {
        if (child.type === "html_inline") child.content = child.content.replace(TAGFILTER_RE, "&lt;");
      }
    }
  }
});

// Some renderers write their own markup and ignore token attrs: KaTeX's
// display math ($$ blocks and ```math fences) and raw HTML blocks. Without an
// anchor, scroll sync can only guess where they sit in the preview, so stamp
// the line on their first tag. Each rule is wrapped once, and `stamped` keeps
// the renderer it wraps: KaTeX, added later, must wrap the plain fence
// renderer, not the stamped one.
const STAMPED_RULES = ["math_block", "fence", "html_block"];
const stamped = new Map<string, RenderRule>();

function stampSourceLines(): void {
  for (const rule of STAMPED_RULES) {
    const original = md.renderer.rules[rule];
    if (!original || stamped.has(rule)) continue;
    stamped.set(rule, original);
    md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
      const html = original(tokens, idx, options, env, self);
      const map = tokens[idx].map;
      if (!map || html.includes("data-source-line")) return html;
      return html.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-source-line="${map[0]}"`);
    };
  }
}

function unstampSourceLines(): void {
  for (const [rule, original] of stamped) md.renderer.rules[rule] = original;
  stamped.clear();
}

stampSourceLines();

/* ---- math, on demand ---- */

// KaTeX and its stylesheet (some 300 KB) load with the first document that
// may hold math, a "$" or a ```math fence, and then stay.
const mayHoldMath = (source: string): boolean => source.includes("$") || /(?:```|~~~)\s*math\b/i.test(source);

let katexLoad: Promise<void> | null = null;

function loadKatex(): Promise<void> {
  katexLoad ??= Promise.all([
    import("@vscode/markdown-it-katex"),
    // a plain string to TypeScript, which knows no .css modules (Vite does)
    import("katex/dist/katex.min.css" as string),
  ]).then(
    ([mod]) => {
      // CJS-only: not every loader unwraps its default
      const katex = ((mod.default as { default?: unknown }).default ?? mod.default) as typeof mod.default;
      // KaTeX wraps the fence renderer it finds (for ```math): it gets the
      // plain one, then every rule is stamped again, its math blocks included
      unstampSourceLines();
      try {
        md.use(katex, { enableFencedBlocks: true });
        mathAsOnGitHub(md);
      } finally {
        stampSourceLines();
      }
    },
    (err: unknown) => {
      katexLoad = null; // the next document tries again
      throw err;
    },
  );
  return katexLoad;
}

/* ---- $ and $$ as GitHub reads them ---- */

// KaTeX's plugin (VS Code's) reads $ and $$ its own way: an unclosed "$$"
// at the start of a line took the rest of the document, a "$$x$$" with
// spaces after it took every line down to the next $$, text after a closing
// $$ was lost, and "$$x$$" within a sentence split its paragraph (a <p>
// inside a <p>). Its rules are replaced, under the same names; its
// renderers stay.
function mathAsOnGitHub(md: MarkdownIt): void {
  md.block.ruler.at("math_block", mathBlock, { alt: ["paragraph", "reference", "blockquote", "list"] });
  md.inline.ruler.at("math_inline_block", inlineDisplayMath);
  md.inline.ruler.at("math_inline", inlineMath);
  // display math within a line of text: a <span> (display: block in
  // markdown.css), as a <p> can't hold a <p>
  const display = md.renderer.rules.math_inline_block;
  if (display) {
    md.renderer.rules.math_inline_block = (tokens, idx, options, env, self) =>
      display(tokens, idx, options, env, self).replace(/^<p\b/, "<span").replace(/<\/p>\s*$/, "</span>");
  }
  // ```math with words after it ("```math Energy") is math too, as on
  // GitHub: the plugin takes only a bare "math"
  md.core.ruler.push("math_fence_title", (state) => {
    for (const token of state.tokens) {
      if (token.type === "fence" && /^math\s/i.test(token.info.trim())) token.info = "math";
    }
  });
}

// The first "$$" in src[from, to) that is no escaped "\$" and a "$": its
// index, or -1.
function dollarsIn(src: string, from: number, to: number): number {
  const text = src.slice(from, to);
  for (let i = text.indexOf("$$"); i >= 0; i = text.indexOf("$$", i + 1)) {
    let slashes = 0;
    while (text[i - 1 - slashes] === "\\") slashes++;
    if (slashes % 2 === 0) return from + i;
  }
  return -1;
}

// "$$" at the start of a line opens display math, a block of its own, when
// the first "$$" after it ends a line: the same one ("$$x$$", spaces after
// it allowed) or one below, before a blank line (a formula holds none, as
// on GitHub) or the end of its list item or quote. Without one ("$$ 100
// l'uno") the line is prose. With text after that "$$", the lines stay
// their paragraph's: the formula shows within it (inlineDisplayMath), and
// the text after it too.
function mathBlock(state: StateBlock, start: number, end: number, silent: boolean): boolean {
  // four columns in: indented code
  if (state.sCount[start] - state.blkIndent >= 4) return false;
  const src = state.src;
  const open = state.bMarks[start] + state.tShift[start];
  if (!src.startsWith("$$", open) || src[open + 2] === "$") return false;
  let line = start;
  let close = dollarsIn(src, open + 2, state.eMarks[start]);
  while (close < 0) {
    line++;
    // a line less indented than the block leaves its list item, as for a fence
    if (line >= end || state.isEmpty(line) || state.sCount[line] < state.blkIndent) return false;
    close = dollarsIn(src, state.bMarks[line] + state.tShift[line], state.eMarks[line]);
  }
  if (!/^[ \t]*$/.test(src.slice(close + 2, state.eMarks[line]))) return false;
  if (silent) return true;

  state.line = line + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.markup = "$$";
  token.map = [start, state.line];
  token.content =
    line === start
      ? src.slice(open + 2, close)
      : [
          src.slice(open + 2, state.eMarks[start]),
          state.getLines(start + 1, line, state.sCount[start], false),
          src.slice(state.bMarks[line] + state.tShift[line], close),
        ]
          .filter((part) => part.trim())
          .join("\n");
  return true;
}

// $$…$$ within a line of text: display math, inside the paragraph. As the
// plugin's own rule, and as on GitHub no space or tab just inside a $$ on
// its line ("$$ 100 l'uno, oppure $$ 50" is prose); a line break there is
// fine ("text $$⏎x⏎$$ more text").
function inlineDisplayMath(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (!src.startsWith("$$", start)) return false;
  const prev = src[start - 1];
  let close = prev === "$" || prev === "\\" || src[start + 2] === "$" ? -1 : dollarsIn(src, start + 2, state.posMax);
  if (close >= 0) {
    const math = src.slice(start + 2, close);
    if (src[close + 2] === "$" || !math.trim() || /^[ \t]+\S/.test(math) || /\S[ \t]+$/.test(math)) close = -1;
  }
  if (close < 0) {
    if (!silent) state.pending += "$$";
    state.pos = start + 2;
    return true;
  }
  if (!silent) {
    const token = state.push("math_inline_block", "math", 0);
    token.block = true;
    token.markup = "$$";
    token.content = src.slice(start + 2, close);
  }
  state.pos = close + 2;
  return true;
}

// a letter, digit or "_": a "$" right after one is a dollar ("US$5"), and
// so is one right before one when it would close ("$5 and $10")
const isWordChar = (c: string | undefined): boolean => c !== undefined && /\w/.test(c);

// $…$ inline math. As the plugin's own rule, and as on GitHub (and pandoc)
// no space just inside: "between $ 5 and $ 10" is prose. $`…`$, GitHub's
// form for math holding markdown's own characters, ends at the first "`$",
// so that math may hold a "$".
function inlineMath(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src[start] !== "$") return false;
  // right after an opening HTML tag: GitHub's <span>$</span>, a dollar
  // beside math (the plugin's own check)
  const last = state.tokens[state.tokens.length - 1];
  if (last?.type === "html_inline" && /^<\w+.+[^/]>$/.test(last.content)) return false;
  const close = closingDollar(state, start);
  if (close < 0) {
    if (!silent) state.pending += "$";
    state.pos = start + 1;
    return true;
  }
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    // the backticks of $`…`$ stay: the plugin's renderer takes them off
    token.content = src.slice(start + 1, close);
  }
  state.pos = close + 1;
  return true;
}

// The "$" closing the math that the one at `start` opens, or -1: a dollar.
function closingDollar(state: StateInline, start: number): number {
  const src = state.src;
  const prev = src[start - 1];
  const next = src[start + 1];
  if (prev === "$" || prev === "\\" || isWordChar(prev) || next === undefined || /\s/.test(next)) return -1;
  if (next === "`") {
    const end = src.indexOf("`$", start + 3);
    if (end >= 0 && end + 1 < state.posMax) return end + 1;
  }
  for (let end = src.indexOf("$", start + 1); end >= 0 && end < state.posMax; end = src.indexOf("$", end + 1)) {
    let slashes = 0;
    while (src[end - 1 - slashes] === "\\") slashes++;
    if (slashes % 2) continue;
    const after = src[end + 1];
    // nothing between the two ("$$"): written as it is, as by the plugin
    return end > start + 1 && after !== "$" && !isWordChar(after) && !/\s/.test(src[end - 1]) ? end : -1;
  }
  return -1;
}

// what would let a document open things in the top layer, over the app
const TOP_LAYER_ATTRS = ["popover", "popovertarget", "popovertargetaction", "command", "commandfor", "interestfor"];

/** What a render needs of a document: its text, and the folder its relative URLs point into (null: none, pasted text). */
export interface RenderSource {
  content: string;
  dir: string | null;
}

/**
 * A document's markdown as HTML, not yet sanitized, and its front matter's
 * YAML (null: none): the part of a render that needs no DOM, so that it can
 * be tried in Node.
 */
export async function markdownToHtml(content: string): Promise<{ html: string; yaml: string | null }> {
  // without KaTeX (it failed to load) the math shows as written
  if (mayHoldMath(content)) await loadKatex().catch(() => {});
  pendingFrontMatter = null;
  const html = md.render(content);
  const yaml: string | null = pendingFrontMatter;
  pendingFrontMatter = null;
  return { html, yaml };
}

// Whatever is sanitized, a diagram's SVG included (Mermaid sanitizes its own with this
// DOMPurify): nothing that names the app's own protocol gets through, as an attribute or in a
// diagram's <style> (reach.ts). Here and not on the fragment: an <img> starts loading as soon
// as it is parsed into this document, and the sanitizer works in one that loads nothing.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.nodeType === Node.ELEMENT_NODE) dropAppProtocol(node as Element);
});
DOMPurify.addHook("uponSanitizeElement", (node) => {
  if (node.nodeName.toLowerCase() === "style" && namesAppProtocol(node.textContent ?? "")) node.textContent = "";
});

// All fallible work (markdown-it, DOMPurify, image IPC) happens here, before
// anything touches the live DOM — callers can keep the previous content on error.
export async function renderFragment(doc: RenderSource): Promise<HTMLElement> {
  const { html, yaml } = await markdownToHtml(doc.content);
  // no <style> ever (the tag filter already shows it as text), no popovers
  // or command buttons: per call, since Mermaid sanitizes its SVGs, <style>
  // included, with this DOMPurify
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ["style"],
    FORBID_ATTR: TOP_LAYER_ATTRS,
  });
  const staging = document.createElement("div");
  staging.innerHTML = clean;
  // before [TOC] is built: it links to the ids
  restoreHeadingIds(staging);
  retargetLegacyLinks(staging);
  renameReservedIds(staging);
  // before the URLs resolve and each image's load is checked
  applyScheme(staging, document.documentElement.dataset.scheme === "dark" ? "dark" : "light");
  await rewriteLocalUrls(staging, doc.dir);
  labelTaskBoxes(staging);
  wrapCodeBlocks(staging);
  wrapTables(staging);
  renderTocPlaceholders(staging);
  // after the wraps: the front matter's own table is not a document table
  if (yaml !== null) staging.prepend(fm.build(yaml));
  return staging;
}

export async function render(doc: RenderSource, article: HTMLElement): Promise<void> {
  const staging = await renderFragment(doc);
  // a video or a sound playing goes on playing (media.ts)
  const keep = collectMedia(article);
  article.replaceChildren(...staging.childNodes);
  restoreMedia(keep, article);
}

/* ---- the document's ids ---- */

// DOMPurify drops an id naming a property of `document` or of a form
// ("links", "images", "title", "name", "timeline"…), against DOM clobbering:
// such a heading would lose its anchor and its place in the outline. A
// heading clobbers nothing, so its id, kept aside in data-hid, comes back.
function restoreHeadingIds(root: HTMLElement): void {
  for (const h of root.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4,h5,h6)[data-hid]")) {
    if (!h.id) h.id = h.dataset.hid ?? "";
    h.removeAttribute("data-hid");
  }
}

const XLINK = "http://www.w3.org/1999/xlink";

// Points the document's own #links elsewhere: `to` gets a link's fragment as
// written and percent-decoded, and returns the id it should name now, or
// undefined to leave the link alone. <a> in HTML and in SVG, image-map
// <area>, SVG's older xlink:href.
function retargetLinks(root: HTMLElement, to: (fragments: string[]) => string | undefined): void {
  const retarget = (el: Element, ns: string | null) => {
    const href = ns ? el.getAttributeNS(ns, "href") : el.getAttribute("href");
    if (!href?.startsWith("#")) return;
    const id = to([href.slice(1), decodeSafe(href.slice(1))]);
    if (id === undefined) return;
    if (ns) el.setAttributeNS(ns, "xlink:href", `#${id}`);
    else el.setAttribute("href", `#${id}`);
  };
  for (const el of root.querySelectorAll("a, area")) {
    retarget(el, null);
    retarget(el, XLINK);
  }
}

// A link to a heading's id before 1.15.1 ("#1.-introduzione") follows the
// heading to its new id, unless something in the document has that id now.
function retargetLegacyLinks(root: HTMLElement): void {
  const moved = new Map<string, string>();
  for (const h of root.querySelectorAll<HTMLElement>("[data-legacy-id]")) {
    const legacy = h.dataset.legacyId ?? "";
    if (h.id && !moved.has(legacy)) moved.set(legacy, h.id);
  }
  if (moved.size === 0) return;
  const ids = new Set([...root.querySelectorAll("[id]")].map((el) => el.id));
  retargetLinks(root, (fragments) =>
    fragments.some((f) => ids.has(f)) ? undefined : fragments.map((f) => moved.get(f)).find((id) => id !== undefined),
  );
}

// made after the first render: the editor's (editor.ts) and the print header's (main.ts)
const RUNTIME_IDS = [
  "format-bar",
  "editor-host",
  "print-page-meta",
  // the command palette (palette.ts), built the first time it opens
  "palette",
  "palette-input",
  "palette-list",
  "palette-help",
  "palette-status",
];
// Mermaid's working ids: it deletes whatever element carries one
const MERMAID_ID_RE = /^[di]?mmd-\d+$/;
// the file tree's folder groups (tree.ts), made after the ids were first read
const TREE_GROUP_ID_RE = /^tree-group-\d+$/;
// the palette's groups and options
const PALETTE_ID_RE = /^palette-(?:opt|g)-\d+$/;
let appIds: Set<string> | null = null;

// the ids of the app's own UI, read off the page the first time: until then
// the article is empty
function isReserved(id: string): boolean {
  appIds ??= new Set([
    ...[...document.querySelectorAll("[id]")].filter((el) => !el.closest("#article")).map((el) => el.id),
    ...RUNTIME_IDS,
  ]);
  return appIds.has(id) || MERMAID_ID_RE.test(id) || TREE_GROUP_ID_RE.test(id) || PALETTE_ID_RE.test(id);
}

// A heading "Toolbar" gets the id "toolbar", which the app's own styles and
// lookups mean for its toolbar (and print hides). In the document such an id
// becomes user-content-<id>, as GitHub does, with the name it was written
// with kept in data-anchor for links from elsewhere. Links within the
// document follow, so [TOC], footnotes, PDF and exports stay consistent.
function renameReservedIds(root: HTMLElement): void {
  const renamed = new Set<string>();
  for (const el of root.querySelectorAll<HTMLElement>("[id]")) {
    if (!isReserved(el.id)) continue;
    renamed.add(el.id);
    el.setAttribute("data-anchor", el.id);
    el.id = `user-content-${el.id}`;
  }
  if (renamed.size === 0) return;
  retargetLinks(root, (fragments) => {
    const id = fragments.find((f) => renamed.has(f));
    return id === undefined ? undefined : `user-content-${id}`;
  });
}

/* ---- local images, video and audio ---- */

const decodeSafe = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray "%" is part of the name
  }
};

// not a URL with a scheme (https:, data:, asset:…) nor a bare "#…". A network path
// ("//server/share/…") counts too, so that it is never left for the page to load: localUrl
// answers for it only when the document itself is on that share
const isLocalUrl = (url: string): boolean => url !== "" && !/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(url);

// Files resolved per folder: the live preview renders again at every pause
// in typing. Only hits are kept, so a file created later is still found.
const resolvedUrls = new Map<string, string>();

// A relative URL as the asset protocol's: null when no such file exists. A
// fragment is no part of the file name and stays (#t=10 seeks a video,
// #gh-dark-mode-only marks GitHub's dark-theme images); a query goes.
async function localUrl(dir: string, url: string): Promise<string | null> {
  const hash = url.indexOf("#");
  const fragment = hash >= 0 ? url.slice(hash) : "";
  const rel = url.slice(0, hash >= 0 ? hash : undefined).replace(/\?.*$/, "");
  if (!rel) return null;
  const path = decodeSafe(rel);
  // a file on another computer is not looked up: Windows would call that computer
  if (!reachable(dir, path)) return null;
  const key = `${dir}\n${rel}`;
  let asset = resolvedUrls.get(key);
  if (asset === undefined) {
    try {
      asset = convertFileSrc(await resolvePath(dir, path));
    } catch {
      return null;
    }
    if (resolvedUrls.size > 500) resolvedUrls.clear();
    resolvedUrls.set(key, asset);
  }
  return asset + fragment;
}

// ![[picture.png]] names a picture anywhere in the document's folder, as note-taking apps keep
// them (an "attachments" folder): one that is not beside the document is looked for in the
// folder's tree (find_in_folder), then read as any picture there. Found ones are kept, as
// relative URLs; a miss for a few seconds, so that the live preview, rendering at every pause
// in typing, does not walk the folder each time.
const foundEmbeds = new Map<string, string>();
const missedEmbeds = new Map<string, number>();
// one walk per name at a time: a picture shown twice asks once
const embedLookups = new Map<string, Promise<string | null>>();
// a miss is looked for again after half a minute, or at once when files come and go
// (forgetFoundFiles): a walk can take up to 20 000 entries
const EMBED_MISS_MS = 30_000;

/**
 * Files came or went in the file pane's folder (its watcher's "tree-changed"): pictures
 * found or missed by name, and files resolved, are looked for again at the next render.
 */
export function forgetFoundFiles(): void {
  foundEmbeds.clear();
  missedEmbeds.clear();
  resolvedUrls.clear();
}

// The relative URL of the file find_in_folder finds for `name` under `dir`, or null.
async function findEmbed(dir: string, name: string): Promise<string | null> {
  let path: string | null = null;
  try {
    path = await findInFolder(dir, name);
  } catch {
    path = null;
  }
  // what it found, as a path inside the folder (it never answers another)
  const base = dir.replace(/[\\/]+$/, "");
  if (
    path === null ||
    path.length <= base.length + 1 ||
    path.slice(0, base.length).toLowerCase() !== base.toLowerCase() ||
    !/[\\/]/.test(path[base.length])
  ) {
    return null;
  }
  return path
    .slice(base.length + 1)
    .split(/[\\/]+/)
    .map((s) => encodeURIComponent(s))
    .join("/");
}

async function embedUrl(dir: string, name: string): Promise<string | null> {
  // never a name that leaves the folder, starts at a root or a drive, or is on another computer
  if (!name || /^(?:[\\/]|[a-z]:)/i.test(name) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(name) || !reachable(dir, name)) {
    return null;
  }
  const key = `${dir}\n${name}`;
  let rel = foundEmbeds.get(key);
  if (rel === undefined) {
    if (performance.now() - (missedEmbeds.get(key) ?? -Infinity) < EMBED_MISS_MS) return null;
    let job = embedLookups.get(key);
    if (!job) {
      job = findEmbed(dir, name).finally(() => embedLookups.delete(key));
      embedLookups.set(key, job);
    }
    const found = await job;
    if (found === null) {
      if (missedEmbeds.size > 500) missedEmbeds.clear();
      missedEmbeds.set(key, performance.now());
      return null;
    }
    if (foundEmbeds.size > 500) foundEmbeds.clear();
    foundEmbeds.set(key, found);
    rel = found;
  }
  const url = await localUrl(dir, rel);
  // moved or removed since it was found: looked for again next time
  if (url === null) foundEmbeds.delete(key);
  return url;
}

// An address on another computer (reach.ts). The page must not be left to load it either: read
// as a web address, "//server/a.png" is that server over http.
const offLimits = (dir: string, url: string): boolean =>
  isLocalUrl(url) && !reachable(dir, decodeSafe(url.replace(/[?#].*$/, "")));

// "a.png 1x, b.png 2x": the candidates of a srcset, each a URL and its
// descriptors. As in the HTML spec, a URL may hold commas; one ends at
// whitespace, and trailing commas end the candidate.
function parseSrcset(value: string): { url: string; descriptor: string }[] {
  const out: { url: string; descriptor: string }[] = [];
  let i = 0;
  while (i < value.length) {
    while (i < value.length && /[\s,]/.test(value[i])) i++;
    if (i >= value.length) break;
    let j = i;
    while (j < value.length && !/\s/.test(value[j])) j++;
    let url = value.slice(i, j);
    let descriptor = "";
    if (url.endsWith(",")) {
      url = url.replace(/,+$/, "");
      i = j;
    } else {
      let k = j;
      while (k < value.length && value[k] !== ",") k++;
      descriptor = value.slice(j, k).trim();
      i = k + 1;
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

async function rewriteSrcset(el: Element, dir: string): Promise<void> {
  const candidates = parseSrcset(el.getAttribute("srcset") ?? "");
  const urls = await Promise.all(candidates.map((c) => (isLocalUrl(c.url) ? localUrl(dir, c.url) : c.url)));
  // one that did not resolve stays as written, but not one on another computer
  const kept = candidates
    .map((c, i) => ({ url: urls[i] ?? c.url, descriptor: c.descriptor, gone: !urls[i] && offLimits(dir, c.url) }))
    .filter((c) => !c.gone);
  if (kept.length) el.setAttribute("srcset", kept.map((c) => [c.url, c.descriptor].filter(Boolean).join(" ")).join(", "));
  else el.removeAttribute("srcset");
}

async function rewriteAttr(el: Element, attr: string, dir: string): Promise<void> {
  const value = el.getAttribute(attr) ?? "";
  if (!isLocalUrl(value)) return;
  const url = await localUrl(dir, value);
  if (url) el.setAttribute(attr, url);
  else if (offLimits(dir, value)) el.removeAttribute(attr);
}

const MEDIA_URLS: [selector: string, attr: string][] = [
  ["video[src], audio[src]", "src"],
  ["video[poster]", "poster"],
  [":is(video, audio) > source[src]", "src"],
  ["track[src]", "src"],
];

// Relative URLs (images, a picture's sources, video, audio, subtitles) point
// into the document's folder: only the asset protocol can serve it.
async function rewriteLocalUrls(root: HTMLElement, dir: string | null): Promise<void> {
  if (dir === null) return dropLocalUrls(root);
  // Subtitles come from the asset protocol, another origin than the page's:
  // a <track> is only fetched across origins when its video asks with CORS
  // (which the asset protocol allows)
  for (const track of root.querySelectorAll(":is(video, audio) > track[src]")) {
    const media = track.parentElement as HTMLMediaElement;
    if (isLocalUrl(track.getAttribute("src") ?? "") && !media.hasAttribute("crossorigin")) {
      media.setAttribute("crossorigin", "anonymous");
    }
  }
  const jobs: Promise<unknown>[] = [];
  const missing = new Set<HTMLImageElement>();
  for (const el of root.querySelectorAll("img[srcset], picture > source[srcset]")) jobs.push(rewriteSrcset(el, dir));
  for (const [selector, attr] of MEDIA_URLS) {
    for (const el of root.querySelectorAll(selector)) jobs.push(rewriteAttr(el, attr, dir));
  }
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (!isLocalUrl(src)) continue;
    // ![[picture.png]] not beside the document: somewhere in its folder (embedUrl)
    const embed = img.dataset.embed;
    jobs.push(
      localUrl(dir, src)
        .then((url) => url ?? (embed !== undefined && !offLimits(dir, src) ? embedUrl(dir, embed) : null))
        .then((url) => {
          if (url) {
            img.src = url;
            return;
          }
          if (offLimits(dir, src)) {
            img.removeAttribute("src");
            if (!img.alt) img.alt = src;
          }
          // with a srcset or a <picture>, another candidate may still load
          if (!img.hasAttribute("srcset") && !img.closest("picture")) {
            missing.add(img);
            if (!img.alt) img.alt = src;
          }
        }),
    );
  }
  await Promise.all(jobs);
  // a <source> changed under a video or an audio is read again only on
  // load(); here, so that the fragment plays wherever it goes. A copy that
  // gives way to the same video already playing is let go (media.ts).
  for (const m of root.querySelectorAll<HTMLMediaElement>("video, audio")) {
    if (m.querySelector(":scope > source[src]")) m.load();
  }
  for (const img of root.querySelectorAll("img")) {
    if (missing.has(img)) markMissing(img);
    else watchForLoadFailure(img);
  }
}

// A document in no folder (text pasted from the clipboard): its relative URLs
// lead nowhere. Nothing is asked of the asset protocol for them, nor of the
// app's own folder; its pictures show as missing, named by their address.
function dropLocalUrls(root: HTMLElement): void {
  for (const el of root.querySelectorAll("img[srcset], picture > source[srcset]")) {
    const kept = parseSrcset(el.getAttribute("srcset") ?? "").filter((c) => !isLocalUrl(c.url));
    if (kept.length) el.setAttribute("srcset", kept.map((c) => [c.url, c.descriptor].filter(Boolean).join(" ")).join(", "));
    else el.removeAttribute("srcset");
  }
  for (const [selector, attr] of MEDIA_URLS) {
    for (const el of root.querySelectorAll(selector)) {
      if (isLocalUrl(el.getAttribute(attr) ?? "")) el.removeAttribute(attr);
    }
  }
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    if (isLocalUrl(src)) {
      img.removeAttribute("src");
      if (!img.alt) img.alt = src;
    }
    // nothing left to load: its address was local, or one the sanitizer took away
    if (!img.hasAttribute("src") && !img.hasAttribute("srcset") && !img.closest("picture")) markMissing(img);
  }
}

// A path can resolve and still have no file behind it, which only shows up as a
// load error. The listener goes on *after* the rewrite: the original relative
// src always 404s against tauri.localhost, and that error is not the one we mean.
function watchForLoadFailure(img: HTMLImageElement): void {
  if (img.complete) {
    if (!img.naturalWidth) markMissing(img);
    return;
  }
  img.addEventListener("error", () => markMissing(img), { once: true });
}

function markMissing(img: HTMLImageElement): void {
  img.classList.add("img-missing");
  unmarkZoomable(img); // nothing to preview
}

/* ---- light and dark pictures ---- */

// (prefers-color-scheme: dark), or the bare feature, which any scheme matches
const SCHEME_FEATURE_RE = /\(\s*prefers-color-scheme\s*(?::\s*([a-z-]+)\s*)?\)/gi;

/**
 * A <picture>'s sources for light and dark pages (as GitHub READMEs write
 * them) follow the app's theme, not Windows': the scheme feature becomes one
 * that always or never matches, so the rest of the query still counts. The
 * media as written stays in data-media; called again on every theme change
 * and around printing.
 */
export function applyScheme(root: ParentNode, scheme: "light" | "dark"): void {
  for (const source of root.querySelectorAll<HTMLSourceElement>("picture > source[media]")) {
    const media = source.dataset.media ?? source.getAttribute("media") ?? "";
    if (!/prefers-color-scheme/i.test(media)) continue;
    if (source.dataset.media === undefined) source.dataset.media = media;
    source.setAttribute(
      "media",
      media.replace(SCHEME_FEATURE_RE, (_all, value?: string) =>
        // (width < 0px) is valid and never true, so a `not (…)` around it still works
        !value || value.toLowerCase() === scheme ? "(min-width: 0px)" : "(width < 0px)",
      ),
    );
  }
}

// A paragraph that is just [TOC] (or [[TOC]], [toc]) becomes a table of
// contents of the headings that follow it, as nested lists of links. It is
// part of the document, so it also goes to print, HTML and DOCX.
function renderTocPlaceholders(root: HTMLElement): void {
  for (const p of [...root.querySelectorAll("p")]) {
    if (!/^\s*\[\[?toc\]?\]\s*$/i.test(p.textContent ?? "")) continue;
    const nav = document.createElement("nav");
    nav.className = "doc-toc";
    nav.setAttribute("aria-label", t("render.toc"));
    if (p.dataset.sourceLine) nav.dataset.sourceLine = p.dataset.sourceLine;
    const heads: HTMLElement[] = [];
    let after = false;
    for (const h of root.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4)[id]")) {
      if (!after && p.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) after = true;
      if (after) heads.push(h);
    }
    const top = heads.length ? Math.min(...heads.map((h) => Number(h.tagName[1]))) : 1;
    const stack: HTMLUListElement[] = [];
    const rootList = document.createElement("ul");
    stack.push(rootList);
    let level = top;
    for (const h of heads) {
      const l = Math.max(top, Number(h.tagName[1]));
      while (l > level) {
        const ul = document.createElement("ul");
        const parent = stack[stack.length - 1];
        (parent.lastElementChild ?? parent).append(ul);
        stack.push(ul);
        level++;
      }
      while (l < level && stack.length > 1) {
        stack.pop();
        level--;
      }
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `#${h.id}`;
      a.textContent = h.textContent ?? "";
      li.append(a);
      stack[stack.length - 1].append(li);
    }
    nav.append(rootList);
    p.replaceWith(nav);
  }
}

const TASK_LABEL_MAX = 120;
// not the item's own text: its sub-lists, and KaTeX's MathML copy of its
// math (the copy on screen counts; the MathML one also holds the TeX source)
const NOT_OWN_TEXT = "ul, ol, .katex-mathml";

// A task's checkbox is named by its item's own text, or a screen reader
// announces a bare "checkbox": the text is no <label> (only the box toggles).
// Read off the text nodes: a copy of the item would load its images again.
function labelTaskBoxes(root: HTMLElement): void {
  for (const box of root.querySelectorAll<HTMLInputElement>("input.task-list-item-checkbox")) {
    const li = box.closest("li");
    if (!li) continue;
    const walker = document.createTreeWalker(li, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n instanceof Element && n.matches(NOT_OWN_TEXT) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    let text = "";
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n instanceof Text) text += n.data;
    const chars = [...text.replace(/\s+/g, " ").trim()];
    const label =
      chars.length > TASK_LABEL_MAX ? `${chars.slice(0, TASK_LABEL_MAX - 1).join("").trimEnd()}…` : chars.join("");
    if (label) box.setAttribute("aria-label", label);
  }
}

function wrapCodeBlocks(root: HTMLElement): void {
  for (const code of root.querySelectorAll("pre > code")) {
    const lang = /language-(\S+)/.exec(code.className)?.[1] ?? "";
    if (lang === "mermaid") continue; // handled by the mermaid pass
    const pre = code.parentElement as HTMLPreElement;

    const wrap = document.createElement("div");
    wrap.className = "code-block";
    const head = document.createElement("div");
    head.className = "code-head";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = lang;
    const btn = document.createElement("button");
    btn.className = "code-copy icon-btn";
    btn.type = "button";
    btn.title = t("render.copy");
    btn.innerHTML = COPY_ICON;
    btn.addEventListener("click", () => {
      navigator.clipboard.writeText(code.textContent ?? "").then(
        () => {
          btn.innerHTML = CHECK_ICON;
          setTimeout(() => (btn.innerHTML = COPY_ICON), 1200);
        },
        () => {
          /* clipboard unavailable */
        },
      );
    });
    head.append(label, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

const TABLE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/></svg>';
const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';

function tableButton(cls: string, label: string, icon: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = `${cls} icon-btn small`;
  btn.type = "button";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.innerHTML = icon;
  return btn;
}

// A table scrolls sideways in its own box, and its hover buttons sit beside
// that box, so they stay put when it scrolls: copy, as tab-separated text
// that Excel and Sheets paste straight into cells, and the full-window
// preview (lightbox.ts handles its clicks on the article).
function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll("table")) {
    const block = document.createElement("div");
    block.className = "table-block";
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    table.replaceWith(block);
    scroll.append(table);
    const copy = tableButton("table-copy", t("render.copyTable"), TABLE_ICON);
    copy.addEventListener("click", () => {
      navigator.clipboard.writeText(tableToTsv(table)).then(
        () => {
          copy.innerHTML = CHECK_ICON;
          setTimeout(() => (copy.innerHTML = TABLE_ICON), 1200);
        },
        () => {
          /* clipboard unavailable */
        },
      );
    });
    const actions = document.createElement("div");
    actions.className = "table-actions";
    actions.append(copy, tableButton("table-expand", t("zoom.open"), EXPAND_ICON));
    block.append(scroll, actions);
  }
}
