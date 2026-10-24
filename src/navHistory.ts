// Back and Forward, per window, like a browser tab: the places left by
// following a link, opening another document or jumping through the outline.
// Kept in sessionStorage, which belongs to the window and survives the reload
// of a language change. (Not "history": that name is window.history.)
import type { ScrollAnchor } from "./state";

export interface Place {
  path: string;
  pos: ScrollAnchor;
}

const KEY = "nav-history";
const MAX = 50;

let back: Place[] = [];
let forward: Place[] = [];

const samePlace = (a: Place, b: Place): boolean =>
  a.path.toLowerCase() === b.path.toLowerCase() && a.pos.id === b.pos.id && Math.abs(a.pos.offset - b.pos.offset) < 4;

function save(): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ back, forward }));
  } catch {
    /* best effort: the lists still work for this page */
  }
}

const isPlace = (p: unknown): p is Place => {
  const q = p as Place | null;
  return !!q && typeof q.path === "string" && !!q.pos && typeof q.pos.id === "string" && typeof q.pos.offset === "number";
};

export function load(): void {
  try {
    const raw = JSON.parse(sessionStorage.getItem(KEY) ?? "null") as { back?: unknown; forward?: unknown } | null;
    back = Array.isArray(raw?.back) ? raw.back.filter(isPlace) : [];
    forward = Array.isArray(raw?.forward) ? raw.forward.filter(isPlace) : [];
  } catch {
    back = [];
    forward = [];
  }
}

/** The lists of the tab in front, for it to take along when another comes forward. */
export function exportState(): { back: Place[]; forward: Place[] } {
  return { back: [...back], forward: [...forward] };
}

/** A tab's own lists come back (empty for a new tab). */
export function importState(s: { back: Place[]; forward: Place[] } | null): void {
  back = s ? s.back.filter(isPlace) : [];
  forward = s ? s.forward.filter(isPlace) : [];
  save();
}

/** a new place was reached from `from`: it goes on the Back list, and Forward empties */
export function record(from: Place): void {
  const top = back[back.length - 1];
  if (!top || !samePlace(top, from)) back.push(from);
  if (back.length > MAX) back.splice(0, back.length - MAX);
  forward = [];
  save();
}

export const canBack = (): boolean => back.length > 0;
export const canForward = (): boolean => forward.length > 0;
export const peekBack = (): Place | undefined => back[back.length - 1];
export const peekForward = (): Place | undefined => forward[forward.length - 1];

// Called once the place is on screen (not before: the move can be cancelled,
// or the file can be gone): `current`, the place left, goes on the other list
export function commitBack(current: Place | null): void {
  back.pop();
  if (current) forward.push(current);
  save();
}

export function commitForward(current: Place | null): void {
  forward.pop();
  if (current) back.push(current);
  save();
}

/** the place cannot be reached any more (its file is gone) */
export function drop(dir: -1 | 1): void {
  (dir < 0 ? back : forward).pop();
  save();
}

/** A tab's lists kept behind the one in front, with a renamed file's places following it. */
export function renamedIn(s: { back: Place[]; forward: Place[] }, from: string, to: string): { back: Place[]; forward: Place[] } {
  const f = from.toLowerCase();
  const follow = (p: Place): Place => (p.path.toLowerCase() === f ? { ...p, path: to } : p);
  return { back: s.back.map(follow), forward: s.forward.map(follow) };
}

/** the file was renamed: its places follow it */
export function renamePath(from: string, to: string): void {
  const f = from.toLowerCase();
  for (const p of [...back, ...forward]) if (p.path.toLowerCase() === f) p.path = to;
  save();
}
