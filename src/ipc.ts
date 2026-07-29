import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface MarkdownDoc {
  path: string;
  dir: string;
  content: string;
}

export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
}

export const getInitialFile = () => invoke<string | null>("get_initial_file");
export const readMarkdown = (path: string) => invoke<MarkdownDoc>("read_markdown", { path });
export const listTree = (dir: string) => invoke<TreeNode>("list_tree", { dir });
export const watchFile = (path: string) => invoke<void>("watch_file", { path });
export const resolvePath = (dir: string, rel: string) => invoke<string>("resolve_path", { dir, rel });
export const showWindow = () => invoke<void>("show_window");

export const onOpenFile = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("open-file", (e) => cb(e.payload));

export const onFileChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<string>("file-changed", (e) => cb(e.payload));
