import { t } from "./i18n";
import { namesAssetHost } from "./reach";

type MermaidModule = typeof import("mermaid")["default"];

let mermaid: MermaidModule | null = null;
let seq = 0;

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
    return svg;
  } catch (err) {
    // mermaid can leave a stray error node in <body>
    document.getElementById(`d${id}`)?.remove();
    throw err;
  }
}

export async function renderMermaidIn(article: HTMLElement, dark: boolean): Promise<void> {
  const codes = [...article.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (codes.length === 0) return;
  for (const code of codes) {
    const pre = code.parentElement as HTMLPreElement;
    const source = code.textContent ?? "";
    const holder = document.createElement("div");
    holder.className = "mermaid-diagram";
    // keep the scroll-sync anchor alive on the diagram that replaces the fence
    if (code.dataset.sourceLine) holder.dataset.sourceLine = code.dataset.sourceLine;
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
    try {
      holder.innerHTML = await renderMermaidSvg(holder.dataset.mmdSource ?? "", dark);
    } catch {
      /* keep the diagram that is already on screen */
    }
  }
}
