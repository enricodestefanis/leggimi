// Turning the rendered article into shareable output: rich-text clipboard
// copy, a Word document and a self-contained HTML export.

import { asBlob } from "html-docx-js-typescript";

import { rerenderForTheme } from "./mermaid";

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
function cleanedClone(article: HTMLElement, docDir: string): HTMLElement {
  const clone = article.cloneNode(true) as HTMLElement;
  for (const el of clone.querySelectorAll(".code-copy")) el.remove();
  for (const el of clone.querySelectorAll("[data-source-line]")) el.removeAttribute("data-source-line");
  for (const el of clone.querySelectorAll("[data-mmd-source]")) el.removeAttribute("data-mmd-source");
  absolutizeLinks(clone, docDir);
  return clone;
}

// Relative links (other .md files, mostly) only resolve inside the app;
// outside it they must point at the file itself. Web URLs and #anchors stay.
function absolutizeLinks(root: HTMLElement, docDir: string): void {
  for (const a of root.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (!href || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
    a.setAttribute("href", toFileUrl(docDir, href));
  }
}

function toFileUrl(dir: string, rel: string): string {
  const joined = `${dir}\\${decodeURIComponent(rel)}`.replace(/\//g, "\\");
  const segs: string[] = [];
  for (const s of joined.split("\\")) {
    if (!s || s === ".") continue;
    if (s === "..") segs.pop();
    else segs.push(s);
  }
  return encodeURI(`file:///${segs.join("/")}`);
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

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ---- shared Word-family preparation (clipboard copy + DOCX) ---- */

// Word can't lay out KaTeX's HTML spans or draw inline SVG: hand it MathML
// (converted to native equations on open) and PNG renderings of diagrams.
async function preparePortableClone(article: HTMLElement, docDir: string): Promise<HTMLElement> {
  const clone = cleanedClone(article, docDir);
  await inlineImages(clone);
  for (const el of clone.querySelectorAll(".katex-html")) el.remove();
  await replaceMermaidWithPng(article, clone);
  return clone;
}

// Rasterization reads the live, laid-out SVGs (a detached clone has no
// geometry). From dark theme those SVGs are light-on-dark — unreadable on
// a white page — so diagrams briefly re-render neutral for the snapshot.
async function replaceMermaidWithPng(article: HTMLElement, clone: HTMLElement): Promise<void> {
  const cloneDiagrams = clone.querySelectorAll<HTMLElement>(".mermaid-diagram");
  if (cloneDiagrams.length === 0) return;
  const dark = document.documentElement.dataset.theme === "dark";
  if (dark) await rerenderForTheme(article, false);
  try {
    const liveDiagrams = article.querySelectorAll<HTMLElement>(".mermaid-diagram");
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
        // paste-safe stand-in for the app's flex centering
        cloneDiagrams[i].style.textAlign = "center";
        cloneDiagrams[i].style.margin = "0 0 16px";
      } catch {
        /* leave the SVG in; recent Word builds may still show it */
      }
    }
  } finally {
    if (dark) rerenderForTheme(article, true).catch(() => {});
  }
}

// GitHub's palette, baked into inline styles because Word's HTML filter
// applies stylesheet classes unreliably. Symbols replace the SVG octicons
// Word drops.
const WORD_ALERTS: Record<string, { color: string; symbol: string }> = {
  "markdown-alert-note": { color: "#0969da", symbol: "ℹ️" },
  "markdown-alert-tip": { color: "#1a7f37", symbol: "💡" },
  "markdown-alert-important": { color: "#8250df", symbol: "❗" },
  "markdown-alert-warning": { color: "#9a6700", symbol: "⚠️" },
  "markdown-alert-caution": { color: "#cf222e", symbol: "⛔" },
};

// the app's 5% color-mix tints, precomputed flat over white — Word's HTML
// filter mangles rgba() and color-mix()
const ALERT_BG: Record<string, string> = {
  "markdown-alert-note": "#f3f8fd",
  "markdown-alert-tip": "#f4f9f5",
  "markdown-alert-important": "#f9f6fd",
  "markdown-alert-warning": "#faf7f2",
  "markdown-alert-caution": "#fdf4f5",
};

// border/padding only when unset: on the copy path the style map has
// already applied the app's px values, on the DOCX path these pt values win
function wordifyAlerts(root: HTMLElement): void {
  for (const alert of root.querySelectorAll<HTMLElement>(".markdown-alert")) {
    const type = [...alert.classList].find((c) => c in WORD_ALERTS) ?? "markdown-alert-note";
    const { color, symbol } = WORD_ALERTS[type];
    if (!alert.style.borderLeft) alert.style.borderLeft = `3pt solid ${color}`;
    if (!alert.style.paddingLeft) alert.style.paddingLeft = "8pt";
    const title = alert.querySelector<HTMLElement>(".markdown-alert-title");
    if (title) {
      for (const svg of title.querySelectorAll("svg")) svg.remove();
      title.style.color = color;
      title.prepend(document.createTextNode(`${symbol} `));
    }
  }
}

// Word drops <input> checkboxes, leaving bare bullets: rewrite task lists
// as paragraphs with ballot-box symbols. Inner lists first, so nesting
// survives as its own block.
function wordifyTaskLists(root: HTMLElement): void {
  for (const list of [...root.querySelectorAll("ul.contains-task-list")].reverse()) {
    const holder = document.createElement("div");
    holder.style.margin = "0 0 12px";
    for (const li of list.querySelectorAll<HTMLElement>(":scope > li.task-list-item")) {
      const box = li.querySelector("input.task-list-item-checkbox");
      const done = box?.hasAttribute("checked") ?? false;
      box?.remove();
      const p = document.createElement("p");
      p.style.margin = "0 0 4pt";
      p.innerHTML = `${done ? "☑" : "☐"}&nbsp; ${li.innerHTML}`;
      holder.append(p);
    }
    list.replaceWith(holder);
  }
}

/* ---- rich-text clipboard copy ---- */

const SANS = "'Segoe UI', system-ui, -apple-system, sans-serif";
const MONO = "Consolas, 'Cascadia Mono', Menlo, monospace";

type StyleMap = ReadonlyArray<readonly [selector: string, declarations: string]>;

// First-set-wins per property: specific selectors precede generic ones, and
// passes that ran earlier keep their values. Discipline for map entries:
// shorthands only (margin/padding) — longhand overrides belong to the JS
// passes that run after the map — and no colons or semicolons in values.
function applyInlineStyles(root: HTMLElement, map: StyleMap): void {
  for (const [selector, declarations] of map) {
    for (const el of root.querySelectorAll<HTMLElement>(selector)) {
      for (const decl of declarations.split(";")) {
        const colon = decl.indexOf(":");
        if (colon < 0) continue;
        const prop = decl.slice(0, colon).trim();
        const value = decl.slice(colon + 1).trim();
        if (!el.style.getPropertyValue(prop)) el.style.setProperty(prop, value);
      }
    }
  }
}

// The viewer's light theme (markdown.css/code.css) translated to inline
// styles paste targets keep: px against the 16px base, flat hex only.
const COPY_STYLES: StyleMap = [
  // a quote's last block keeps no trailing gap — must precede p/ul entries
  ["blockquote > :last-child", "margin:0"],

  // hljs — GitHub Light, mirrored from code.css; the compound selector
  // first so .language_ wins over the generic .hljs-variable rule
  [".hljs-variable.language_", "color:#cf222e"],
  [".hljs-doctag, .hljs-keyword, .hljs-template-tag, .hljs-template-variable, .hljs-type", "color:#cf222e"],
  [".hljs-title", "color:#8250df"],
  [".hljs-string, .hljs-regexp", "color:#0a3069"],
  [
    ".hljs-attr, .hljs-attribute, .hljs-literal, .hljs-meta, .hljs-number, .hljs-operator, " +
      ".hljs-selector-attr, .hljs-selector-class, .hljs-selector-id, .hljs-variable",
    "color:#0550ae",
  ],
  [".hljs-built_in, .hljs-symbol, .hljs-bullet", "color:#953800"],
  [".hljs-comment, .hljs-code, .hljs-formula", "color:#6e7781"],
  [".hljs-name, .hljs-quote, .hljs-selector-tag, .hljs-selector-pseudo", "color:#116329"],
  [".hljs-subst", "color:#24292f"],
  [".hljs-section", "color:#0550ae;font-weight:600"],
  [".hljs-emphasis", "font-style:italic"],
  [".hljs-strong", "font-weight:600"],
  [".hljs-addition", "color:#116329;background-color:#dafbe1"],
  [".hljs-deletion", "color:#82071e;background-color:#ffebe9"],

  ["h1", "font-size:30px;font-weight:700;line-height:1.3;margin:36px 0 18px;color:#1a1915"],
  ["h2", "font-size:22px;font-weight:650;line-height:1.3;margin:45px 0 16px;padding:0 0 7px;border-bottom:1px solid #e8e6df;color:#1a1915"],
  ["h3", "font-size:19px;font-weight:600;line-height:1.3;margin:30px 0 9px;color:#1a1915"],
  ["h4, h5, h6", "font-size:16px;font-weight:600;line-height:1.3;margin:22px 0 6px;color:#1a1915"],
  [".markdown-alert-title", "font-weight:600;font-size:15px;margin:0 0 6px"],
  ["p", "margin:0 0 16px"],
  ["a", "color:#c15f3c;text-decoration:none"],
  ["li > ul, li > ol", "margin:5px 0 0"],
  ["ul, ol", "margin:0 0 16px;padding-left:26px"],
  ["li", "margin:0 0 5px"],
  ["blockquote", "margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid #c15f3c;color:#6e6e69"],
  // longhands kept disjoint: a border shorthand would block border-top here
  ["hr", "border-top:1px solid #e8e6df;border-bottom:none;border-left:none;border-right:none;margin:32px 0"],
  ["img", "max-width:100%;border-radius:6px"],
  ["thead th", "background:#f0efe9;font-weight:600"],
  ["th, td", "padding:8px 14px;border-bottom:1px solid #e8e6df;text-align:left;vertical-align:top;font-size:15px"],
  ["table", "border-collapse:collapse;width:100%;margin:0 0 16px;border:1px solid #e8e6df"],
  ["code", `font-family:${MONO}`],
  // block code still sits in <pre> when the map runs, so this is inline code
  [":not(pre) > code", "background:#f5f4ef;border:1px solid #e8e6df;border-radius:4px;padding:1px 5px;font-size:13.5px"],
  ["kbd", `font-family:${MONO};font-size:13.5px;background:#f0efe9;border:1px solid #e8e6df;border-radius:5px;padding:1px 6px`],
  ["s, del", "text-decoration:line-through"],

  [".markdown-alert", "margin:0 0 16px;padding:6px 16px 2px;border-radius:0 8px 8px 0"],
  ...Object.entries(WORD_ALERTS).map(
    ([type, { color }]) =>
      [`.${type}`, `border-left:3px solid ${color};background:${ALERT_BG[type]}`] as const,
  ),
  [".katex-display", "display:block;text-align:center;margin:16px 0"],
  [".mermaid-error", "margin:0 0 10px;padding:8px 12px;border:1px solid #c15f3c;border-radius:8px;background:#f9efec;font-size:14px"],
];

// the scroll wrapper means nothing to paste targets; its border lives on
// the table entry in the map
function unwrapTableScrolls(root: HTMLElement): void {
  for (const w of root.querySelectorAll(".table-scroll")) w.replaceWith(...w.childNodes);
}

// hljs spans can cross line boundaries, so this walks text nodes instead of
// doing string surgery on markup: newlines become <br>, indentation becomes
// nbsp (tabs = 4). Interior spaces stay soft so long lines can still wrap;
// with no raw newlines left, no paste target can double-space the block.
function hardenWhitespace(code: HTMLElement): void {
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const NBSP = "\u00a0";
  let atLineStart = true;
  for (const node of nodes) {
    const text = node.nodeValue ?? "";
    if (!text) continue;
    if (!/[\n\t]/.test(text) && !(atLineStart && text.startsWith(" "))) {
      atLineStart = false;
      continue;
    }
    const frag = document.createDocumentFragment();
    let run = "";
    const flush = () => {
      if (run) {
        frag.append(document.createTextNode(run));
        run = "";
      }
    };
    for (const ch of text) {
      if (ch === "\n") {
        flush();
        frag.append(document.createElement("br"));
        atLineStart = true;
      } else if (ch === "\t") {
        run += NBSP.repeat(4);
      } else if (ch === " " && atLineStart) {
        run += NBSP;
      } else {
        run += ch;
        atLineStart = false;
      }
    }
    flush();
    node.replaceWith(frag);
  }
}

// Code blocks travel as single-cell tables: Word and Outlook shade table
// cells natively, while background/padding on <pre> degrades to bare
// paragraph shading. Runs after the style map, so the generic table/td
// entries never touch these.
function flattenCodeBlocks(root: HTMLElement): void {
  for (const block of root.querySelectorAll<HTMLElement>(".code-block")) {
    const code = block.querySelector<HTMLElement>("pre > code");
    if (!code) continue;
    hardenWhitespace(code);
    // the invalid-mermaid fallback block has no header — tolerate it
    const lang = block.querySelector(".code-lang")?.textContent?.trim().toLowerCase() ?? "";
    const table = document.createElement("table");
    table.setAttribute("cellspacing", "0");
    table.setAttribute("cellpadding", "0");
    table.style.cssText =
      "border-collapse:collapse;width:100%;margin:0 0 16px;border:1px solid #e8e6df;background:#f5f4ef;";
    if (lang) {
      const head = table.insertRow().insertCell();
      head.textContent = lang;
      head.style.cssText = `padding:4px 14px;border-bottom:1px solid #e8e6df;font-family:${MONO};font-size:11.5px;color:#6e6e69;text-align:left;vertical-align:top;`;
    }
    const body = table.insertRow().insertCell();
    body.style.cssText = `padding:12px 14px;font-family:${MONO};font-size:13.5px;line-height:1.55;color:#1a1915;text-align:left;vertical-align:top;`;
    body.append(...code.childNodes);
    if (body.lastChild instanceof HTMLBRElement) body.lastChild.remove();
    block.replaceWith(table);
  }
}

// Paste targets don't reliably inherit from a wrapper div — Word resolves
// blocks against its own styles, Google Docs flattens per paragraph — so
// every text block carries its own base, filling only what earlier passes
// left unset. Quoted text keeps the muted color the app inherits via CSS.
function stampBaseStyles(root: HTMLElement): void {
  for (const el of root.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, td, th, blockquote")) {
    if (!el.style.getPropertyValue("font-family")) el.style.setProperty("font-family", SANS);
    if (!el.style.getPropertyValue("color")) {
      el.style.setProperty("color", el.closest("blockquote") ? "#6e6e69" : "#1a1915");
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>("p, li, blockquote")) {
    if (!el.style.getPropertyValue("font-size")) el.style.setProperty("font-size", "16px");
    if (!el.style.getPropertyValue("line-height")) el.style.setProperty("line-height", "1.7");
  }
}

// ~700 class attributes of dead weight that can only confuse paste filters
// (KaTeX's clip-hiding, for one). Heading ids stay: they become Word
// bookmarks, and absolutizeLinks keeps #anchor hrefs pointing at them.
function stripClasses(root: HTMLElement): void {
  for (const el of root.querySelectorAll("[class]")) el.removeAttribute("class");
}

export async function copyAsRichText(
  article: HTMLElement,
  docDir: string,
  plainText: string,
): Promise<void> {
  const clone = await preparePortableClone(article, docDir);
  unwrapTableScrolls(clone);
  applyInlineStyles(clone, COPY_STYLES);
  wordifyAlerts(clone);
  wordifyTaskLists(clone);
  flattenCodeBlocks(clone);
  stampBaseStyles(clone);
  stripClasses(clone);
  const wrapper = document.createElement("div");
  wrapper.style.cssText = `font-family:${SANS};font-size:16px;line-height:1.7;color:#1a1915;`;
  wrapper.append(...clone.childNodes);
  (wrapper.firstElementChild as HTMLElement | null)?.style.setProperty("margin-top", "0");
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([wrapper.outerHTML], { type: "text/html" }),
      "text/plain": new Blob([plainText], { type: "text/plain" }),
    }),
  ]);
}

/* ---- DOCX export ---- */

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
.markdown-alert-title { font-weight: bold; }
img { max-width: 100%; }
a { color: #c15f3c; }
`;

export async function buildDocxBase64(
  article: HTMLElement,
  title: string,
  docDir: string,
): Promise<string> {
  const clone = await preparePortableClone(article, docDir);
  wordifyAlerts(clone);
  wordifyTaskLists(clone);
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

export async function buildStandaloneHtml(
  article: HTMLElement,
  title: string,
  docDir: string,
): Promise<string> {
  const clone = cleanedClone(article, docDir);
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
