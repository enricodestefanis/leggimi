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

let pendingFrontMatter: string | null = null;

// Tag every rendered block with its source line for editor→preview scroll sync.
// Fence attrs land on the <code> element; blocks that drop attrs are stamped below.
md.core.ruler.push("source_line_map", (state) => {
  for (const token of state.tokens) {
    if (token.map && token.nesting !== -1) {
      token.attrSet("data-source-line", String(token.map[0]));
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
  const clean = DOMPurify.sanitize(md.render(doc.content));
  const yaml = pendingFrontMatter;
  pendingFrontMatter = null;
  const staging = document.createElement("div");
  staging.innerHTML = clean;
  await rewriteImages(staging, doc.dir);
  wrapCodeBlocks(staging);
  wrapTables(staging);
  // after the wraps: the front matter's own table is not a document table
  if (yaml !== null) staging.prepend(fm.build(yaml));
  return staging;
}

export async function render(doc: MarkdownDoc, article: HTMLElement): Promise<void> {
  const staging = await renderFragment(doc);
  article.replaceChildren(...staging.childNodes);
}

async function rewriteImages(root: HTMLElement, dir: string): Promise<void> {
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (src && !/^(https?:|data:|blob:|asset:)/i.test(src)) {
        try {
          const abs = await resolvePath(dir, decodeURIComponent(src));
          img.src = convertFileSrc(abs);
        } catch {
          markMissing(img);
          if (!img.alt) img.alt = src;
          return;
        }
      }
      watchForLoadFailure(img);
    }),
  );
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
    btn.title = "Copy";
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
    btn.title = "Copy table (for Excel)";
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
