export interface ScrollAnchor {
  /** the heading the place hangs from; "" when there is none above it */
  id: string;
  /** with an id: how far above the pane's top that heading sat; without: the pane's scrollTop */
  offset: number;
  /**
   * the pane's scrollTop when the place was taken (2.3): where a reload of the same document
   * goes back to when its heading is gone (renamed while being read). Absent in positions
   * remembered by older versions.
   */
  top?: number;
}

const uriSafe = (fn: (s: string) => string, s: string): string => {
  try {
    return fn(s);
  } catch {
    return s; // a stray "%" or a lone surrogate stays as it is
  }
};

/**
 * The element a #link or a remembered position names. Every spelling of `id`
 * is tried (as given, percent-encoded, percent-decoded): first as an id, or
 * as the name an id the app's UI also uses was written with (data-anchor, see
 * renderer.ts); only then as a heading's id before 1.15.1 (data-legacy-id),
 * which reading positions saved then still hold.
 */
export function findHeading(root: ParentNode, id: string): HTMLElement | null {
  if (!id) return null;
  const spellings = [...new Set([id, uriSafe(encodeURIComponent, id), uriSafe(decodeURIComponent, id)])].map((s) =>
    CSS.escape(s),
  );
  for (const attrs of [["id", "data-anchor"], ["data-legacy-id"]]) {
    for (const s of spellings) {
      const el = root.querySelector<HTMLElement>(attrs.map((a) => `[${a}="${s}"]`).join(", "));
      if (el) return el;
    }
  }
  return null;
}

// Anchor the scroll position to the nearest heading above the viewport top:
// more robust than a raw scrollTop when the re-rendered content changes length.
export function captureScrollAnchor(pane: HTMLElement, article: HTMLElement): ScrollAnchor {
  const paneTop = pane.getBoundingClientRect().top;
  let best: ScrollAnchor | null = null;
  for (const h of article.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4,h5,h6)[id]")) {
    const delta = h.getBoundingClientRect().top - paneTop;
    if (delta <= 8) best = { id: h.id, offset: -delta, top: pane.scrollTop };
    else break;
  }
  return best ?? { id: "", offset: pane.scrollTop, top: pane.scrollTop };
}

export function restoreScrollAnchor(pane: HTMLElement, article: HTMLElement, anchor: ScrollAnchor): void {
  if (anchor.id) {
    const h = findHeading(article, anchor.id);
    if (h) {
      // offset is how far ABOVE the pane's top edge the heading sat (-delta at
      // capture): put it back there, i.e. scroll until top - paneTop == -offset
      const paneTop = pane.getBoundingClientRect().top;
      pane.scrollTop += h.getBoundingClientRect().top - paneTop + anchor.offset;
      return;
    }
  }
  // with an id, offset is a distance from the heading, not a place: only `top` is one
  const top = anchor.id ? anchor.top : anchor.offset;
  if (top !== undefined) pane.scrollTop = Math.min(top, pane.scrollHeight - pane.clientHeight);
}
