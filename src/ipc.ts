import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface MarkdownDoc {
  path: string;
  dir: string;
  content: string;
  /** last modification time, ms since the epoch; 0 when unknown */
  modified: number;
}

/** error string from write_markdown when the file changed on disk since it was read */
export const WRITE_CONFLICT = "conflict";

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

/** a command line: `leggimi [file] [--line N]` */
export interface Launch {
  path: string | null;
  line: number | null;
}

export const getInitialFile = () => invoke<Launch | null>("get_initial_file");
export const readMarkdown = (path: string) => invoke<MarkdownDoc>("read_markdown", { path });
// resolves to the file's new modification time; rejects with WRITE_CONFLICT
// when `expectedModified` (> 0) no longer matches the file on disk
export const writeMarkdown = (path: string, content: string, expectedModified: number | null) =>
  invoke<number>("write_markdown", { path, content, expectedModified });
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
export const resolvePath = (dir: string, rel: string) => invoke<string>("resolve_path", { dir, rel });
// a document link without extension, or to a folder: the file it stands for
export const resolveDoc = (dir: string, rel: string) => invoke<string | null>("resolve_doc", { dir, rel });
export const showWindow = () => invoke<void>("show_window");
export const printToPdf = (path: string, landscape: boolean) =>
  invoke<void>("print_to_pdf", { path, landscape });
export const isStoreInstall = () => invoke<boolean>("is_store_install");
export const openStoreReview = () => invoke<void>("open_store_review");

export const onOpenFile = (cb: (launch: Launch) => void): Promise<UnlistenFn> =>
  listen<Launch>("open-file", (e) => cb(e.payload));

export const onFileChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("file-changed", (e) => cb(e.payload));
