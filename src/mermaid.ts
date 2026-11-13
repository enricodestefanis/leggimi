import { t } from "./i18n";
import { namesAssetHost } from "./reach";

type MermaidModule = typeof import("mermaid")["default"];

let mermaid: MermaidModule | null = null;
let seq = 0;

// Diagrams already drawn, by scheme and source: a document read again (the file
// changed on disk, an edit in the preview, a tab coming back) gets them at once,
// at their own height, before the reading place is put back. Drawing them again
// one after another changed the heights under that place while it was being
// restored, and the text being read slid up (report C-01). The oldest go first.
const drawn = new Map<string, string>();
const DRAWN_MAX = 60;
// a dark drawing takes the page's own background (see load): Dark and Black differ
const pageBg = (): string => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
const keyOf = (source: string, dark: boolean): string => (dark ? `d\u0000${pageBg()}\u0000` : "l\u0000") + source;

function remember(source: string, dark: boolean, svg: string): void {
  const k = keyOf(source, dark);
  drawn.delete(k);
  drawn.set(k, svg);
  while (drawn.size > DRAWN_MAX) drawn.delete(drawn.keys().next().value as string);
}

async function load(dark: boolean): Promise<MermaidModule> {
  if (!mermaid) mermaid = (await import("mermaid")).default;
  // mermaid's dark theme draws edge labels on light grey boxes; the page background
  // makes them part of the page (the neutral theme's white box already fits light paper)
  const bg = dark ? getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() : "";
  // its palette also has two fills that are all but black, with no border: #0b0000 (a mind
  // map's first branch, a pie's first slice, a timeline's second period) and #161722 (the
  // ninth). On the black page the box and its edges were gone: the theme's own grey and a
  // lighter shade of the same blue take their place, the same on both dark pages. A Venn
  // diagram's second set, whose red mermaid makes out of the first of the two, stays red:
  // it sits next to a grey set, and a second grey would be told from it by nothing
  const scale = { cScale1: "#474949", cScale9: "#3a3c59", venn2: "#a40000" };
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "neutral",
    ...(bg ? { themeVariables: { edgeLabelBackground: bg, ...scale } } : {}),
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  });
  return mermaid;
}

// The single render entry point, so the id counter stays single-sourced: two
// SVGs sharing an id would make their url(#marker) references collide.
export async function renderMermaidSvg(source: string, dark: boolean): Promise<string> {
  // Mermaid lays a diagram out in the live page, with the diagram's own CSS, before any
  // sanitizer sees the SVG: one that names the asset protocol's host is not drawn (reach.ts)
  if (namesAssetHost(source)) throw new Error("a diagram cannot name the app's own file protocol");
  const m = await load(dark);
  const id = `mmd-${++seq}`;
  try {
    const { svg } = await m.render(id, source);
    remember(source, dark, svg);
    return svg;
  } catch (err) {
    // mermaid can leave a stray error node in <body>
    document.getElementById(`d${id}`)?.remove();
    throw err;
  }
}

function holderFor(code: HTMLElement, source: string): HTMLDivElement {
  const holder = document.createElement("div");
  holder.className = "mermaid-diagram";
  // keep the scroll-sync anchor alive on the diagram that replaces the fence
  if (code.dataset.sourceLine) holder.dataset.sourceLine = code.dataset.sourceLine;
  holder.dataset.mmdSource = source;
  return holder;
}

/**
 * The diagrams of `article` drawn before, put in place at once (no waiting): call it right
 * after the article's text changes and before the reading place is restored. A source that
 * appears twice is placed once; the copy is drawn afresh (two SVGs must not share ids).
 * Returns how many were placed; renderMermaidIn draws the rest.
 */
export function placeDrawnDiagrams(article: HTMLElement, dark: boolean): number {
  // a drawing already in the article (placed by an earlier call) counts as used
  const used = new Set<string>(
    [...article.querySelectorAll<HTMLElement>(".mermaid-diagram[data-mmd-source]")].map((h) => keyOf(h.dataset.mmdSource ?? "", dark)),
  );
  let n = 0;
  for (const code of article.querySelectorAll<HTMLElement>("pre > code.language-mermaid")) {
    const source = code.textContent ?? "";
    const k = keyOf(source, dark);
    const svg = drawn.get(k);
    if (svg === undefined || used.has(k)) continue;
    used.add(k);
    const holder = holderFor(code, source);
    holder.innerHTML = svg;
    (code.parentElement as HTMLPreElement).replaceWith(holder);
    n++;
  }
  return n;
}

export async function renderMermaidIn(article: HTMLElement, dark: boolean): Promise<void> {
  // before the first wait, so a caller that does not await still gets them in this task
  placeDrawnDiagrams(article, dark);
  const codes = [...article.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (codes.length === 0) return;
  for (const code of codes) {
    const pre = code.parentElement as HTMLPreElement;
    const source = code.textContent ?? "";
    const holder = holderFor(code, source);
    delete holder.dataset.mmdSource;
    pre.replaceWith(holder);

    try {
      holder.innerHTML = await renderMermaidSvg(source, dark);
      holder.dataset.mmdSource = source;
    } catch (err) {
      const banner = document.createElement("div");
      banner.className = "mermaid-error";
      banner.textContent = t("render.invalidMermaid", { err: err instanceof Error ? err.message : String(err) });
      // keep the source readable, styled like every other code block
      const block = document.createElement("div");
      block.className = "code-block";
      block.append(pre);
      holder.replaceWith(banner, block);
    }
  }
}

export async function rerenderForTheme(article: HTMLElement, dark: boolean): Promise<void> {
  const holders = [...article.querySelectorAll<HTMLElement>(".mermaid-diagram[data-mmd-source]")];
  if (holders.length === 0) return;
  for (const holder of holders) {
    const source = holder.dataset.mmdSource ?? "";
    try {
      // a diagram drawn before in that scheme comes back without the wait, unless the
      // same source shows twice in this article (two SVGs must not share ids)
      const k = keyOf(source, dark);
      const twice = holders.filter((h) => h.dataset.mmdSource === source).length > 1;
      const svg = !twice ? drawn.get(k) : undefined;
      holder.innerHTML = svg ?? (await renderMermaidSvg(source, dark));
    } catch {
      /* keep the diagram that is already on screen */
    }
  }
}
