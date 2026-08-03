// Path comparisons are case-insensitive: Windows filesystems are.

export const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export function isInside(parent: string, child: string): boolean {
  const p = parent.toLowerCase().replace(/[\\/]+$/, "");
  const c = child.toLowerCase();
  return c === p || c.startsWith(`${p}\\`) || c.startsWith(`${p}/`);
}
