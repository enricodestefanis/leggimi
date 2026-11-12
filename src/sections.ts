// The outline as a tree, for the path of the section being read
// (sectionLine.ts): every heading's parent is the nearest heading before it
// with a smaller level, so a skipped level (an H3 right under an H1) still
// hangs from the H1, and a heading before any smaller one is a root.
//
// The document's title is left out of every path: a document with exactly
// one H1, which is also its first heading, is titled by it, and "Brief ›
// 2. Decisioni › 2.1 Budget" would repeat it in every section. Several H1s
// are parts of the document, and stay in.

export interface Outline {
  /** each heading's level, 1–6, in document order */
  level: number[];
  /** the index of each heading's parent, -1 for a root */
  parent: number[];
  /** the index of the document title heading, or -1 */
  title: number;
}

/** The tree of the headings whose levels are given, in document order. */
export function outline(levels: readonly number[]): Outline {
  const parent: number[] = [];
  // the headings still open, their levels increasing towards the end
  const open: number[] = [];
  levels.forEach((lv, i) => {
    while (open.length > 0 && levels[open[open.length - 1]] >= lv) open.pop();
    parent.push(open.length > 0 ? open[open.length - 1] : -1);
    open.push(i);
  });
  const h1s = levels.reduce((n, lv) => (lv === 1 ? n + 1 : n), 0);
  return { level: [...levels], parent, title: h1s === 1 && levels[0] === 1 ? 0 : -1 };
}

/** Heading i and the headings it sits under, outermost first, the title left out. */
export function pathOf(o: Outline, i: number): number[] {
  const path: number[] = [];
  if (!Number.isInteger(i) || i < 0 || i >= o.parent.length) return path;
  // a parent always comes before its child: the walk ends
  for (let k = i; k >= 0; k = o.parent[k]) if (k !== o.title) path.push(k);
  return path.reverse();
}
