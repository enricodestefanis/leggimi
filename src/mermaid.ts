type MermaidModule = typeof import("mermaid")["default"];

let mermaid: MermaidModule | null = null;
let seq = 0;

async function load(dark: boolean): Promise<MermaidModule> {
  if (!mermaid) mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: dark ? "dark" : "neutral",
    fontFamily: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif',
  });
  return mermaid;
}

export async function renderMermaidIn(article: HTMLElement, dark: boolean): Promise<void> {
  const codes = [...article.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (codes.length === 0) return;
  const m = await load(dark);
  for (const code of codes) {
    const pre = code.parentElement as HTMLPreElement;
    const source = code.textContent ?? "";
    const holder = document.createElement("div");
    holder.className = "mermaid-diagram";
    pre.replaceWith(holder);

    const id = `mmd-${++seq}`;
    try {
      const { svg } = await m.render(id, source);
      holder.innerHTML = svg;
      holder.dataset.mmdSource = source;
    } catch (err) {
      // mermaid can leave a stray error node in <body>
      document.getElementById(`d${id}`)?.remove();
      const banner = document.createElement("div");
      banner.className = "mermaid-error";
      banner.textContent = `Invalid Mermaid diagram: ${err instanceof Error ? err.message : String(err)}`;
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
  const m = await load(dark);
  for (const holder of holders) {
    const id = `mmd-${++seq}`;
    try {
      const { svg } = await m.render(id, holder.dataset.mmdSource ?? "");
      holder.innerHTML = svg;
    } catch {
      document.getElementById(`d${id}`)?.remove();
    }
  }
}
