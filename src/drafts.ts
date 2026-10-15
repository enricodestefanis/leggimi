// Crash-recovery drafts: the unsaved editor buffer is parked in localStorage
// while it is dirty, and offered back when the same file is opened again.
// The draft never writes the file by itself; restoring it only fills the
// editor, and the user still saves with Ctrl+S.
export interface Draft {
  text: string; // LF-normalized buffer
  at: number; // last update, ms since the epoch
  /** the file content the edits started from, to tell a stale draft apart */
  base: string;
}

const KEY = "drafts";
const MAX_ENTRIES = 20;
const MAX_TOTAL = 2_000_000; // characters, across all drafts

type Store = Record<string, Draft>;

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
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    /* quota: drop the oldest and retry once */
    keys.sort((a, b) => store[a].at - store[b].at);
    delete store[keys[0]];
    try {
      localStorage.setItem(KEY, JSON.stringify(store));
    } catch {
      /* give up silently: a draft is best effort */
    }
  }
}

export function put(path: string, text: string, base: string): void {
  const store = load();
  store[norm(path)] = { text, base, at: Date.now() };
  // newest first; evict by count, then by total size
  const keys = Object.keys(store).sort((a, b) => store[b].at - store[a].at);
  let total = 0;
  for (const k of keys) {
    total += store[k].text.length + store[k].base.length;
    if (keys.indexOf(k) >= MAX_ENTRIES || (total > MAX_TOTAL && k !== norm(path))) delete store[k];
  }
  save(store);
}

export function get(path: string): Draft | null {
  const d = load()[norm(path)];
  return d && typeof d.text === "string" ? d : null;
}

export function remove(path: string): void {
  const store = load();
  if (norm(path) in store) {
    delete store[norm(path)];
    save(store);
  }
}
