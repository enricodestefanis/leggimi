import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import katexModule from "@vscode/markdown-it-katex";
import githubAlerts from "markdown-it-github-alerts";
import footnote from "markdown-it-footnote";
import frontMatter from "markdown-it-front-matter";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";

import { resolvePath, type MarkdownDoc } from "./ipc";
import { unmark as unmarkZoomable } from "./lightbox";
import * as fm from "./frontmatter";
import { t } from "./i18n";

// @vscode/markdown-it-katex is CJS-only; not every loader unwraps its default
const katex = ((katexModule as { default?: unknown }).default ?? katexModule) as typeof katexModule;

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

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
  .use(anchor, { tabIndex: false })
  .use(taskLists, { label: true, enabled: true })
  .use(katex, { enableFencedBlocks: true })
  .use(githubAlerts)
  .use(footnote)
  // the plugin reports the YAML through a callback; md.render is synchronous,
  // so the value belongs to the render in flight
  .use(frontMatter, (yaml: string) => {
    pendingFrontMatter = yaml;
  });

// Link only what is written as an address (scheme or www.): "README.md" or
// "main.rs" in prose would otherwise become web links, .md and .rs being
// country domains.
md.linkify.set({ fuzzyLink: false });
// The text stays as typed: no (c) → ©, (tm) → ™, -- → –, ... → … (a "--line"
// in prose is a flag, not a dash); quotes still curl.
md.disable("replacements");

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
// the line on their first tag.
for (const rule of ["math_block", "fence", "html_block"] as const) {
  const original = md.renderer.rules[rule];
  if (!original) continue;
  md.renderer.rules[rule] = (tokens, idx, options, env, self) => {
    const html = original(tokens, idx, options, env, self);
    const map = tokens[idx].map;
    if (!map || html.includes("data-source-line")) return html;
    return html.replace(/^(\s*<[a-zA-Z][\w-]*)/, `$1 data-source-line="${map[0]}"`);
  };
}

// All fallible work (markdown-it, DOMPurify, image IPC) happens here, before
// anything touches the live DOM — callers can keep the previous content on error.
export async function renderFragment(doc: MarkdownDoc): Promise<HTMLElement> {
  pendingFrontMatter = null;
  // no <style> ever (the tag filter already shows it as text): per call,
  // since Mermaid sanitizes its SVGs, <style> included, with this DOMPurify
  const clean = DOMPurify.sanitize(md.render(doc.content), { FORBID_TAGS: ["style"] });
  const yaml = pendingFrontMatter;
  pendingFrontMatter = null;
  const staging = document.createElement("div");
  staging.innerHTML = clean;
  // before [TOC] is built: it links to the ids
  restoreHeadingIds(staging);
  renameReservedIds(staging);
  await rewriteLocalUrls(staging, doc.dir);
  wrapCodeBlocks(staging);
  wrapTables(staging);
  renderTocPlaceholders(staging);
  // after the wraps: the front matter's own table is not a document table
  if (yaml !== null) staging.prepend(fm.build(yaml));
  return staging;
}

export async function render(doc: MarkdownDoc, article: HTMLElement): Promise<void> {
  const staging = await renderFragment(doc);
  article.replaceChildren(...staging.childNodes);
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

// made after the first render: the editor's (editor.ts) and the print header's (main.ts)
const RUNTIME_IDS = ["format-bar", "editor-host", "print-page-meta"];
// Mermaid's working ids: it deletes whatever element carries one
const MERMAID_ID_RE = /^[di]?mmd-\d+$/;
const XLINK = "http://www.w3.org/1999/xlink";
let appIds: Set<string> | null = null;

// the ids of the app's own UI, read off the page the first time: until then
// the article is empty
function isReserved(id: string): boolean {
  appIds ??= new Set([
    ...[...document.querySelectorAll("[id]")].filter((el) => !el.closest("#article")).map((el) => el.id),
    ...RUNTIME_IDS,
  ]);
  return appIds.has(id) || MERMAID_ID_RE.test(id);
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
  const retarget = (el: Element, ns: string | null) => {
    const href = ns ? el.getAttributeNS(ns, "href") : el.getAttribute("href");
    if (!href?.startsWith("#")) return;
    const id = [href.slice(1), decodeSafe(href.slice(1))].find((v) => renamed.has(v));
    if (id === undefined) return;
    if (ns) el.setAttributeNS(ns, "xlink:href", `#user-content-${id}`);
    else el.setAttribute("href", `#user-content-${id}`);
  };
  // <a> in HTML and in SVG, image-map <area>, SVG's older xlink:href
  for (const el of root.querySelectorAll("a, area")) {
    retarget(el, null);
    retarget(el, XLINK);
  }
}

/* ---- local images, video and audio ---- */

const decodeSafe = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a stray "%" is part of the name
  }
};

