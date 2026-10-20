import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

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

/** a command line: `leggimi [file] [--line N]`, or what a new window is made for */
export interface Launch {
  path: string | null;
  line: number | null;
  /** heading id to show at the top (a `file.md#section` link) */
  anchor?: string | null;
}

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
export const watchFile = (path: string) => invoke<void>("watch_file", { path });
// the file pane's folder, watched for files coming and going; `rearm` renews
// the watch of the same folder. The time orders the requests (a reload of the
// page keeps counting up).
export const watchTree = (root: string, rearm = false) =>
  invoke<void>("watch_tree", { root, rearm, seq: Date.now() });
export const resolvePath = (dir: string, rel: string) => invoke<string>("resolve_path", { dir, rel });
// a document link without extension, or to a folder: the file it stands for
export const resolveDoc = (dir: string, rel: string) => invoke<string | null>("resolve_doc", { dir, rel });
export const showWindow = () => invoke<void>("show_window");
/** a new window, for a file or (path null) on the home */
export const openWindow = (path: string | null, opts: { line?: number; anchor?: string } = {}) =>
  invoke<void>("open_window", { path, line: opts.line ?? null, anchor: opts.anchor ?? null });
export const printToPdf = (path: string, landscape: boolean) =>
  invoke<void>("print_to_pdf", { path, landscape });
// a file a document links to, in its default app (documents and media only)
export const openExternally = (path: string) => invoke<void>("open_externally", { path });
// the language picked in the reading settings, for WebView2's own parts at the next start
export const rememberLanguage = (pref: string) => invoke<void>("remember_language", { pref });
export const isStoreInstall = () => invoke<boolean>("is_store_install");
export const openStoreReview = () => invoke<void>("open_store_review");

// These events are sent to one window. They are heard through that window:
// the global listen() takes the events sent to any window, the others' too.
export const onOpenFile = (cb: (launch: Launch) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<Launch>("open-file", (e) => cb(e.payload));

export const onFileChanged = (cb: (change: FileChange) => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen<FileChange>("file-changed", (e) => cb(e.payload));

// the folder of the file pane may list something else now
export const onTreeChanged = (cb: () => void): Promise<UnlistenFn> =>
  getCurrentWebviewWindow().listen("tree-changed", () => cb());
