// Turning the rendered article into shareable output: rich-text clipboard
// copy and a self-contained HTML export.

import markdownCss from "./styles/markdown.css?inline";
import codeCss from "./styles/code.css?inline";
import katexCss from "katex/dist/katex.min.css?inline";

// The export carries its own light-theme tokens so markdown.css/code.css
// resolve outside the app. Kept in sync with base.css by hand.
const EXPORT_BASE_CSS = `
:root {
  color-scheme: light;
  --ease: cubic-bezier(0.25, 0.1, 0.25, 1);
  --bg: #faf9f5;
  --surface: #ffffff;
  --surface-2: #f0efe9;
  --text: #1a1915;
  --text-muted: #6e6e69;
  --border: #e8e6df;
  --accent: #c15f3c;
  --accent-soft: rgba(193, 95, 60, 0.1);
  --code-bg: #f5f4ef;
  --sans: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  --mono: ui-monospace, "Cascadia Code", "Cascadia Mono", Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: var(--sans);
  font-size: 16px;
  background: var(--bg);
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
article { max-width: 760px; margin: 0 auto; padding: 48px 32px 96px; }
@media print {
  body { background: #fff; }
  article { max-width: none; padding: 0; }
  .code-block, .table-scroll, .mermaid-diagram, .markdown-alert, img { break-inside: avoid; }
}
`;

// App-only affordances (copy buttons, sync anchors) don't belong in output.
function cleanedClone(article: HTMLElement): HTMLElement {
  const clone = article.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll(".code-copy")) el.remove();
  for (const el of clone.querySelectorAll("[data-source-line]")) el.removeAttribute("data-source-line");
  for (const el of clone.querySelectorAll("[data-mmd-source]")) el.removeAttribute("data-mmd-source");
  return clone;
}

// Local images are served via the asset protocol, which no other app can
// resolve — embed them as data URIs so output stands alone. Web URLs stay.
async function inlineImages(root: HTMLElement): Promise<void> {
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:") || /^https?:/i.test(src)) return;
      try {
        const blob = await (await fetch(src)).blob();
        img.src = await blobToDataUri(blob);
      } catch {
        /* keep the original src */
      }
    }),
  );
}

const blobToDataUri = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });

export async function copyAsRichText(article: HTMLElement): Promise<void> {
  const clone = cleanedClone(article);
  await inlineImages(clone);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([clone.innerHTML], { type: "text/html" }),
      "text/plain": new Blob([article.textContent ?? ""], { type: "text/plain" }),
    }),
  ]);
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function buildStandaloneHtml(article: HTMLElement, title: string): Promise<string> {
  const clone = cleanedClone(article);
  await inlineImages(clone);
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${EXPORT_BASE_CSS}\n${markdownCss}\n${codeCss}\n${katexCss}</style>`,
    "</head>",
    "<body>",
    `<article class="markdown-body">${clone.innerHTML}</article>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
