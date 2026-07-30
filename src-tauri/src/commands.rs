use std::{
    fs,
    path::Path,
    thread,
    time::Duration,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{watcher, AppState};

#[derive(Serialize)]
pub struct MarkdownDoc {
    pub path: String,
    pub dir: String,
    pub content: String,
}

#[derive(Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "__pycache__",
    "venv",
    "windows",
    "program files",
    "program files (x86)",
    "programdata",
    "appdata",
    "$recycle.bin",
    "system volume information",
];
const MAX_ENTRIES: usize = 2000;
const MAX_DEPTH: usize = 4;

#[tauri::command]
pub fn get_initial_file(state: State<'_, AppState>) -> Option<String> {
    let path = state.initial_file.lock().unwrap().take()?;
    let canon = dunce::canonicalize(&path).ok()?;
    Some(canon.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn read_markdown(app: AppHandle, path: String) -> Result<MarkdownDoc, String> {
    let canon = dunce::canonicalize(&path).map_err(|e| format!("Cannot open {path}: {e}"))?;
    let raw = read_with_retry(&canon)?;
    let content = raw.strip_prefix('\u{feff}').unwrap_or(&raw).to_owned();
    let dir = canon
        .parent()
        .ok_or("File has no parent directory")?
        .to_path_buf();
    // let the asset protocol serve images from the document's folder
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    Ok(MarkdownDoc {
        path: canon.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        content,
    })
}

// editors briefly lock/replace the file during an atomic save
fn read_with_retry(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(_) => {
            thread::sleep(Duration::from_millis(120));
            fs::read_to_string(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))
        }
    }
}

#[tauri::command]
pub fn resolve_path(dir: String, rel: String) -> Result<String, String> {
    let joined = Path::new(&dir).join(&rel);
    let canon = dunce::canonicalize(&joined).map_err(|e| format!("Cannot resolve {rel}: {e}"))?;
    Ok(canon.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn parent_dir(path: String) -> Option<String> {
    let canon = dunce::canonicalize(&path).ok()?;
    let parent = canon.parent()?;
    Some(parent.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_tree(dir: String) -> Result<TreeNode, String> {
    let root = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    let mut count = 0usize;
    build_node(&root, 0, &mut count).ok_or_else(|| "No markdown files found".to_owned())
}

fn build_node(path: &Path, depth: usize, count: &mut usize) -> Option<TreeNode> {
    // a drive root such as `C:\` has no file_name
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    if path.is_dir() {
        if depth >= MAX_DEPTH
            || *count >= MAX_ENTRIES
            || (depth > 0
                && (name.starts_with('.') || SKIP_DIRS.contains(&name.to_lowercase().as_str())))
        {
            return None;
        }
        let mut children: Vec<TreeNode> = fs::read_dir(path)
            .ok()?
            .filter_map(|e| e.ok())
            .filter_map(|e| build_node(&e.path(), depth + 1, count))
            .collect();
        if children.is_empty() && depth > 0 {
            return None;
        }
        children.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Some(TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: true,
            children,
        })
    } else {
        if *count >= MAX_ENTRIES {
            return None;
        }
        let ext = path.extension()?.to_string_lossy().to_lowercase();
        if ext != "md" && ext != "markdown" {
            return None;
        }
        *count += 1;
        Some(TreeNode {
            name,
            path: path.to_string_lossy().into_owned(),
            is_dir: false,
            children: Vec::new(),
        })
    }
}

#[tauri::command]
pub fn watch_file(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<(), String> {
    let canon = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
    let debouncer = watcher::watch(app, &canon)?;
    // replacing the old debouncer drops it, which stops the previous watch
    *state.watcher.lock().unwrap() = Some(debouncer);
    Ok(())
}

#[tauri::command]
pub fn show_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}
