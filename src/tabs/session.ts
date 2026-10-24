// The window's tabs: their order, the one in front, the ones closed (for
// Ctrl+Shift+T), and what each keeps while it is behind. The view itself is
// one (main.ts): a tab coming forward puts its state back into it, the one
// leaving takes its state along (main.ts suspendView / resumeView).

import type { MarkdownDoc } from "../ipc";
import type { NoticeOptions } from "../notices";
import type { Place } from "../navHistory";
import type { ScrollAnchor } from "../state";
import type { Snapshot } from "../editor";
import type { TabTransfer } from "./contract";

export type Scheme = "light" | "dark";

/** What a tab keeps of the view while another one is in front. */
export interface TabView {
  /** the place being read */
  anchor: ScrollAnchor | null;
  /** the article as rendered (diagrams included), for coming back at once; null when dropped */
  fragment: DocumentFragment | null;
  /** the scheme the diagrams and pictures of `fragment` were drawn for */
  scheme: Scheme;
  editing: boolean;
  editor: Snapshot | null;
  nav: { back: Place[]; forward: Place[] };
  find: { open: boolean; query: string } | null;
  tocFilter: string;
  /** a sticky notice (file changed on disk, draft to restore, file gone), shown again on return */
  notice: { message: string; opts: NoticeOptions } | null;
  /** the article held an error card with this text */
  error: string | null;
  docGone: boolean;
  /** the folder of the file pane */
  treeRoot: string | null;
  /** edits not yet in the preview when it went behind: drawn again on return */
  previewStale: boolean;
}

export interface Tab {
  id: number;
  /** null: a start page */
  path: string | null;
  /** the document as last read or saved; null until the tab has been in front once */
  doc: MarkdownDoc | null;
  /** where to land the first time it comes forward (a link's #anchor, a --line) */
  at: { line?: number; anchor?: string } | null;
  /** its state while behind; null while in front, or before it was ever shown */
  view: TabView | null;
  /** state brought from another window, applied when it is first shown */
  transfer: TabTransfer | null;
  /** its file changed on disk while it was behind: read again when it comes forward */
  stale: boolean;
  /** unsaved edits (kept current while in front by main.ts) */
  dirty: boolean;
  /** the reading time last shown for it, for its hover card */
  meta: string;
  /** on its way out (the strip animates it away) */
  closing: boolean;
  /** on its way to another window: out of the strip until that window has it */
  leaving: boolean;
  /** when it last came forward, to keep the rendered views of the recent ones */
  shownAt: number;
}

let nextId = 1;
export const tabs: Tab[] = [];
let front: Tab | null = null;

/** Closed tabs, most recent last: Ctrl+Shift+T opens them again where they were. */
export const closed: { path: string; index: number; anchor: ScrollAnchor | null }[] = [];
const MAX_CLOSED = 25;

export function make(path: string | null, at: Tab["at"] = null): Tab {
  return {
    id: nextId++,
    path,
    doc: null,
    at,
    view: null,
    transfer: null,
    stale: false,
    dirty: false,
    meta: "",
    closing: false,
    leaving: false,
    shownAt: 0,
  };
}

/** The tab in front. There is always one once the window has started. */
export function active(): Tab {
  if (!front) throw new Error("no tab yet");
  return front;
}

export const hasActive = (): boolean => front !== null;

export function setActive(tab: Tab): void {
  front = tab;
  tab.shownAt = performance.now();
}

/** The tabs that are not on their way out, in order. */
export const live = (): Tab[] => tabs.filter((t) => !t.closing && !t.leaving);

export const byId = (id: number): Tab | undefined => tabs.find((t) => t.id === id);

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The tab showing (or about to show) this file. */
export const findPath = (path: string): Tab | undefined =>
  live().find((t) => t.path !== null && samePath(t.path, path));

/** Puts `tab` before `before` (at the end when null or absent). */
export function insert(tab: Tab, before: Tab | null = null): void {
  const at = before ? tabs.indexOf(before) : -1;
  if (at < 0) tabs.push(tab);
  else tabs.splice(at, 0, tab);
}

export function insertAfter(tab: Tab, after: Tab): void {
  const at = tabs.indexOf(after);
  tabs.splice(at < 0 ? tabs.length : at + 1, 0, tab);
}

/** Out of the list for good (once the strip has animated it away). */
export function remove(tab: Tab): void {
  const at = tabs.indexOf(tab);
  if (at >= 0) tabs.splice(at, 1);
}

/** Moves `tab` to position `to` among the live tabs. */
export function move(tab: Tab, to: number): void {
  const list = live();
  const target = list[Math.max(0, Math.min(list.length - 1, to))];
  if (!target || target === tab) return;
  const forward = list.indexOf(tab) < list.indexOf(target);
  remove(tab);
  const at = tabs.indexOf(target);
  tabs.splice(forward ? at + 1 : at, 0, tab);
}

export function rememberClosed(tab: Tab, index: number, anchor: ScrollAnchor | null): void {
  if (!tab.path) return;
  closed.push({ path: tab.path, index, anchor });
  if (closed.length > MAX_CLOSED) closed.splice(0, closed.length - MAX_CLOSED);
}

/**
 * The rendered views kept for coming back at once: the `keep` most recently
 * shown tabs behind keep theirs, the others drop it (and render again).
 */
export function trimViews(keep: number): void {
  const behind = live()
    .filter((t) => t !== front && t.view?.fragment)
    .sort((a, b) => b.shownAt - a.shownAt);
  for (const t of behind.slice(keep)) t.view!.fragment = null;
}
