export interface ScrollAnchor {
  id: string;
  offset: number;
}

// Anchor the scroll position to the nearest heading above the viewport top:
// more robust than a raw scrollTop when the re-rendered content changes length.
export function captureScrollAnchor(pane: HTMLElement, article: HTMLElement): ScrollAnchor {
  const paneTop = pane.getBoundingClientRect().top;
  let best: ScrollAnchor | null = null;
  for (const h of article.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4,h5,h6)[id]")) {
    const delta = h.getBoundingClientRect().top - paneTop;
    if (delta <= 8) best = { id: h.id, offset: -delta };
    else break;
  }
  return best ?? { id: "", offset: pane.scrollTop };
}

export function restoreScrollAnchor(pane: HTMLElement, article: HTMLElement, anchor: ScrollAnchor): void {
  if (anchor.id) {
    const h = article.querySelector<HTMLElement>(`[id="${CSS.escape(anchor.id)}"]`);
    if (h) {
      const paneTop = pane.getBoundingClientRect().top;
      pane.scrollTop += h.getBoundingClientRect().top - paneTop - anchor.offset;
      return;
    }
  }
  pane.scrollTop = Math.min(anchor.offset, pane.scrollHeight - pane.clientHeight);
}
