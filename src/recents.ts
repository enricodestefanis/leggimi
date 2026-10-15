// Recently opened documents, shown on the empty screen. Most recent first,
// one entry per path, capped. Paths that no longer exist are filtered out by
// the caller (existing_paths) at display time, not here.
export interface RecentFile {
  path: string;
  name: string;
  dir: string;
  openedAt: number; // ms since the epoch
}

const KEY = "recent-files";
const MAX = 12;

const samePath = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function list(): RecentFile[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (r): r is RecentFile =>
        r && typeof r.path === "string" && typeof r.name === "string" && typeof r.dir === "string",
    );
  } catch {
    return [];
  }
}

function save(items: RecentFile[]): void {
  if (items.length === 0) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(items));
}

export function push(doc: { path: string; dir: string }): void {
  const name = doc.path.split(/[\\/]/).pop() ?? doc.path;
  const rest = list().filter((r) => !samePath(r.path, doc.path));
  save([{ path: doc.path, name, dir: doc.dir, openedAt: Date.now() }, ...rest].slice(0, MAX));
}

export function remove(path: string): void {
  save(list().filter((r) => !samePath(r.path, path)));
}

export function clear(): void {
  save([]);
}

export { relativeTime } from "./i18n";