// not a URL with a scheme (https:, data:, asset:…) nor a bare "#…"; a network
// path ("//server/share/…") is a file too
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
  const key = `${dir}\n${rel}`;
  let asset = resolvedUrls.get(key);
  if (asset === undefined) {
    try {
      asset = convertFileSrc(await resolvePath(dir, decodeSafe(rel)));
    } catch {
      return null;
    }
    if (resolvedUrls.size > 500) resolvedUrls.clear();
    resolvedUrls.set(key, asset);
  }
  return asset + fragment;
}

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
  el.setAttribute(
    "srcset",
    candidates.map((c, i) => [urls[i] ?? c.url, c.descriptor].filter(Boolean).join(" ")).join(", "),
  );
}

async function rewriteAttr(el: Element, attr: string, dir: string): Promise<void> {
  const value = el.getAttribute(attr) ?? "";
  if (!isLocalUrl(value)) return;
  const url = await localUrl(dir, value);
  if (url) el.setAttribute(attr, url);
}

const MEDIA_URLS: [selector: string, attr: string][] = [
  ["video[src], audio[src]", "src"],
  ["video[poster]", "poster"],
  [":is(video, audio) > source[src]", "src"],
  ["track[src]", "src"],
];

// Relative URLs (images, a picture's sources, video, audio, subtitles) point
// into the document's folder: only the asset protocol can serve it.
async function rewriteLocalUrls(root: HTMLElement, dir: string): Promise<void> {
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
    jobs.push(
      localUrl(dir, src).then((url) => {
        if (url) img.src = url;
        // with a srcset or a <picture>, another candidate may still load
        else if (!img.hasAttribute("srcset") && !img.closest("picture")) {
          missing.add(img);
          if (!img.alt) img.alt = src;
        }
      }),
    );
  }
  await Promise.all(jobs);
  // a <source> changed under a video or an audio is read again only on load()
  for (const m of root.querySelectorAll<HTMLMediaElement>("video, audio")) {
    if (m.querySelector(":scope > source[src]")) m.load();
  }
  for (const img of root.querySelectorAll("img")) {
    if (missing.has(img)) markMissing(img);
    else watchForLoadFailure(img);
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
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent ?? "");
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => (btn.innerHTML = COPY_ICON), 1200);
      } catch {
        /* clipboard unavailable */
      }
    });
    head.append(label, btn);
    pre.replaceWith(wrap);
    wrap.append(head, pre);
  }
}

const TABLE_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="9" x2="9" y2="21"/></svg>';

function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    table.replaceWith(scroll);
    scroll.append(table);
    // hover button: the table as tab-separated text, which Excel and Sheets
    // paste straight into cells
    const btn = document.createElement("button");
    btn.className = "table-copy icon-btn small";
    btn.type = "button";
    btn.title = t("render.copyTable");
    btn.innerHTML = TABLE_ICON;
    btn.addEventListener("click", async () => {
      const rows = [...table.querySelectorAll("tr")].map((tr) =>
        [...tr.querySelectorAll("th, td")].map((c) => (c.textContent ?? "").trim().replace(/\s+/g, " ")).join("\t"),
      );
      try {
        await navigator.clipboard.writeText(rows.join("\n"));
        btn.innerHTML = CHECK_ICON;
        setTimeout(() => (btn.innerHTML = TABLE_ICON), 1200);
      } catch {
        /* clipboard unavailable */
      }
    });
    scroll.append(btn);
  }
}
