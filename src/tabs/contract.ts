// The shapes the tabs share with main.ts, the Rust side and the test kit:
// what a tab carries when it goes to another window, what Rust and the pages
// tell each other, and the hooks the tests drive. Types and names only.

import type { ScrollAnchor } from "../state";
import type { Place } from "../navHistory";

/** The editor of a tab that holds more than its file does (unsaved edits, undo). */
export interface EditorTransfer {
  /** EditorState.toJSON({ history: historyField }) */
  state: unknown;
  /** the text last read from or written to disk, with "\n" line ends */
  lastSaved: string;
  eol: "\n" | "\r\n";
  /** the file's modification time `lastSaved` matches: the save guard's baseline */
  baseModified: number;
  /** the text differs from `lastSaved` */
  dirty?: boolean;
}

/** A tab on its way to another window: an event's payload, or a new window's launch. */
export interface TabTransfer {
  v: 1;
  /** null: a start page */
  path: string | null;
  /** where the reader was */
  anchor: ScrollAnchor | null;
  editing: boolean;
  editor: EditorTransfer | null;
  nav: { back: Place[]; forward: Place[] };
  find: { open: boolean; query: string } | null;
  tocFilter: string;
}

/** "open-file", Rust → page; also what get_initial_file returns. */
export interface OpenRequest {
  path: string | null;
  /** 1-based source line to show at the top */
  line: number | null;
  /** heading id to show at the top (a `file.md#section` link) */
  anchor?: string | null;
  /**
   * "tab" (the default): open it in a tab of this window, reusing a start
   * page in front; "activate": it is open here already, that tab comes forward
   */
  mode?: "tab" | "activate" | null;
  /** a tab coming from another window (a torn-off tab's new window gets it at start) */
  transfer?: TabTransfer | null;
  /** with a transfer: the window it comes from and the token to answer it with "tab-accepted" */
  from?: string | null;
  token?: string | null;
}

/** A tab carried over a window: the pointer in physical screen pixels. */
export interface TabHover {
  /** the label of the window it comes from */
  from: string;
  title: string;
  path: string | null;
  x: number;
  y: number;
}

/** A tab let go over a window: take it (reply with "tab-accepted"). */
export interface TabOffer {
  token: string;
  from: string;
  transfer: TabTransfer;
  x: number;
  y: number;
}

export interface TabAccepted {
  token: string;
  ok: boolean;
  /** why not: the window is closing, or holds the same file and one of the two has unsaved edits */
  reason?: "closing" | "same-file-dirty" | null;
}

/** A native window drag (its only tab) ended over another window's tab strip. */
export interface WindowDragDrop {
  target: string;
  x: number;
  y: number;
}

/** The caption buttons as the page lays them out, in CSS pixels of the client area. */
export interface CaptionLayout {
  buttons: { kind: "min" | "max" | "close"; x: number; y: number; w: number; h: number }[];
  /** false while something covers them (a modal dialog, the preview) */
  visible: boolean;
}

/** Event names (Rust → page, and page → page through emitTo). */
export const EV = {
  openFile: "open-file",
  fileChanged: "file-changed",
  treeChanged: "tree-changed",
  tabHover: "tab-hover",
  tabHoverEnd: "tab-hover-end",
  tabOffer: "tab-offer",
  tabAccepted: "tab-accepted",
  /** Rust → page: the pointer is over a native caption zone: { button: "min" | "max" | "close" | null } */
  captionHover: "caption-hover",
  windowDragDrop: "window-drag-drop",
} as const;

/** One tab as the tests see it (window.__leggimi.tabs()). */
export interface TabInfo {
  id: number;
  path: string | null;
  active: boolean;
  dirty: boolean;
  editing: boolean;
  /** its file has been read (a tab opened behind is read when it first comes forward) */
  loaded: boolean;
}

/** window.__leggimi: what the test kit drives (present in release builds too). */
export interface TestHooks {
  label: string;
  tabs(): TabInfo[];
  activate(index: number): Promise<void>;
  close(index: number): Promise<"closed" | "kept">;
  newTab(): void;
  openInTab(path: string, opts?: { background?: boolean; line?: number; anchor?: string }): Promise<void>;
  move(from: number, to: number): void;
  transfer(index: number): TabTransfer;
  /** "Move to a new window" of the tab's menu */
  tearOff(index: number): Promise<void>;
}
