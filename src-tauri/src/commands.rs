use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use walkdir::WalkDir;

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

#[tauri::command]
pub fn write_markdown(path: String, content: String) -> Result<(), String> {
    let canon = dunce::canonicalize(&path).map_err(|e| format!("Cannot save {path}: {e}"))?;
    fs::write(&canon, content).map_err(|e| format!("Cannot save {}: {e}", canon.display()))
}

// unlike write_markdown, the target may not exist yet: canonicalize the parent
#[tauri::command]
pub fn export_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    let name = p.file_name().ok_or_else(|| format!("Invalid path: {path}"))?;
    let parent = p.parent().ok_or_else(|| format!("Invalid path: {path}"))?;
    let parent = dunce::canonicalize(parent).map_err(|e| format!("Cannot export to {path}: {e}"))?;
    let target = parent.join(name);
    fs::write(&target, content).map_err(|e| format!("Cannot export {}: {e}", target.display()))
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

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub name: String,
    /// 1-based; 0 means the file name itself matched
    pub line: u32,
    pub preview: String,
}

const MAX_HITS: usize = 200;

#[tauri::command]
pub fn search_in_tree(dir: String, query: String) -> Result<Vec<SearchHit>, String> {
    let root = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    let walker = WalkDir::new(&root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 || !e.file_type().is_dir() {
                return true;
            }
            let name = e.file_name().to_string_lossy().to_lowercase();
            !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str())
        });
    for entry in walker.filter_map(|e| e.ok()) {
        if hits.len() >= MAX_HITS {
            break;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let ext = path
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        if ext != "md" && ext != "markdown" {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        let path_str = path.to_string_lossy().into_owned();
        if name.to_lowercase().contains(&needle) {
            hits.push(SearchHit {
                path: path_str.clone(),
                name: name.clone(),
                line: 0,
                preview: String::new(),
            });
        }
        let Ok(content) = fs::read_to_string(path) else {
            continue;
        };
        for (i, line) in content.lines().enumerate() {
            if hits.len() >= MAX_HITS {
                break;
            }
            if line.to_lowercase().contains(&needle) {
                hits.push(SearchHit {
                    path: path_str.clone(),
                    name: name.clone(),
                    line: (i + 1) as u32,
                    preview: make_preview(line, &needle),
                });
            }
        }
    }
    Ok(hits)
}

// a window of the line centred on the first match, safe on any UTF-8
fn make_preview(line: &str, needle_lower: &str) -> String {
    const MAX_CHARS: usize = 160;
    let trimmed = line.trim();
    let lower = trimmed.to_lowercase();
    let byte = lower.find(needle_lower).unwrap_or(0);
    let char_off = lower[..byte].chars().count();
    let chars: Vec<char> = trimmed.chars().collect();
    let start = char_off.saturating_sub(60).min(chars.len());
    let end = (start + MAX_CHARS).min(chars.len());
    let mut out = String::new();
    if start > 0 {
        out.push('…');
    }
    out.extend(&chars[start..end]);
    if end < chars.len() {
        out.push('…');
    }
    out
}

fn unique_target(assets: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = assets.join(format!("{stem}.{ext}"));
    let mut i = 1;
    while candidate.exists() {
        candidate = assets.join(format!("{stem}-{i}.{ext}"));
        i += 1;
    }
    candidate
}

fn rel_assets_path(target: &Path) -> String {
    format!("assets/{}", target.file_name().unwrap_or_default().to_string_lossy())
}

/// Base64-decoded clipboard image, written to `<dir>/assets/`; returns the
/// document-relative path to insert in the markdown.
#[tauri::command]
pub fn save_clipboard_image(dir: String, data: String, ext: String) -> Result<String, String> {
    let root = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("Invalid image data: {e}"))?;
    let assets = root.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("Cannot create assets folder: {e}"))?;
    let ext = if !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext
    } else {
        "png".to_owned()
    };
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let target = unique_target(&assets, &format!("pasted-{millis}"), &ext);
    fs::write(&target, bytes).map_err(|e| format!("Cannot save image: {e}"))?;
    Ok(rel_assets_path(&target))
}

/// Copies an image file into `<dir>/assets/`; returns the relative path.
#[tauri::command]
pub fn import_image(dir: String, source: String) -> Result<String, String> {
    let root = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
    let src = dunce::canonicalize(&source).map_err(|e| e.to_string())?;
    let assets = root.join("assets");
    fs::create_dir_all(&assets).map_err(|e| format!("Cannot create assets folder: {e}"))?;
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "image".to_owned());
    let ext = src
        .extension()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".to_owned());
    let target = unique_target(&assets, &stem, &ext);
    fs::copy(&src, &target).map_err(|e| format!("Cannot copy image: {e}"))?;
    Ok(rel_assets_path(&target))
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
