// Path comparisons are case-insensitive: Windows filesystems are.

export const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function isInside(parent: string, child: string): boolean {
  const p = parent.toLowerCase().replace(/[\\/]+$/, "");
  const c = child.toLowerCase();
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}

/** `to` relative to `fromDir`, with forward slashes, for a Markdown link (absolute across drives). */
export function relativePath(fromDir: string, to: string): string {
  const a = fromDir.split(/[\\/]+/).filter(Boolean);
  const b = to.split(/[\\/]+/).filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
  if (i === 0) return to.replace(/\\/g, "/"); // different drives: absolute
  return [...Array(a.length - i).fill(".."), ...b.slice(i)].join("/");
}

/** A path as a link's URL: spaces encoded, and "#" and "?" kept part of the name. */
export const linkUrl = (path: string): string => encodeURI(path).replace(/[?#]/g, (c) => encodeURIComponent(c));
