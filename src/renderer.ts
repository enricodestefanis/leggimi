import MarkdownIt from "markdown-it";
import anchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import { convertFileSrc } from "@tauri-apps/api/core";

import { resolvePath, type MarkdownDoc } from "./ipc";

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
  .use(taskLists, { label: true });

export async function render(doc: MarkdownDoc, article: HTMLElement): Promise<void> {
  const clean = DOMPurify.sanitize(md.render(doc.content));
  const staging = document.createElement("div");
  staging.innerHTML = clean;
  await rewriteImages(staging, doc.dir);
  wrapCodeBlocks(staging);
  wrapTables(staging);
  article.replaceChildren(...staging.childNodes);
}

async function rewriteImages(root: HTMLElement, dir: string): Promise<void> {
  const imgs = [...root.querySelectorAll("img")];
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || /^(https?:|data:|blob:|asset:)/i.test(src)) return;
      try {
        const abs = await resolvePath(dir, decodeURIComponent(src));
        img.src = convertFileSrc(abs);
      } catch {
        img.classList.add("img-missing");
        if (!img.alt) img.alt = src;
      }
    }),
  );
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
    btn.title = "Copia";
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

function wrapTables(root: HTMLElement): void {
  for (const table of root.querySelectorAll("table")) {
    const scroll = document.createElement("div");
    scroll.className = "table-scroll";
    table.replaceWith(scroll);
    scroll.append(table);
  }
}
