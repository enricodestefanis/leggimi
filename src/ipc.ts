import { invoke } from "@tauri-apps/api/core";
import { emitTo, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  EV,
  type CaptionLayout,
  type OpenRequest,
  type TabAccepted,
  type TabHover,
  type TabOffer,
  type TabTransfer,
  type WindowDragDrop,
} from "./tabs/contract";

export interface MarkdownDoc {
  path: string;
  dir: string;
  content: string;
  /** last modification time, ms since the epoch; 0 when unknown */
  modified: number;
}

/** error string from write_markdown when the file changed on disk since it was read */
export const WRITE_CONFLICT = "conflict";
/** error string from read_markdown and open_window when the file is not there */
export const NOT_FOUND = "not-found";

/** what became of the window's document on disk */
export interface FileChange {
  kind: "changed" | "renamed" | "removed";
  path: string;
  /** the new path, for "renamed" */
  to?: string | null;
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

export interface SearchHit {
  name: string;
  path: string;
  /** 1-based; 0 means the file name itself matched */
  line: number;
  preview: string;
}

/** a command line: `leggimi [file] [--line N]`, a file routed here, or what a new window is made for */
export type Launch = OpenRequest;

export const getInitialFile = () => invoke<Launch | null>("get_initial_file");
export const readMarkdown = (path: string) => invoke<MarkdownDoc>("read_markdown", { path });
// resolves to the file's new modification time; rejects with WRITE_CONFLICT
// when `expectedModified` (> 0) no longer matches the file on disk. `create`
// writes a file that is gone (the document was deleted while open).
export const writeMarkdown = (path: string, content: string, expectedModified: number | null, create = false) =>
  invoke<number>("write_markdown", { path, content, expectedModified, create });
export const existingPaths = (paths: string[]) => invoke<string[]>("existing_paths", { paths });
export const exportFile = (path: string, content: string) =>
  invoke<void>("export_file", { path, content });
export const exportBinary = (path: string, data: string) =>
  invoke<void>("export_binary", { path, data });
export const saveClipboardImage = (dir: string, data: string, ext: string) =>
  invoke<string>("save_clipboard_image", { dir, data, ext });
export const importImage = (dir: string, source: string) =>
  invoke<string>("import_image", { dir, source });
export const listTree = (dir: string) => invoke<TreeNode>("list_tree", { dir });
export const searchInTree = (dir: string, query: string) =>
  invoke<SearchHit[]>("search_in_tree", { dir, query });
export const parentDir = (path: string) => invoke<string | null>("parent_dir", { path });
// every file open in the window's tabs, watched for changes, renames and deletions
export const watchFiles = (paths: string[]) => invoke<void>("watch_files", { paths });
// the window's tabs (and the one in front), so a file opened from outside finds its tab
export const setTabs = (paths: string[], active: string | null) => invoke<void>("set_tabs", { paths, active });
// the Leggimi window at this point of the screen (physical pixels), in true stacking order
export const windowAt = (x: number, y: number, exclude: string | null = null) =>
  invoke<string | null>("window_at", { x, y, exclude });
// the window is asking whether to close: a file opened from outside goes elsewhere
export const setClosing = (closing: boolean) => invoke<void>("set_closing", { closing });
// where the window's buttons and tab strip are, for the native caption zones and window drags
export const setCaption = (layout: CaptionLayout) => invoke<void>("set_caption", { layout });
export const setStrip = (x: number, y: number, w: number, h: number) => invoke<void>("set_strip", { x, y, w, h });
// the title bar's own menu (Restore, Move, Size, Minimize, Maximize, Close) at this point (physical px)
export const showSystemMenu = (x: number, y: number) => invoke<void>("show_system_menu", { x, y });
// the only tab dragged: the window follows the pointer natively and may join another one
export const beginWindowDrag = (path: string | null, title: string) => invoke<void>("begin_window_drag", { path, title });
// the file pane's folder, watched for files coming and going; `rearm` renews
// the watch of the same folder. The time orders the requests (a reload of the
// page keeps counting up).
export const watchTree = (root: string, rearm = false) =>
  invoke<void>("watch_tree", { root, rearm, seq: Date.now() });
export const resolvePath = (dir: string, rel: string) => invoke<string>("resolve_path", { dir, rel });
// a document link without extension, or to a folder: the file it stands for
export const resolveDoc = (dir: string, rel: string) => invoke<string | null>("resolve_doc", { dir, rel });
export const showWindow = () => invoke<void>("show_window");
/**
 * A new window, for a file or (path null) on the home; with `transfer`, a tab
 * moving there (answered with "tab-accepted" and `token`), born at `at`
 * (physical pixels) and, with `follow`, carried by the pointer still down.
 * Resolves to its label.
 */
export const openWindow = (
  path: string | null,
  opts: {
    line?: number;
    anchor?: string;
    transfer?: TabTransfer;
    from?: string;
    token?: string;
    at?: { x: number; y: number };
    follow?: boolean;
  } = {},
) =>
  invoke<string>("open_window", {
    path,
    line: opts.line ?? null,
    anchor: opts.anchor ?? null,
    transfer: opts.transfer ?? null,
    from: opts.from ?? null,
    token: opts.token ?? null,
    at: opts.at ?? null,
    follow: opts.follow ?? false,
  });
export const printToPdf = (path: string, landscape: boolean) =>
  invoke<void>("print_to_pdf", { path, landscape });
// a file a document links to, in its default app (documents and media only)
export const openExternally = (path: string) => invoke<void>("open_externally", { path });
// the language picked in the reading settings, for WebView2's own parts at the next start
export const rememberLanguage = (pref: string) => invoke<void>("remember_language", { pref });
export const isStoreInstall = () => invoke<boolean>("is_store_install");
export const openStoreReview = () => invoke<void>("open_store_review");
// the Store's own rating dialog over this window: "succeeded" (rated) or
// "canceled" (closed); "fallback" when it cannot show (the GitHub build, no
// network, an error) and the Store's review page opened instead. Rejects only
// when even that page could not open.
export const requestStoreRating = () => invoke<"succeeded" | "canceled" | "fallback">("request_store_rating");

// These events are sent to one window. They are heard through that window:
// the global listen() takes the events sent to any window, the others' too.
export const onOpenFile = (cb: (launch: Launch) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<Launch>("open-file", (e) => cb(e.payload));

export const onFileChanged = (cb: (change: FileChange) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<FileChange>("file-changed", (e) => cb(e.payload));

// the folder of the file pane may list something else now
export const onTreeChanged = (cb: () => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen("tree-changed", () => cb());

const listen = <T>(event: string, cb: (payload: T) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<T>(event, (e) => cb(e.payload));

// the pointer over one of the native caption zones (the page draws the hover)
export const onCaptionHover = (cb: (button: "min" | "max" | "close" | null) => void) =>
  listen<{ button: "min" | "max" | "close" | null }>(EV.captionHover, (p) => cb(p?.button ?? null));
// this window, carried by its only tab, was let go over another window's strip
export const onWindowDragDrop = (cb: (drop: WindowDragDrop) => void) => listen<WindowDragDrop>(EV.windowDragDrop, cb);

// tabs between windows: a tab carried over this window, let go here, and the answers
export const onTabHover = (cb: (h: TabHover) => void) => listen<TabHover>(EV.tabHover, cb);
export const onTabHoverEnd = (cb: () => void) => listen<null>(EV.tabHoverEnd, () => cb());
export const onTabOffer = (cb: (o: TabOffer) => void) => listen<TabOffer>(EV.tabOffer, cb);
export const onTabAccepted = (cb: (a: TabAccepted) => void) => listen<TabAccepted>(EV.tabAccepted, cb);
export const sendTabHover = (to: string, h: TabHover) => emitTo(to, EV.tabHover, h);
export const sendTabHoverEnd = (to: string) => emitTo(to, EV.tabHoverEnd, null);
export const sendTabOffer = (to: string, o: TabOffer) => emitTo(to, EV.tabOffer, o);
export const sendTabAccepted = (to: string, a: TabAccepted) => emitTo(to, EV.tabAccepted, a);
