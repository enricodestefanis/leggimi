// Turning the rendered article into shareable output: rich-text clipboard
// copy and a self-contained HTML export.

import { asBlob } from "html-docx-js-typescript";

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

// Local images are served via the asset protocol (asset: or the
// http://asset.localhost bridge), which no other app can resolve — embed
// them as data URIs so output stands alone. Real web URLs stay linked.
const isAssetUrl = (src: string) =>
  /^asset:/i.test(src) || /^https?:\/\/asset\.localhost/i.test(src);

async function inlineImages(root: HTMLElement): Promise<void> {
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) return;
      if (!isAssetUrl(src) && /^https?:/i.test(src)) return;
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

// Word's HTML filter understands only simple CSS: point sizes, borders,
// system fonts. The app stylesheets stay out of this on purpose.
const DOCX_CSS = `
body { font-family: "Segoe UI", Calibri, sans-serif; font-size: 11pt; color: #1a1915; }
h1 { font-size: 20pt; } h2 { font-size: 15pt; } h3 { font-size: 12.5pt; }
pre, code { font-family: Consolas, "Courier New", monospace; font-size: 9.5pt; }
pre { background: #f5f4ef; padding: 8pt; }
.code-lang { color: #888888; font-size: 8pt; }
table { border-collapse: collapse; }
th, td { border: 1pt solid #cccccc; padding: 4pt 8pt; text-align: left; }
th { background: #f0efe9; }
blockquote { border-left: 3pt solid #c15f3c; padding-left: 8pt; margin-left: 0; color: #555555; }
.markdown-alert { border-left: 3pt solid #0969da; padding-left: 8pt; }
.markdown-alert-title { font-weight: bold; color: #0969da; }
img { max-width: 100%; }
a { color: #c15f3c; }
`;

// Word can't lay out KaTeX's HTML spans or draw inline SVG: hand it MathML
// (converted to native equations on open) and PNG renderings of diagrams.
export async function buildDocxBase64(article: HTMLElement, title: string): Promise<string> {
  const clone = cleanedClone(article);
  await inlineImages(clone);
  for (const el of clone.querySelectorAll(".katex-html")) el.remove();
  const liveDiagrams = article.querySelectorAll<HTMLElement>(".mermaid-diagram");
  const cloneDiagrams = clone.querySelectorAll<HTMLElement>(".mermaid-diagram");
  for (let i = 0; i < cloneDiagrams.length; i++) {
    const svg = liveDiagrams[i]?.querySelector("svg");
    if (!svg) continue;
    try {
      const png = await rasterizeSvg(svg);
      const img = document.createElement("img");
      img.src = png.dataUrl;
      img.width = png.width;
      img.height = png.height;
      cloneDiagrams[i].replaceChildren(img);
    } catch {
      /* leave the SVG in; recent Word builds may still show it */
    }
  }
  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<title>${escapeHtml(title)}</title><style>${DOCX_CSS}</style></head>` +
    `<body>${clone.innerHTML}</body></html>`;
  const blob = (await asBlob(html, { orientation: "portrait" })) as Blob;
  return arrayBufferToBase64(await blob.arrayBuffer());
}

// drawn from the live, laid-out SVG: a detached clone has no geometry
function rasterizeSvg(svg: SVGSVGElement): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const rect = svg.getBoundingClientRect();
    const xml = new XMLSerializer().serializeToString(svg);
    const img = new Image();
    img.onload = () => {
      const w = Math.round(img.naturalWidth || rect.width || 800);
      const h = Math.round(img.naturalHeight || rect.height || 400);
      const scale = 2; // crisp on print and hi-dpi
      const canvas = document.createElement("canvas");
      canvas.width = w * scale;
      canvas.height = h * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas unavailable"));
        return;
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, w, h);
      resolve({ dataUrl: canvas.toDataURL("image/png"), width: w, height: h });
    };
    img.onerror = () => reject(new Error("SVG rasterization failed"));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  });
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000; // String.fromCharCode argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

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
