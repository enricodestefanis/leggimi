// Reading position per file: reopening a document scrolls back to where it
// was left. Stored as the heading anchor state.ts already uses for reloads
// (robust to the document changing length), keyed by the canonical path.
import type { ScrollAnchor } from "./state";

const KEY = "read-positions";
const MAX = 100;

interface Entry extends ScrollAnchor {
  at: number; // last update, ms since the epoch (eviction order)
}

type Store = Record<string, Entry>;

const norm = (path: string) => path.toLowerCase();

function load(): Store {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return raw && typeof raw === "object" ? (raw as Store) : {};
  } catch {
    return {};
  }
}

function save(store: Store): void {
  const keys = Object.keys(store);
  if (keys.length === 0) {
    localStorage.removeItem(KEY);
    return;
  }
  localStorage.setItem(KEY, JSON.stringify(store));
}

export function remember(path: string, anchor: ScrollAnchor): void {
  const store = load();
  const key = norm(path);
  const atTop = !anchor.id && anchor.offset <= 0;
  if (atTop) {
    if (key in store) {
      delete store[key];
      save(store);
    }
    return;
  }
  store[key] = { ...anchor, at: Date.now() };
  const keys = Object.keys(store);
  if (keys.length > MAX) {
    keys.sort((a, b) => store[a].at - store[b].at);
    for (const k of keys.slice(0, keys.length - MAX)) delete store[k];
  }
  save(store);
}

export function recall(path: string): ScrollAnchor | null {
  const e = load()[norm(path)];
  if (!e) return null;
  return { id: typeof e.id === "string" ? e.id : "", offset: Number(e.offset) || 0 };
}

export function forget(path: string): void {
  const store = load();
  if (norm(path) in store) {
    delete store[norm(path)];
    save(store);
  }
}
