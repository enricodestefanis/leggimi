use std::{
    fs,
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use walkdir::WalkDir;

use crate::{drag, same_file, watcher, AppState, Launch, WindowSlot};

#[derive(Serialize)]
pub struct MarkdownDoc {
    pub path: String,
    pub dir: String,
    pub content: String,
    /// last modification time, ms since the Unix epoch (0 when unknown); the
    /// save guard compares it with the file's current one
    pub modified: u64,
    /// how the file's bytes were written (decode_text): "utf-8" (with or
    /// without a BOM), "utf-16le", "utf-16be" or "windows-<code page>"; a
    /// save always writes UTF-8
    pub encoding: String,
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize)]
pub struct TreeNode {
    pub name: String,
    pub path: String,
    #[serde(rename = "isDir")]
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

/// Extensions treated as Markdown; keep in sync with `MD_EXTENSIONS` in src/main.ts,
/// the MSIX manifest and the NSIS file associations.
const MD_EXTS: &[&str] = &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "markdn", "mdtxt"];

fn is_markdown_ext(ext: &str) -> bool {
    MD_EXTS.contains(&ext)
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

/// A folder the file pane and the folder search leave out: hidden, build
/// output, system folders.
fn skipped_dir(name: &str) -> bool {
    name.starts_with('.') || SKIP_DIRS.contains(&name.to_lowercase().as_str())
}

/// Whether `path` (under `root`, existing or just gone) can be in the file
/// pane's listing: within the depth, outside skipped folders, and a Markdown
/// file or a folder. A path that no longer exists may have been a folder; the
/// files of a save (replace_whole) never are.
pub(crate) fn listed_path(root: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let Some((last, dirs)) = parts.split_last() else {
        return false;
    };
    if parts.len() > MAX_DEPTH || dirs.iter().any(|d| skipped_dir(d)) || save_file(last) {
        return false;
    }
    let is_md = path
        .extension()
        .is_some_and(|e| is_markdown_ext(&e.to_string_lossy().to_lowercase()));
    is_md || ((path.is_dir() || !path.exists()) && !skipped_dir(last))
}

/// Error from read_markdown and open_window when the file is not there (any
/// more): the page says so in its own words.
pub const NOT_FOUND: &str = "not-found";

/// What this window opens with, once (OpenRequest): the command line for the
/// first window, the file or the torn-off tab a new window was made for. Its
/// page calls this with its listeners live, so from now on launches may be
/// routed to it; those routed before it has shown itself come then, in
/// order (show_window). The path is canonicalized; a file that is not there
/// keeps the full path it came with, so the page says the file is missing.
#[tauri::command]
pub fn get_initial_file(window: WebviewWindow, state: State<'_, AppState>) -> Option<Launch> {
    let mut windows = state.windows.lock().unwrap();
    start(windows.entry(window.label().to_owned()).or_default())
}

/// get_initial_file on the window's slot: its page listens from now on. A
/// window opened on its start page takes the first launch queued for it as
/// its own.
pub(crate) fn start(slot: &mut WindowSlot) -> Option<Launch> {
    slot.ready = true;
    let own = slot.launch.take();
    // a tab of pasted text torn off another window: no file, yet no free
    // start page, already before its page first calls set_tabs
    if own.as_ref().is_some_and(Launch::pasted) {
        slot.pasted = slot.pasted.max(1);
    }
    let empty = own.as_ref().is_none_or(|l| l.path.is_none() && l.transfer.is_none());
    let launch = if empty && !slot.queued.is_empty() {
        let mut first = slot.queued.remove(0);
        first.mode = None;
        Some(first)
    } else {
        own
    };
    let mut launch = launch?;
    if let Some(canon) = launch.path.as_deref().and_then(|p| dunce::canonicalize(p).ok()) {
        // on its way until set_tabs says a tab has it
        slot.expect(canon.clone());
        launch.path = Some(canon.to_string_lossy().into_owned());
    }
    Some(launch)
}

/// show_window on the window's slot: its page has opened what it started
/// with; the launches routed here meanwhile, to send in order.
pub(crate) fn shown(slot: &mut WindowSlot) -> Vec<Launch> {
    slot.shown = true;
    std::mem::take(&mut slot.queued)
}

/// The documents in the window's tabs, as its page has them, the one in
/// front, and how many tabs hold pasted text (no file): what routing goes by
/// (a launch of one of them brings its tab forward, and only a window with
/// neither documents nor pasted text is a free start page). The page calls
/// it whenever a tab is created, closed, moved, renamed or activated.
#[tauri::command]
pub fn set_tabs(
    window: WebviewWindow,
    state: State<'_, AppState>,
    paths: Vec<String>,
    active: Option<String>,
    pasted: Option<u32>,
) {
    let mut windows = state.windows.lock().unwrap();
    // a window closed meanwhile has no slot, and must not get one back
    let Some(slot) = windows.get_mut(window.label()) else {
        return;
    };
    let docs: Vec<PathBuf> = paths.iter().map(|p| tab_doc(p, &slot.docs)).collect();
    let active = active.map(|p| tab_doc(&p, &slot.docs));
    tabs_changed(slot, docs, active, pasted.unwrap_or(0));
}

/// set_tabs on the window's slot: the documents that have arrived in a tab
/// are no longer on their way.
pub(crate) fn tabs_changed(slot: &mut WindowSlot, docs: Vec<PathBuf>, active: Option<PathBuf>, pasted: u32) {
    slot.opening.retain(|o| !docs.iter().any(|d| same_file(d, o)));
    slot.docs = docs;
    slot.active = active;
    slot.pasted = pasted;
}

/// A tab's document as routing compares it: as already known (the page
/// passes the paths it got from Rust, canonical, so this is the usual case
/// and no disk is touched), else canonical, else (a file gone) the full path.
fn tab_doc(path: &str, known: &[PathBuf]) -> PathBuf {
    let p = Path::new(path);
    if let Some(k) = known.iter().find(|k| same_file(k, p)) {
        return k.clone();
    }
    dunce::canonicalize(p).unwrap_or_else(|_| std::path::absolute(p).unwrap_or_else(|_| p.to_path_buf()))
}

/// The window's page is asking whether to close (unsaved edits), or has
/// stopped asking: meanwhile launches go to other windows.
#[tauri::command]
pub fn set_closing(window: WebviewWindow, state: State<'_, AppState>, closing: bool) {
    if let Some(slot) = state.windows.lock().unwrap().get_mut(window.label()) {
        slot.closing = closing;
    }
}

/// Where the window's tab strip is, in CSS px of its client area: a window
/// dragged by its tab and let go over it merges there (drag.rs).
#[tauri::command]
pub fn set_strip(window: WebviewWindow, state: State<'_, AppState>, x: f64, y: f64, w: f64, h: f64) {
    if let Some(slot) = state.windows.lock().unwrap().get_mut(window.label()) {
        slot.strip = (w > 0.0 && h > 0.0).then_some(drag::Strip { x, y, w, h });
    }
}

/// The label of the top-most Leggimi window at a point of the screen
/// (physical px), in the true order of the windows there; null where another
/// app's window is on top. `exclude`: a window to see through (one that moves
/// with the pointer). Off the main thread: it looks at other apps' windows.
#[tauri::command]
pub async fn window_at(x: f64, y: f64, exclude: Option<String>) -> Option<String> {
    drag::window_at(x, y, exclude.as_deref())
}

/// The page drags its window by its only tab: Windows' own move loop, the
/// other windows' strips watched (drag.rs).
#[tauri::command]
pub fn begin_window_drag(window: WebviewWindow, path: Option<String>, title: String) {
    drag::begin(&window, path, title);
}

#[tauri::command]
pub fn read_markdown(app: AppHandle, path: String) -> Result<MarkdownDoc, String> {
    let canon = dunce::canonicalize(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            NOT_FOUND.to_owned()
        } else {
            format!("Cannot open {path}: {e}")
        }
    })?;
    let (content, encoding) = decode_text(read_with_retry(&canon)?);
    let dir = canon
        .parent()
        .ok_or("File has no parent directory")?
        .to_path_buf();
    // let the asset protocol serve images from the document's folder
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    add_to_recent(&canon);
    Ok(MarkdownDoc {
        path: canon.to_string_lossy().into_owned(),
        dir: dir.to_string_lossy().into_owned(),
        content,
        modified: modified_ms(&canon),
        encoding,
    })
}

/// Error returned by `write_markdown` when the file on disk is newer than
/// the copy the editor started from; the UI asks before overwriting.
pub const CONFLICT: &str = "conflict";

/// Writes the file and returns its new modification time. With
/// `expected_modified`, refuses (Err(CONFLICT)) when the file changed on disk
/// since it was read — unless it is 0/None, which means "overwrite anyway".
/// A file that is gone is written again only with `create`: the page asks for
/// it when its document was deleted or moved away while open, never for a
/// save that merely raced a rename.
#[tauri::command]
pub fn write_markdown(
    path: String,
    content: String,
    expected_modified: Option<u64>,
    create: Option<bool>,
    bom: Option<bool>,
) -> Result<u64, String> {
    // a file that had a UTF-8 BOM keeps it, and one read as UTF-16 or ANSI gets one: Windows
    // PowerShell 5.1, which wrote it, reads UTF-8 without a BOM as ANSI
    let content = if bom == Some(true) { format!("\u{feff}{content}") } else { content };
    let canon = match dunce::canonicalize(&path) {
        Ok(canon) => canon,
        Err(e) if create == Some(true) && e.kind() == std::io::ErrorKind::NotFound => {
            let p = Path::new(&path);
            let name = p.file_name().ok_or_else(|| format!("Invalid path: {path}"))?;
            let parent = p.parent().ok_or_else(|| format!("Invalid path: {path}"))?;
            dunce::canonicalize(parent)
                .map_err(|e| format!("Cannot save {path}: {e}"))?
                .join(name)
        }
        Err(e) => return Err(format!("Cannot save {path}: {e}")),
    };
    if let Some(expected) = expected_modified.filter(|&m| m > 0) {
        let now = modified_ms(&canon);
        if now > 0 && now != expected {
            return Err(CONFLICT.to_owned());
        }
    }
    let mut anew = create == Some(true);
    // the new text under a temporary name when Windows let the old file go and could
    // not put the new one in its place: removed only once the text is in the file
    let mut kept: Option<PathBuf> = None;
    // a file that is there is replaced whole, or not at all (replace_whole)
    if canon.is_file() {
        match replace_whole(&canon, content.as_bytes()) {
            Ok(()) => return Ok(modified_ms(&canon)),
            Err(NotReplaced::Lost(temp)) => {
                anew = true;
                kept = Some(temp);
            }
            Err(NotReplaced::Untouched) => {}
        }
    }
    // without `create`, a file renamed away since the canonicalize above is not
    // written back under its old name
    use std::io::Write;
    fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .create(anew)
        .open(&canon)
        .and_then(|mut f| f.write_all(content.as_bytes()))
        .map_err(|e| match &kept {
            Some(temp) => format!("Cannot save {}: {e} (the text is in {})", canon.display(), temp.display()),
            None => format!("Cannot save {}: {e}", canon.display()),
        })?;
    if let Some(temp) = kept {
        let _ = fs::remove_file(temp);
    }
    Ok(modified_ms(&canon))
}

/// Why replace_whole did not save, and what the in-place write that follows
/// must do.
#[derive(Debug, PartialEq, Eq)]
enum NotReplaced {
    /// the file is as it was: write it in place, as before 2.3
    Untouched,
    /// Windows let the old file go and could not put the new one in its
    /// place (ERROR_UNABLE_TO_MOVE_REPLACEMENT): write it anew; the new text
    /// waits in this temporary file until it is
    Lost(PathBuf),
}

/// What the temporary files of replace_whole end with; the file pane and its
/// watcher leave them out (listed_path).
pub(crate) const TEMP_SUFFIX: &str = ".leggimi-tmp";

/// Tells apart the temporary files of saves running at the same time.
static TEMP_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// The temporary file beside `target` for a save: `.notes.md.<pid>-<n>.leggimi-tmp`.
fn temp_beside(target: &Path) -> Option<PathBuf> {
    let name = target.file_name()?.to_string_lossy();
    let n = TEMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Some(target.with_file_name(format!(".{name}.{}-{n}{TEMP_SUFFIX}", std::process::id())))
}

/// A file that exists only while a save runs: replace_whole's temporary file
/// (`.notes.md.<pid>-<n>.leggimi-tmp`), or the name ReplaceFileW gives the old
/// file for the moment the new one takes its place (`notes.md~RF1a2b3c.TMP`),
/// which it then deletes.
fn save_file(name: &str) -> bool {
    let name = name.to_lowercase();
    if name.ends_with(TEMP_SUFFIX) {
        return true;
    }
    let Some(stem) = name.strip_suffix(".tmp") else {
        return false;
    };
    stem.rsplit_once("~rf")
        .is_some_and(|(before, hex)| !before.is_empty() && !hex.is_empty() && hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The file a temporary file of temp_beside stands in for, beside it; None
/// for any other file.
pub(crate) fn replaced_by(temp: &Path) -> Option<PathBuf> {
    let name = temp.file_name()?.to_str()?;
    let inner = name.strip_prefix('.')?.strip_suffix(TEMP_SUFFIX)?;
    let (target, tag) = inner.rsplit_once('.')?;
    let (pid, n) = tag.split_once('-')?;
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    (!target.is_empty() && digits(pid) && digits(n)).then(|| temp.with_file_name(target))
}

/// Saves `bytes` as the whole of `target`, an existing file, or changes
/// nothing: the text goes to a temporary file beside it, flushed to the disk,
/// which then takes the file's place (`ReplaceFileW`, which keeps the file's
/// creation time, attributes, permissions, other streams and object id).
/// Power lost, a drive pulled or a share gone halfway leaves the old text
/// whole, never an empty or cut file: for the instant ReplaceFileW swaps the
/// names, the old file is `<name>~RF<hex>.TMP` and the new text the
/// temporary file. Not for a file with several names (hard links), which
/// would lose the others, nor a read-only one, whose in-place write fails as
/// it always has. Any failure removes the temporary file.
#[cfg(windows)]
fn replace_whole(target: &Path, bytes: &[u8]) -> Result<(), NotReplaced> {
    use std::io::Write;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{ERROR_UNABLE_TO_MOVE_REPLACEMENT, ERROR_UNABLE_TO_MOVE_REPLACEMENT_2};
    use windows_sys::Win32::Storage::FileSystem::{
        ReplaceFileW, REPLACEFILE_IGNORE_ACL_ERRORS, REPLACEFILE_IGNORE_MERGE_ERRORS,
    };

    if !replaceable(target) {
        return Err(NotReplaced::Untouched);
    }
    let temp = temp_beside(target).ok_or(NotReplaced::Untouched)?;
    // never one that is there already: it would be another save's
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)
        .map_err(|_| NotReplaced::Untouched)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    drop(file);
    if written.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(NotReplaced::Untouched);
    }
    let wide = |p: &Path| p.as_os_str().encode_wide().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (replaced, replacement) = (wide(target), wide(&temp));
    let flags = REPLACEFILE_IGNORE_MERGE_ERRORS | REPLACEFILE_IGNORE_ACL_ERRORS;
    let done = unsafe {
        ReplaceFileW(
            replaced.as_ptr(),
            replacement.as_ptr(),
            std::ptr::null(),
            flags,
            std::ptr::null(),
            std::ptr::null(),
        )
    } != 0;
    if done {
        return Ok(());
    }
    let code = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
    let moved = code == ERROR_UNABLE_TO_MOVE_REPLACEMENT || code == ERROR_UNABLE_TO_MOVE_REPLACEMENT_2;
    // the old file is gone, the new text still under the temporary name
    if moved && !target.exists() {
        if fs::rename(&temp, target).is_ok() {
            return Ok(());
        }
        // the only copy of the new text on the disk: write_markdown removes it once it is in the file
        return Err(NotReplaced::Lost(temp));
    }
    let _ = fs::remove_file(&temp);
    Err(NotReplaced::Untouched)
}

#[cfg(not(windows))]
fn replace_whole(_target: &Path, _bytes: &[u8]) -> Result<(), NotReplaced> {
    Err(NotReplaced::Untouched)
}

/// A file replace_whole may replace: one name only (no other hard links), not
/// read-only. No when Windows cannot tell.
#[cfg(windows)]
fn replaceable(target: &Path) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_READONLY,
    };
    let Ok(file) = fs::File::open(target) else {
        return false;
    };
    let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
        return false;
    }
    info.nNumberOfLinks == 1 && info.dwFileAttributes & FILE_ATTRIBUTE_READONLY == 0
}

/// The subset of `paths` that still exist as files (the recent-files list,
/// the document on focus). Off the main thread: a file on a share that went
/// away can take the network's timeout to answer.
#[tauri::command]
pub async fn existing_paths(paths: Vec<String>) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || paths.into_iter().filter(|p| Path::new(p).is_file()).collect())
        .await
        .unwrap_or_default()
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

/// Feeds Windows' Recent list and the taskbar jump list (the app is the
/// registered .md handler, so entries show under "Recent" when pinned).
#[cfg(windows)]
fn add_to_recent(path: &Path) {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{SHAddToRecentDocs, SHARD_PATHW};
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe { SHAddToRecentDocs(SHARD_PATHW as u32, wide.as_ptr().cast()) };
}

#[cfg(not(windows))]
fn add_to_recent(_path: &Path) {}

// editors briefly lock/replace the file during an atomic save
fn read_with_retry(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).or_else(|_| {
        thread::sleep(Duration::from_millis(120));
        fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))
    })
}

/// How far into a file without a BOM the UTF-16 guess looks.
const SNIFF_BYTES: usize = 4096;

/// A document's bytes as text, and how they were written (MarkdownDoc's
/// `encoding`), for whatever wrote them on Windows: UTF-8 with or without a
/// BOM (dropped), UTF-16 with a BOM (Windows PowerShell 5.1's `>` and
/// `Out-File`, Notepad's "Unicode") or without one, else the system's ANSI
/// code page (PowerShell 5.1's `Set-Content`, older apps). Never fails: what
/// cannot be decoded becomes U+FFFD.
pub(crate) fn decode_text(mut bytes: Vec<u8>) -> (String, String) {
    const UTF8: &str = "utf-8";
    if bytes.starts_with(b"\xEF\xBB\xBF") {
        bytes.drain(..3);
        let text = match String::from_utf8(bytes) {
            Ok(text) => text,
            Err(e) => mixed_utf8(e.as_bytes()).unwrap_or_else(|| String::from_utf8_lossy(e.as_bytes()).into_owned()),
        };
        // the BOM is written back on save (write_markdown's `bom`)
        return (text, "utf-8-bom".to_owned());
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return (utf16(rest, false), "utf-16le".to_owned());
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return (utf16(rest, true), "utf-16be".to_owned());
    }
    // before UTF-8: ASCII written as UTF-16 is valid UTF-8 too, full of NULs
    if let Some(big_endian) = utf16_without_bom(&bytes) {
        let name = if big_endian { "utf-16be" } else { "utf-16le" };
        return (utf16(&bytes, big_endian), name.to_owned());
    }
    match String::from_utf8(bytes) {
        Ok(text) => (text, UTF8.to_owned()),
        // UTF-8 with a few stray bytes (a line added by `echo è >>` or Set-Content) is
        // UTF-8: read whole as ANSI, its own accents would all turn into "Ã¨"
        Err(e) => match mixed_utf8(e.as_bytes()) {
            Some(text) => (text, UTF8.to_owned()),
            None => ansi(e.as_bytes()),
        },
    }
}

/// UTF-8 text with some bytes that are not UTF-8: the UTF-8 read as such, the
/// stray bytes in the ANSI code page. Some only when the UTF-8 holds at least as
/// many characters beyond ASCII as there are stray bytes: a true ANSI file has
/// none, or by chance very few.
fn mixed_utf8(bytes: &[u8]) -> Option<String> {
    let mut out = String::with_capacity(bytes.len());
    let (mut wide, mut stray) = (0usize, 0usize);
    let mut rest = bytes;
    loop {
        match std::str::from_utf8(rest) {
            Ok(s) => {
                wide += s.chars().filter(|c| !c.is_ascii()).count();
                out.push_str(s);
                break;
            }
            Err(e) => {
                let (good, after) = rest.split_at(e.valid_up_to());
                let s = std::str::from_utf8(good).unwrap_or_default();
                wide += s.chars().filter(|c| !c.is_ascii()).count();
                out.push_str(s);
                let n = e.error_len().unwrap_or(after.len()).max(1);
                stray += n;
                out.push_str(&ansi(&after[..n]).0);
                rest = &after[n..];
            }
        }
    }
    (wide > 0 && wide >= stray).then_some(out)
}

/// UTF-16 in the given byte order; a lone surrogate, or a last odd byte,
/// becomes U+FFFD.
fn utf16(bytes: &[u8], big_endian: bool) -> String {
    let units = bytes.chunks_exact(2).map(|p| {
        let pair = [p[0], p[1]];
        if big_endian {
            u16::from_be_bytes(pair)
        } else {
            u16::from_le_bytes(pair)
        }
    });
    let mut text: String = char::decode_utf16(units).map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER)).collect();
    if bytes.len() % 2 == 1 {
        text.push(char::REPLACEMENT_CHARACTER);
    }
    text
}

/// Whether bytes without a BOM look like UTF-16, and in which order
/// (Some(true): big-endian). Markdown is mostly ASCII (marks, spaces, line
/// ends), which UTF-16 writes with a zero byte in every other place: odd
/// places for little-endian, even ones for big-endian. Many zeros on one side
/// and almost none on the other, in the first SNIFF_BYTES; UTF-8 and ANSI
/// text has no zero bytes at all.
fn utf16_without_bom(bytes: &[u8]) -> Option<bool> {
    let head = &bytes[..bytes.len().min(SNIFF_BYTES) & !1];
    let units = head.len() / 2;
    let (mut even, mut odd) = (0usize, 0usize);
    for pair in head.chunks_exact(2) {
        even += usize::from(pair[0] == 0);
        odd += usize::from(pair[1] == 0);
    }
    // at least one unit in 8 with a zero there, and at most one in 8 of those on the other side
    let leans = |many: usize, few: usize| many > 0 && many * 8 >= units && few * 8 <= many;
    if leans(odd, even) {
        Some(false)
    } else if leans(even, odd) {
        Some(true)
    } else {
        None
    }
}

/// Text that is not UTF-8, in the system's ANSI code page (`GetACP`): 1252 on
/// a Western PC, 936 on a Chinese one, and so on. A system set to use UTF-8
/// as its ANSI code page (a Windows option in beta) reads it as 1252, the
/// commonest code page of such old files.
#[cfg(windows)]
fn ansi(bytes: &[u8]) -> (String, String) {
    use windows_sys::Win32::Globalization::{GetACP, CP_UTF8};
    let acp = unsafe { GetACP() };
    let cp = if acp == CP_UTF8 { 1252 } else { acp };
    match code_page(cp, bytes) {
        Some(text) => (text, format!("windows-{cp}")),
        None => (latin1(bytes), "iso-8859-1".to_owned()),
    }
}

#[cfg(not(windows))]
fn ansi(bytes: &[u8]) -> (String, String) {
    (latin1(bytes), "iso-8859-1".to_owned())
}

/// Bytes in a Windows code page, through `MultiByteToWideChar`; None when
/// Windows cannot convert them (an unknown code page, a file over 2 GB).
#[cfg(windows)]
fn code_page(cp: u32, bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    if bytes.is_empty() {
        return Some(String::new());
    }
    let len = i32::try_from(bytes.len()).ok()?;
    let need = unsafe { MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return None;
    }
    let mut wide = vec![0u16; need as usize];
    let got = unsafe { MultiByteToWideChar(cp, 0, bytes.as_ptr(), len, wide.as_mut_ptr(), need) };
    if got <= 0 {
        return None;
    }
    wide.truncate(got as usize);
    Some(String::from_utf16_lossy(&wide))
}

/// Every byte as the character of the same number.
fn latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| char::from(b)).collect()
}

/// Error from resolve_path when the page gives no folder to resolve against.
pub const NO_FOLDER: &str = "no folder";

/// The folder of the document a link or an image is in, as the page passes
/// it: a full path only. Pasted text has no folder, and an empty or relative
/// one would resolve against the working directory of the process.
fn doc_folder(dir: &str) -> Option<&Path> {
    let dir = Path::new(dir);
    dir.is_absolute().then_some(dir)
}

pub const OTHER_VOLUME: &str = "outside the document's drive or share";

/// The drive or the share a full path is on, in one spelling: `c:`, `\\server\share`.
fn volume(path: &Path) -> Option<String> {
    match path.components().next()? {
        Component::Prefix(prefix) => Some(prefix.as_os_str().to_string_lossy().replace('/', "\\").to_lowercase()),
        _ => None,
    }
}

/// What a document in `dir` names with `rel`: a path on the document's own drive or share,
/// or nothing.
///
/// A `rel` with a root of its own (`\\server\share\a.png`, `//server/share/a.png`,
/// `\\.\pipe\x`, `D:\a.png`) takes the folder's place in `join`. Windows calls the computer a
/// network path names as soon as the path is looked up, so a document that could name one
/// would choose whom the PC contacts when it is opened. `..` cannot leave a drive or a share:
/// whatever is relative stays where the document is. `C:a.png` is refused too: it is relative
/// to the folder the process happens to be in on that drive.
fn doc_target(dir: &Path, rel: &str) -> Option<PathBuf> {
    let named = Path::new(rel);
    if matches!(named.components().next(), Some(Component::Prefix(_))) && !named.is_absolute() {
        return None;
    }
    let joined = dir.join(named);
    let home = volume(dir)?;
    (volume(&joined)? == home).then_some(joined)
}

#[tauri::command]
pub fn resolve_path(dir: String, rel: String) -> Result<String, String> {
    let joined = doc_target(doc_folder(&dir).ok_or(NO_FOLDER)?, &rel).ok_or(OTHER_VOLUME)?;
    let canon = dunce::canonicalize(&joined).map_err(|e| format!("Cannot resolve {rel}: {e}"))?;
    Ok(canon.to_string_lossy().into_owned())
}

/// Resolves a document link the way a wiki would: `rel` itself, then
/// `rel.<md ext>`, then `rel/index.<ext>` and `rel/README.<ext>`. None when
/// nothing exists, or without a folder (see doc_folder). Backs "smart links"
/// between Markdown files.
#[tauri::command]
pub fn resolve_doc(dir: String, rel: String) -> Option<String> {
    let base = doc_target(doc_folder(&dir)?, &rel)?;
    let mut candidates: Vec<PathBuf> = Vec::new();
    if base.is_file() {
        candidates.push(base.clone());
    }
    for ext in MD_EXTS {
        let mut with_ext = base.clone().into_os_string();
        with_ext.push(format!(".{ext}"));
        candidates.push(PathBuf::from(with_ext));
    }
    for name in ["index", "README", "readme"] {
        for ext in MD_EXTS {
            candidates.push(base.join(format!("{name}.{ext}")));
        }
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .and_then(|p| dunce::canonicalize(p).ok())
        .map(|p| p.to_string_lossy().into_owned())
}

/// How many folder entries find_in_folder looks at, at most.
const MAX_FIND_ENTRIES: usize = 20_000;

/// A file named `name` in the document's folder `dir` or below it, any kind
/// of file: what an Obsidian-style `[[Note]]` or `![[pic.png]]` names when it
/// is not beside the document. `name` may hold folders (`img/a.png`, `/` or
/// `\`), which then end the file's path. The names compare ignoring case; the
/// match closest to `dir` wins, then the shortest path. The walk follows the
/// file pane's rules (skipped_dir, MAX_DEPTH) and stops after
/// MAX_FIND_ENTRIES entries. Err(NO_FOLDER) without a full `dir` (see
/// doc_folder); None for a name that could leave `dir` (find_segments), for a
/// folder that is not there, or when nothing matches. Off the main thread:
/// a big folder takes a while.
#[tauri::command]
pub async fn find_in_folder(dir: String, name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || find_file(&dir, &name))
        .await
        .map_err(|e| e.to_string())?
}

fn find_file(dir: &str, name: &str) -> Result<Option<String>, String> {
    let dir = doc_folder(dir).ok_or(NO_FOLDER)?;
    let Some(segments) = find_segments(name) else {
        return Ok(None);
    };
    let Ok(root) = dunce::canonicalize(dir) else {
        return Ok(None);
    };
    Ok(find_under(&root, &segments, MAX_FIND_ENTRIES).map(|p| p.to_string_lossy().into_owned()))
}

/// The names in `name`, lowercased, for find_in_folder; None for a name that
/// names something by itself or could climb out of the folder: a full path
/// (`C:\x.png`), another computer's (`\\server\share\x.png`, `//server/x`), a
/// device (`\\.\pipe\x`), one relative to a drive's current folder
/// (`C:x.png`) or to the drive's root (`\x.png`), any `..`; or nothing at all.
fn find_segments(name: &str) -> Option<Vec<String>> {
    let path = Path::new(name);
    let mut segments = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(s) => segments.push(s.to_string_lossy().to_lowercase()),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!segments.is_empty()).then_some(segments)
}

/// The walk of find_in_folder, a level at a time, so the first level with a
/// match ends it.
fn find_under(root: &Path, segments: &[String], max_entries: usize) -> Option<PathBuf> {
    let last = segments.last()?;
    let mut level = vec![root.to_path_buf()];
    let mut seen = 0usize;
    for depth in 1..=MAX_DEPTH {
        let mut deeper = Vec::new();
        let mut found: Vec<PathBuf> = Vec::new();
        'level: for folder in &level {
            let Ok(entries) = fs::read_dir(folder) else {
                continue;
            };
            for entry in entries.flatten() {
                seen += 1;
                if seen > max_entries {
                    break 'level;
                }
                // links are not followed, as in the file pane
                let Ok(kind) = entry.file_type() else {
                    continue;
                };
                let entry_name = entry.file_name().to_string_lossy().into_owned();
                if kind.is_dir() {
                    if depth < MAX_DEPTH && !skipped_dir(&entry_name) {
                        deeper.push(entry.path());
                    }
                } else if kind.is_file() && depth >= segments.len() && entry_name.to_lowercase() == *last {
                    let path = entry.path();
                    if ends_with_segments(root, &path, segments) {
                        found.push(path);
                    }
                }
            }
        }
        if let Some(best) = found.into_iter().min_by_key(|p| {
            let s = p.to_string_lossy().into_owned();
            (s.chars().count(), s.to_lowercase())
        }) {
            return Some(best);
        }
        if seen > max_entries {
            return None;
        }
        level = deeper;
    }
    None
}

/// `path`, under `root`, ends with the folders and the name in `segments`
/// (lowercased), ignoring case.
fn ends_with_segments(root: &Path, path: &Path, segments: &[String]) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    let parts: Vec<String> = rel.components().map(|c| c.as_os_str().to_string_lossy().to_lowercase()).collect();
    parts.len() >= segments.len() && parts[parts.len() - segments.len()..] == *segments
}

#[tauri::command]
pub fn parent_dir(path: String) -> Option<String> {
    let canon = dunce::canonicalize(&path).ok()?;
    let parent = canon.parent()?;
    Some(parent.to_string_lossy().into_owned())
}

// a big folder takes a while to list: off the main thread, where it would
// freeze every window (the pane lists again after every change on disk)
#[tauri::command]
pub async fn list_tree(dir: String) -> Result<TreeNode, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = dunce::canonicalize(&dir).map_err(|e| e.to_string())?;
        let mut count = 0usize;
        build_node(&root, 0, &mut count).ok_or_else(|| "No markdown files found".to_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn build_node(path: &Path, depth: usize, count: &mut usize) -> Option<TreeNode> {
    // a drive root such as `C:\` has no file_name
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    if path.is_dir() {
        if depth >= MAX_DEPTH || *count >= MAX_ENTRIES || (depth > 0 && skipped_dir(&name)) {
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
        if !is_markdown_ext(&ext) {
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

// reads every file: off the main thread, like list_tree
#[tauri::command]
pub async fn search_in_tree(dir: String, query: String) -> Result<Vec<SearchHit>, String> {
    tauri::async_runtime::spawn_blocking(move || search_files(&dir, &query))
        .await
        .map_err(|e| e.to_string())?
}

fn search_files(dir: &str, query: &str) -> Result<Vec<SearchHit>, String> {
    let root = dunce::canonicalize(dir).map_err(|e| e.to_string())?;
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    let walker = WalkDir::new(&root)
        .max_depth(MAX_DEPTH)
        .into_iter()
        .filter_entry(|e| {
            e.depth() == 0 || !e.file_type().is_dir() || !skipped_dir(&e.file_name().to_string_lossy())
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
        if !is_markdown_ext(&ext) {
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
        // read as read_markdown reads it: a file the pane lists and opens is searched too
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let (content, _) = decode_text(bytes);
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

/// export_file for binary formats: base64 payload, not-yet-existing target.
#[tauri::command]
pub fn export_binary(path: String, data: String) -> Result<(), String> {
    let p = Path::new(&path);
    let name = p.file_name().ok_or_else(|| format!("Invalid path: {path}"))?;
    let parent = p.parent().ok_or_else(|| format!("Invalid path: {path}"))?;
    let parent = dunce::canonicalize(parent).map_err(|e| format!("Cannot export to {path}: {e}"))?;
    let bytes = B64
        .decode(data.as_bytes())
        .map_err(|e| format!("Invalid data: {e}"))?;
    let target = parent.join(name);
    fs::write(&target, bytes).map_err(|e| format!("Cannot export {}: {e}", target.display()))
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

/// Watches the documents in the window's tabs, in front or behind: every
/// distinct folder once (watcher::DocWatch), "file-changed" for any of the
/// files. Replaces the window's watch; an empty list ends it. A document
/// whose file is gone is watched by its folder, so its coming back is seen.
#[tauri::command]
pub fn watch_files(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> Result<(), String> {
    let mut files: Vec<PathBuf> = Vec::new();
    for file in paths.iter().filter_map(|p| watched_file(Path::new(p))) {
        if !files.iter().any(|f| same_file(f, &file)) {
            files.push(file);
        }
    }
    let label = window.label().to_owned();
    let mut windows = state.windows.lock().unwrap();
    // a window closed meanwhile has no slot, and must not get one back
    let Some(slot) = windows.get_mut(&label) else {
        return Ok(());
    };
    if files.is_empty() {
        slot.watcher = None;
        return Ok(());
    }
    let watch = match slot.watcher.as_mut() {
        Some(watch) => watch,
        None => slot.watcher.insert(watcher::DocWatch::new(app, label)?),
    };
    watch.set_files(&files)
}

/// A document as the watch knows it: canonical; a file gone, by its folder
/// (canonical) and its name; nothing when the folder is gone too.
fn watched_file(path: &Path) -> Option<PathBuf> {
    dunce::canonicalize(path).ok().or_else(|| {
        let folder = dunce::canonicalize(path.parent()?).ok()?;
        Some(folder.join(path.file_name()?))
    })
}

/// The one document of a page from before the tabs: watch_files with it,
/// until the page calls watch_files itself.
#[tauri::command]
pub fn watch_file(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    path: String,
) -> Result<(), String> {
    watch_files(app, window, state, vec![path])
}

/// Watches the folder of the calling window's file pane (watcher::watch_tree).
/// The same folder again is a no-op unless `rearm`: the page asks for that
/// when its window comes back to the front, since Windows can drop a watch
/// without a word (a burst of changes overflowing its buffer). A drive root
/// is not watched, it is far too busy; the page checks it on focus instead.
/// `seq` (the time of the request) orders the requests, which can run out of
/// order: an older one changes nothing.
#[tauri::command]
pub async fn watch_tree(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    root: String,
    rearm: bool,
    seq: u64,
) -> Result<(), String> {
    let label = window.label().to_owned();
    let canon = dunce::canonicalize(&root).map_err(|e| e.to_string())?;
    {
        let mut windows = state.windows.lock().unwrap();
        // a window closed meanwhile has no slot, and must not get one back
        let Some(slot) = windows.get_mut(&label) else {
            return Ok(());
        };
        if seq < slot.tree_seq {
            return Ok(());
        }
        if !rearm && slot.tree_root.as_deref() == Some(canon.as_path()) && slot.tree.is_some() {
            return Ok(());
        }
        slot.tree_seq = seq;
        slot.tree_root = Some(canon.clone());
        if canon.parent().is_none() {
            slot.tree = None;
            return Ok(());
        }
    }
    // built outside the lock, which the main thread takes on window events
    let built = tauri::async_runtime::spawn_blocking({
        let canon = canon.clone();
        let label = label.clone();
        move || watcher::watch_tree(app, label, &canon)
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut windows = state.windows.lock().unwrap();
    let Some(slot) = windows.get_mut(&label) else {
        return Ok(());
    };
    if slot.tree_seq != seq {
        return Ok(()); // a newer request took over
    }
    match built {
        Ok(debouncer) => {
            slot.tree = Some(debouncer);
            Ok(())
        }
        Err(e) => {
            // no watch of the folder before: the next request must try again
            slot.tree = None;
            Err(e)
        }
    }
}

/// The page has rendered what it started with: its window shows, and the
/// launches routed to it meanwhile follow as "open-file", in order. A
/// torn-off tab's window born with `follow` comes up under the pointer and
/// follows it while the button is still down (drag.rs).
#[tauri::command]
pub fn show_window(app: AppHandle, window: WebviewWindow, state: State<'_, AppState>) {
    let (queued, follow) = {
        let mut windows = state.windows.lock().unwrap();
        match windows.get_mut(window.label()) {
            Some(slot) => (shown(slot), slot.follow.take()),
            None => (Vec::new(), None),
        }
    };
    let followed = follow.is_some_and(|f| drag::follow(&window, f));
    if !followed {
        // a window left unseen by a drop on another's strip comes back
        drag::uncloak(&window);
        let _ = window.show();
        let _ = window.set_focus();
    }
    for launch in queued {
        let _ = app.emit_to(window.label(), "open-file", &launch);
    }
}

/// A point on screen, physical px.
#[derive(Clone, Copy, Debug, Deserialize)]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// A new window, for a file (Shift+click, "Open in a new window"), empty on
/// the start page (Ctrl+Shift+N), or for a torn-off tab: `transfer` (its
/// state) reaches the new page through get_initial_file with `from` and
/// `token`, for its answer ("tab-accepted"); `at` places it (outer top-left,
/// physical px); `follow` has it follow the pointer while the button that
/// tore it is down, its ghost over another window's strip named after the
/// tab's file, or `title` for a tab without one (pasted text). Returns its
/// label. Async because on Windows a window built from a sync command
/// deadlocks WebView2 (tauri-apps/wry#583).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_window(
    app: AppHandle,
    window: WebviewWindow,
    path: Option<String>,
    line: Option<u32>,
    anchor: Option<String>,
    transfer: Option<serde_json::Value>,
    from: Option<String>,
    token: Option<String>,
    at: Option<ScreenPoint>,
    follow: Option<bool>,
    title: Option<String>,
) -> Result<String, String> {
    // a file renamed or deleted since it was listed: no window on the start
    // page. A tab carried over keeps its text, its file there or not
    if transfer.is_none() && path.as_deref().is_some_and(|p| !Path::new(p).is_file()) {
        return Err(NOT_FOUND.to_owned());
    }
    let at = at.map(|p| (p.x.round() as i32, p.y.round() as i32));
    let launch = Launch { path, line, anchor, mode: None, transfer, from, token, new_window: false };
    // the pointer is measured now, against where the page wants the window
    let follow = (follow == Some(true)).then(|| drag::Follow::new(at, launch.file().map(str::to_owned), title));
    crate::windowing::create_window(&app, Some(&window), launch, at, follow)
}

/// True when running from the Microsoft Store (MSIX) package, where the app has a
/// package identity; the NSIS build from GitHub has none.
#[tauri::command]
pub fn is_store_install() -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::ERROR_INSUFFICIENT_BUFFER;
        use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
        let mut len = 0u32;
        // unpackaged processes get APPMODEL_ERROR_NO_PACKAGE instead
        let rc = unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) };
        rc == ERROR_INSUFFICIENT_BUFFER
    }
    #[cfg(not(windows))]
    false
}

/// Renders the calling window's page to a PDF with WebView2's own printer
/// (`ICoreWebView2_7::PrintToPdf`): the `print` media styles apply, including
/// the `@page` header and footer, exactly like the print dialog's "Save as
/// PDF" but without the dialog. One job at a time; the file is overwritten.
#[tauri::command]
pub async fn print_to_pdf(window: WebviewWindow, path: String, landscape: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use tokio::sync::oneshot;
        let target = PathBuf::from(&path);
        if !target.is_absolute() {
            return Err("The PDF path must be absolute".to_owned());
        }
        if let Some(dir) = target.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let (tx, rx) = oneshot::channel::<Result<(), String>>();
        let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
        let tx_sync = tx.clone();

        // the closure runs on the UI thread, where every WebView2 call must happen
        window
            .with_webview(move |pw| {
                use webview2_com::Microsoft::Web::WebView2::Win32::*;
                use webview2_com::PrintToPdfCompletedHandler;
                use windows::core::{Interface, HSTRING};

                let tx_done = tx.clone();
                let outcome: windows::core::Result<()> = (|| unsafe {
                    let core = pw.controller().CoreWebView2()?;
                    let wv7: ICoreWebView2_7 = core.cast()?;
                    let env6: ICoreWebView2Environment6 = pw.environment().cast()?;
                    let settings = env6.CreatePrintSettings()?;
                    settings.SetOrientation(if landscape {
                        COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                    } else {
                        COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                    })?;
                    settings.SetShouldPrintBackgrounds(true)?; // code blocks, callouts, tables
                    settings.SetShouldPrintHeaderAndFooter(false)?; // drawn by the @page CSS
                    settings.SetPageWidth(8.27)?; // A4 (the default is US Letter)
                    settings.SetPageHeight(11.69)?;
                    // fallbacks only: the @page margins in print.css take precedence
                    settings.SetMarginTop(0.63)?;
                    settings.SetMarginBottom(0.63)?;
                    settings.SetMarginLeft(0.63)?;
                    settings.SetMarginRight(0.63)?;
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |hr, ok| {
                        let result = match (hr, ok) {
                            (Ok(()), true) => Ok(()),
                            (Ok(()), false) => {
                                Err("The PDF could not be written (another export may be running)".to_owned())
                            }
                            (Err(e), _) => Err(e.to_string()),
                        };
                        if let Some(tx) = tx_done.lock().unwrap().take() {
                            let _ = tx.send(result);
                        }
                        Ok(())
                    }));
                    wv7.PrintToPdf(&HSTRING::from(target.as_os_str()), &settings, &handler)
                })();
                if let Err(e) = outcome {
                    if let Some(tx) = tx.lock().unwrap().take() {
                        let _ = tx.send(Err(e.to_string()));
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        drop(tx_sync);
        rx.await.map_err(|_| "The PDF export was interrupted".to_owned())?
    }
    #[cfg(not(windows))]
    {
        let _ = (window, path, landscape);
        Err("PDF export is only available on Windows".to_owned())
    }
}

/// What a link in a document may hand to its default app: documents, sheets,
/// slides, images, media, archives, web pages. Never a program or a script, so
/// a document cannot launch one.
const OPEN_EXTERNALLY: &[&str] = &[
    "pdf", "txt", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "rtf", "doc", "docx", "xls", "xlsx",
    "ppt", "pptx", "odt", "ods", "odp", "vsdx", "drawio", "msg", "eml", "png", "jpg", "jpeg", "gif", "webp",
    "svg", "bmp", "avif", "tif", "tiff", "mp3", "wav", "m4a", "mp4", "mov", "webm", "zip", "7z", "html", "htm",
];

/// Opens a file a document links to with the app Windows associates with it,
/// for the kinds in OPEN_EXTERNALLY only.
#[tauri::command]
pub fn open_externally(path: String) -> Result<(), String> {
    let canon = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
    let ext = canon
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !canon.is_file() || !OPEN_EXTERNALLY.contains(&ext.as_str()) {
        return Err(format!("Not opened: {}", canon.display()));
    }
    tauri_plugin_opener::open_path(canon, None::<&str>).map_err(|e| e.to_string())
}

/// Mirrors the language picked in the reading settings ("auto" or a code) for
/// the next start, when WebView2's own parts take it.
#[tauri::command]
pub fn remember_language(app: AppHandle, pref: String) -> Result<(), String> {
    if pref != "auto" && !crate::UI_LANGS.contains(&pref.as_str()) {
        return Err(format!("Unknown language: {pref}"));
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(crate::language_file(&dir), pref).map_err(|e| e.to_string())
}

const STORE_REVIEW_URL: &str = "ms-windows-store://review/?ProductId=9PG51TBZ2CB1";

#[tauri::command]
pub fn open_store_review() -> Result<(), String> {
    tauri_plugin_opener::open_url(STORE_REVIEW_URL, None::<&str>).map_err(|e| e.to_string())
}

/// Asks for a rating in the Store's own dialog, over the calling window:
/// "succeeded" once the user has rated, "canceled" when they closed it.
/// Without the dialog (the GitHub build has no package identity; no network;
/// any error) the Store's review page opens instead, as with
/// open_store_review, and the answer is "fallback". An error only when even
/// that page cannot open.
#[tauri::command]
pub async fn request_store_rating(window: WebviewWindow) -> Result<&'static str, String> {
    // never without package identity: there the request does not fail, it
    // takes the whole process down (a null read on a worker thread of
    // Windows.ApplicationModel.Store.dll, Windows 11 26200)
    #[cfg(windows)]
    if is_store_install() {
        use windows::Services::Store::StoreRateAndReviewStatus as Status;
        match rate_and_review(&window).await {
            Ok(Status::Succeeded) => return Ok("succeeded"),
            Ok(Status::CanceledByUser) => return Ok("canceled"),
            _ => {}
        }
    }
    #[cfg(not(windows))]
    let _ = window;
    open_store_review().map(|()| "fallback")
}

/// The Store's rating dialog (`StoreContext::RequestRateAndReviewAppAsync`)
/// and what the user did with it. A desktop app has no CoreWindow for the
/// Store to own the dialog by: the context takes the window's handle instead
/// (IInitializeWithWindow), on the UI thread, where the dialog starts. The
/// answer comes back here, off that thread, since the dialog stays open for
/// as long as the user takes.
#[cfg(windows)]
async fn rate_and_review(
    window: &WebviewWindow,
) -> Result<windows::Services::Store::StoreRateAndReviewStatus, String> {
    use std::sync::{Arc, Mutex};
    use tokio::sync::oneshot;
    use windows::core::Interface;
    use windows::Services::Store::{StoreContext, StoreRateAndReviewResult, StoreRateAndReviewStatus};
    use windows::Win32::UI::Shell::IInitializeWithWindow;
    use windows_future::AsyncOperationCompletedHandler;

    let (tx, rx) = oneshot::channel::<Result<StoreRateAndReviewStatus, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let win = window.clone();
    window
        .run_on_main_thread(move || {
            let done = tx.clone();
            let started = win.hwnd().map_err(|e| e.to_string()).and_then(|hwnd| {
                (|| {
                    let context = StoreContext::GetDefault()?;
                    unsafe { context.cast::<IInitializeWithWindow>()?.Initialize(hwnd)? };
                    // the context lives as long as its dialog: the handler holds it
                    let keep = context.clone();
                    let handler = AsyncOperationCompletedHandler::<StoreRateAndReviewResult>::new(move |op, _| {
                        let _ = &keep;
                        // a failed or cancelled operation says so through GetResults
                        let status = op.ok().and_then(|op| op.GetResults()).and_then(|r| r.Status());
                        if let Some(tx) = done.lock().unwrap().take() {
                            let _ = tx.send(status.map_err(|e| e.to_string()));
                        }
                        Ok(())
                    });
                    context.RequestRateAndReviewAppAsync()?.SetCompleted(&handler)
                })()
                .map_err(|e: windows::core::Error| e.to_string())
            });
            if let Err(e) = started {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(Err(e));
                }
            }
        })
        .map_err(|e| e.to_string())?;
    rx.await.map_err(|_| "The rating dialog was interrupted".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listed_path_follows_the_file_pane() {
        let root = std::env::temp_dir().join(format!("leggimi-listed-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("a").join("b").join("c")).unwrap();
        fs::create_dir_all(root.join("node_modules").join("x")).unwrap();
        fs::write(root.join("note.md"), "").unwrap();
        fs::write(root.join("pic.png"), "").unwrap();

        assert!(listed_path(&root, &root.join("note.md")));
        assert!(listed_path(&root, &root.join(".draft.md")), "dot files are listed");
        assert!(listed_path(&root, &root.join("a")), "a folder");
        assert!(listed_path(&root, &root.join("gone")), "a path gone may have been a folder");
        assert!(!listed_path(&root, &root.join("pic.png")), "a file that is not Markdown");
        assert!(!listed_path(&root, &root.join("node_modules")), "a skipped folder");
        assert!(!listed_path(&root, &root.join("node_modules").join("x").join("readme.md")));
        assert!(!listed_path(&root, &root.join(".git").join("x.md")), "inside a hidden folder");
        assert!(listed_path(&root, &root.join("a").join("b").join("c").join("deep.md")), "depth 4");
        assert!(!listed_path(&root, &root.join("a").join("b").join("c").join("d").join("x.md")), "depth 5");
        assert!(!listed_path(&root, Path::new(r"C:\elsewhere\x.md")), "outside the root");
        // a save's temporary file, there or gone, whatever its name before the suffix
        fs::write(root.join(".note.md.77-0.leggimi-tmp"), "").unwrap();
        assert!(!listed_path(&root, &root.join(".note.md.77-0.leggimi-tmp")));
        assert!(!listed_path(&root, &root.join(".note.md.78-0.leggimi-tmp")), "gone");
        assert!(!listed_path(&root, &root.join("a").join("x.md.LEGGIMI-TMP")));
        // the name ReplaceFileW gives the old file for a moment, gone at once
        assert!(!listed_path(&root, &root.join("note.md~RF31df3248.TMP")));
        assert!(!listed_path(&root, &root.join("a").join("x.md~rf0.tmp")));
        assert!(listed_path(&root, &root.join("~RF1.TMP")), "nothing before it: may have been a folder");
        assert!(listed_path(&root, &root.join("plan~RFnot-hex.TMP")));
        let _ = fs::remove_dir_all(&root);
    }

    fn utf16_bytes(text: &str, big_endian: bool, bom: bool) -> Vec<u8> {
        let units = (if bom { "\u{feff}" } else { "" }).encode_utf16().chain(text.encode_utf16());
        units.flat_map(|u| if big_endian { u.to_be_bytes() } else { u.to_le_bytes() }).collect()
    }

    const ACCENTED: &str = "# Titolo\r\n\r\n- [ ] Città è già qui: «più» naïve, 中文 😀\r\n";

    #[test]
    fn documents_are_read_whatever_wrote_them() {
        let decode = |bytes: &[u8]| decode_text(bytes.to_vec());
        let pair = |text: &str, enc: &str| (text.to_owned(), enc.to_owned());
        // UTF-8, with its BOM dropped (and said, so a save writes it back) or without one
        assert_eq!(decode(ACCENTED.as_bytes()), pair(ACCENTED, "utf-8"));
        assert_eq!(decode(&[b"\xEF\xBB\xBF".as_slice(), ACCENTED.as_bytes()].concat()), pair(ACCENTED, "utf-8-bom"));
        // UTF-16 with a BOM, in both byte orders (Windows PowerShell 5.1's > and Out-File: LE)
        assert_eq!(decode(&utf16_bytes(ACCENTED, false, true)), pair(ACCENTED, "utf-16le"));
        assert_eq!(decode(&utf16_bytes(ACCENTED, true, true)), pair(ACCENTED, "utf-16be"));
        // UTF-16 without one, by its zero bytes
        assert_eq!(decode(&utf16_bytes(ACCENTED, false, false)), pair(ACCENTED, "utf-16le"));
        assert_eq!(decode(&utf16_bytes(ACCENTED, true, false)), pair(ACCENTED, "utf-16be"));
        assert_eq!(decode(&utf16_bytes("a", false, false)), pair("a", "utf-16le"), "one character");
        assert_eq!(decode(&utf16_bytes("a", true, false)), pair("a", "utf-16be"));
        // nothing at all
        assert_eq!(decode(b""), pair("", "utf-8"));
        assert_eq!(decode(b"\xEF\xBB\xBF"), pair("", "utf-8-bom"), "a BOM alone");
        assert_eq!(decode(b"\xFF\xFE"), pair("", "utf-16le"));
        // broken UTF-16: an odd last byte, a lone surrogate
        assert_eq!(decode(&[0xFF, 0xFE, b'a', 0, b'b']), pair("a\u{FFFD}", "utf-16le"));
        assert_eq!(decode(&[0xFF, 0xFE, b'a', 0, 0x00, 0xD8, b'b', 0]), pair("a\u{FFFD}b", "utf-16le"));
        // a NUL here and there does not make a UTF-8 text UTF-16
        let mut stray = "plain text, ".repeat(40).into_bytes();
        stray[101] = 0;
        assert_eq!(decode(&stray).1, "utf-8");
        // UTF-8 with a BOM and then a stray byte, no other accent: U+FFFD, still UTF-8
        assert_eq!(decode(b"\xEF\xBB\xBFcaf\xE9"), pair("caf\u{FFFD}", "utf-8-bom"));
    }

    #[cfg(windows)]
    #[test]
    fn utf8_with_a_stray_byte_stays_utf8() {
        use windows_sys::Win32::Globalization::GetACP;
        if unsafe { GetACP() } != 1252 {
            return; // the stray byte's reading depends on the code page; this PC's is 1252
        }
        // a UTF-8 plan, then a line added by `echo è >> plan.md` from cmd (the ANSI code page)
        let mut bytes = "# Città\r\n\r\nGià fatto: perché sì.\r\n".as_bytes().to_vec();
        bytes.extend_from_slice(b"- aggiunta \xE8\r\n");
        let (text, encoding) = decode_text(bytes);
        assert_eq!(encoding, "utf-8", "read as the UTF-8 it mostly is");
        assert_eq!(text, "# Città\r\n\r\nGià fatto: perché sì.\r\n- aggiunta è\r\n", "its accents whole, the stray byte read in 1252");
        // a true ANSI file with by chance no UTF-8 at all stays ANSI
        let (_, encoding) = decode_text(b"caf\xE9 cr\xE8me".to_vec());
        assert_eq!(encoding, "windows-1252");
        // more stray bytes than UTF-8 characters: ANSI (it is a 1252 file with an accident)
        let (_, encoding) = decode_text(b"\xC3\xA9 caf\xE9 cr\xE8me br\xFBl\xE9e".to_vec());
        assert_eq!(encoding, "windows-1252");
    }

    #[test]
    fn a_save_writes_the_bom_when_asked() {
        let root = std::env::temp_dir().join(format!("leggimi-bom-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let doc = root.join("bom.md");
        fs::write(&doc, "old").unwrap();
        write_markdown(doc.to_string_lossy().into_owned(), "# Città".to_owned(), None, None, Some(true)).unwrap();
        assert_eq!(fs::read(&doc).unwrap(), "\u{feff}# Città".as_bytes(), "a UTF-8 BOM, then the text");
        assert_eq!(decode_text(fs::read(&doc).unwrap()), ("# Città".to_owned(), "utf-8-bom".to_owned()), "read back: the same, with its BOM noted");
        write_markdown(doc.to_string_lossy().into_owned(), "# Città".to_owned(), None, None, None).unwrap();
        assert_eq!(fs::read(&doc).unwrap(), "# Città".as_bytes(), "without: no BOM");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn text_that_is_not_utf8_is_read_in_the_system_code_page() {
        use windows_sys::Win32::Globalization::GetACP;
        // Windows-1252 as such, whatever this PC's code page
        assert_eq!(code_page(1252, b"caf\xE9 \x80 \x93ok\x94").as_deref(), Some("café € “ok”"));
        assert_eq!(code_page(1252, b"").as_deref(), Some(""));
        assert_eq!(code_page(936, b"\xD6\xD0\xCE\xC4").as_deref(), Some("中文"), "GBK, a Chinese PC's");
        assert_eq!(code_page(0xFFFF_FFF0, b"x"), None, "a code page Windows does not know");
        // what decode_text does with it: the system's code page, by name
        let (text, encoding) = decode_text(b"# Citt\xE0 \xE8 gi\xE0 qui, caf\xE9".to_vec());
        let acp = unsafe { GetACP() };
        let cp = if acp == 65001 { 1252 } else { acp };
        assert_eq!(encoding, format!("windows-{cp}"));
        if cp == 1252 {
            assert_eq!(text, "# Città è già qui, café");
        } else {
            println!("system code page {acp}: {text:?}");
        }
    }

    #[test]
    fn the_folder_search_reads_what_read_markdown_reads() {
        let root = std::env::temp_dir().join(format!("leggimi-search-enc-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("ps51.md"), utf16_bytes(ACCENTED, false, true)).unwrap();
        fs::write(root.join("ansi.md"), b"# Men\xF9\r\n\r\nCaff\xE8 lungo\r\n").unwrap();
        let hits = search_files(&root.to_string_lossy(), "CITTÀ").unwrap();
        assert_eq!(hits.len(), 1, "{:?}", hits.iter().map(|h| &h.preview).collect::<Vec<_>>());
        assert_eq!((hits[0].name.as_str(), hits[0].line), ("ps51.md", 3));
        assert!(hits[0].preview.contains("Città è già qui"), "{}", hits[0].preview);
        #[cfg(windows)]
        if unsafe { windows_sys::Win32::Globalization::GetACP() } == 1252 {
            let hits = search_files(&root.to_string_lossy(), "caffè").unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!((hits[0].name.as_str(), hits[0].line, hits[0].preview.as_str()), ("ansi.md", 3, "Caffè lungo"));
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// B-06's proof, again: the five files Windows PowerShell 5.1 writes with
    /// `>`, `Out-File`, `Set-Content`, `Out-File -Encoding utf8` and
    /// `[IO.File]::WriteAllText` (analisi-2.2.0, prove/data/read_proof.ps1),
    /// all read with their accented letters. Runs powershell.exe, so not by
    /// default: `cargo test --lib -- --ignored --nocapture powershell`. The
    /// `Set-Content` file is ANSI: on a PC whose code page has no à it holds `?`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_the_files_windows_powershell_writes() {
        let dir = std::env::temp_dir().join(format!("leggimi-ps51-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let script = r##"$dir = $args[0]
$text = "# Titolo`r`n`r`n- [ ] Citt$([char]0xE0) $([char]0xE8) gi$([char]0xE0) qui`r`n"
$text > (Join-Path $dir 'ps51-redirect.md')
$text | Out-File (Join-Path $dir 'ps51-out-file.md')
$text | Set-Content (Join-Path $dir 'ps51-set-content.md')
$text | Out-File -Encoding utf8 (Join-Path $dir 'ps51-utf8-bom.md')
[IO.File]::WriteAllText((Join-Path $dir 'utf8-no-bom.md'), $text)
"PowerShell $($PSVersionTable.PSVersion)"
"##;
        let ps1 = dir.join("make.ps1");
        fs::write(&ps1, script).unwrap();
        let out = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(&ps1)
            .arg(&dir)
            .output()
            .expect("Windows PowerShell");
        println!("{}", String::from_utf8_lossy(&out.stdout).trim());
        let expected = [
            ("ps51-out-file.md", "utf-16le"),
            ("ps51-redirect.md", "utf-16le"),
            ("ps51-set-content.md", "windows-"),
            ("ps51-utf8-bom.md", "utf-8-bom"),
            ("utf8-no-bom.md", "utf-8"),
        ];
        for (name, encoding) in expected {
            let bytes = fs::read(dir.join(name)).unwrap();
            let head: Vec<String> = bytes.iter().take(8).map(|b| format!("{b:02X}")).collect();
            let (text, found) = decode_text(read_with_retry(&dir.join(name)).unwrap());
            println!("{name}: first bytes {} -> {found}, {} chars: {text:?}", head.join(" "), text.chars().count());
            assert!(found.starts_with(encoding), "{name}: {found}");
            assert!(text.contains("- [ ] Città è già qui"), "{name}: {text:?}");
            assert!(text.starts_with("# Titolo"), "{name}: no BOM left");
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// The file's identity on its volume: a file replaced (ReplaceFileW) is
    /// a new one under the old name, one written in place is the same.
    #[cfg(windows)]
    fn file_index(path: &Path) -> u64 {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION};
        let file = fs::File::open(path).unwrap();
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        assert_ne!(unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) }, 0);
        (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow)
    }

    /// The folder's temporary files from saves: none should be left.
    fn temps_in(dir: &Path) -> Vec<String> {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(TEMP_SUFFIX))
            .collect()
    }

    fn save(path: &Path, content: &str, expected: Option<u64>, create: Option<bool>) -> Result<u64, String> {
        write_markdown(path.to_string_lossy().into_owned(), content.to_owned(), expected, create, None)
    }

    #[cfg(windows)]
    #[test]
    fn a_save_replaces_the_whole_file_and_keeps_what_it_was() {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::{FileTimesExt, MetadataExt};
        use windows_sys::Win32::Storage::FileSystem::{SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN};

        let root = std::env::temp_dir().join(format!("leggimi-save-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let doc = root.join("notes.md");
        fs::write(&doc, "old text, longer than the new one\r\n".repeat(1000)).unwrap();
        // created long ago, and hidden: both must survive the save
        let created = UNIX_EPOCH + Duration::from_secs(1_577_836_800); // 2020-01-01
        fs::OpenOptions::new()
            .write(true)
            .open(&doc)
            .unwrap()
            .set_times(fs::FileTimes::new().set_created(created))
            .unwrap();
        let wide: Vec<u16> = doc.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        assert_ne!(unsafe { SetFileAttributesW(wide.as_ptr(), FILE_ATTRIBUTE_HIDDEN) }, 0);
        let before = file_index(&doc);
        let read_at = modified_ms(&doc);
        std::thread::sleep(Duration::from_millis(20));

        let saved = save(&doc, "# New\r\n", Some(read_at), None).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# New\r\n", "all of it, nothing of the old text");
        assert_eq!(saved, modified_ms(&doc), "the new modification time, for the next save's guard");
        assert_ne!(saved, read_at);
        assert_ne!(file_index(&doc), before, "replaced, not written in place");
        assert!(temps_in(&root).is_empty(), "{:?}", temps_in(&root));
        let meta = fs::metadata(&doc).unwrap();
        assert_eq!(meta.created().unwrap(), created, "the creation time");
        assert_ne!(meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN, 0, "the attributes");

        // the guard still refuses a file changed since it was read
        assert_eq!(save(&doc, "other", Some(read_at), None), Err(CONFLICT.to_owned()));
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# New\r\n");
        // 0 overwrites anyway; and a save again, over the replaced file
        let again = save(&doc, "# Again\r\n", Some(0), None).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# Again\r\n");
        assert_eq!(save(&doc, "# Third\r\n", Some(again), None).map(|_| ()), Ok(()));
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# Third\r\n");
        assert!(temps_in(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    /// A save in a folder of your choice, for the disks the other tests do not
    /// reach (a share, a OneDrive folder, a USB stick): it writes one test file
    /// there, saves it twice and removes it. `LEGGIMI_SAVE_DIR=<folder> cargo
    /// test --lib -- --ignored --nocapture a_save_in_the_folder`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn a_save_in_the_folder_of_leggimi_save_dir() {
        let dir = PathBuf::from(std::env::var("LEGGIMI_SAVE_DIR").expect("LEGGIMI_SAVE_DIR: the folder to try"));
        let doc = dir.join(format!("leggimi-save-check-{}.md", std::process::id()));
        fs::write(&doc, "old text\r\n".repeat(100)).unwrap();
        let created = fs::metadata(&doc).unwrap().created().unwrap();
        let before = file_index(&doc);
        std::thread::sleep(Duration::from_millis(20));
        let first = save(&doc, "# First\r\n", Some(modified_ms(&doc)), None);
        let replaced = file_index(&doc) != before;
        let second = save(&doc, "# Second\r\n", first.clone().ok(), None);
        let text = fs::read_to_string(&doc).unwrap();
        let kept = fs::metadata(&doc).unwrap().created().unwrap() == created;
        let temps = temps_in(&dir);
        println!(
            "{}: first {first:?}, second {second:?}, replaced (new file id) {replaced}, creation time kept {kept}, text {text:?}, temporary files left {temps:?}",
            dir.display()
        );
        let _ = fs::remove_file(&doc);
        assert!(first.is_ok() && second.is_ok());
        assert_eq!(text, "# Second\r\n");
        assert!(kept, "the creation time");
        assert!(temps.is_empty());
    }

    #[cfg(windows)]
    #[test]
    #[allow(clippy::permissions_set_readonly_false)] // Windows only: it clears the read-only attribute
    fn a_read_only_file_is_refused_and_left_whole() {
        let root = std::env::temp_dir().join(format!("leggimi-save-ro-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let doc = root.join("locked.md");
        fs::write(&doc, "keep me").unwrap();
        let mut perms = fs::metadata(&doc).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&doc, perms.clone()).unwrap();

        let err = save(&doc, "lost", None, None).unwrap_err();
        assert!(err.starts_with("Cannot save "), "the in-place write's own error: {err}");
        assert_eq!(fs::read_to_string(&doc).unwrap(), "keep me");
        assert!(fs::metadata(&doc).unwrap().permissions().readonly(), "still read-only");
        assert!(temps_in(&root).is_empty(), "{:?}", temps_in(&root));

        perms.set_readonly(false);
        fs::set_permissions(&doc, perms).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// ReplaceFileW fails when another app has the file open without letting
    /// it be renamed or deleted: the save falls back to the in-place write,
    /// which that app allows, and leaves no temporary file.
    #[cfg(windows)]
    #[test]
    fn a_file_another_app_keeps_open_is_written_in_place() {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
        let root = std::env::temp_dir().join(format!("leggimi-save-held-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let doc = root.join("held.md");
        fs::write(&doc, "old").unwrap();
        let before = file_index(&doc);
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .open(&doc)
            .unwrap();

        assert_eq!(replace_whole(&doc, b"never"), Err(NotReplaced::Untouched), "ReplaceFileW refused");
        assert_eq!(fs::read_to_string(&doc).unwrap(), "old", "untouched");
        assert!(temps_in(&root).is_empty(), "{:?}", temps_in(&root));
        save(&doc, "# Written in place\r\n", None, None).unwrap();
        drop(held);
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# Written in place\r\n");
        assert_eq!(file_index(&doc), before, "the same file");
        assert!(temps_in(&root).is_empty(), "{:?}", temps_in(&root));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn a_file_with_other_names_is_written_in_place() {
        let root = std::env::temp_dir().join(format!("leggimi-save-link-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let doc = root.join("doc.md");
        let other = root.join("same-file.md");
        fs::write(&doc, "old").unwrap();
        fs::hard_link(&doc, &other).unwrap();
        let before = file_index(&doc);

        save(&doc, "new for both names", None, None).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "new for both names");
        assert_eq!(fs::read_to_string(&other).unwrap(), "new for both names", "the other name sees it");
        assert_eq!(file_index(&doc), before, "the same file, written in place");
        assert!(temps_in(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_file_is_written_only_when_asked_to_create_it() {
        let root = std::env::temp_dir().join(format!("leggimi-save-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let doc = root.join("gone.md");
        assert!(save(&doc, "x", None, None).unwrap_err().starts_with("Cannot save "));
        assert!(!doc.exists(), "not written back without create");
        let modified = save(&doc, "# Back\r\n", Some(12345), Some(true)).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# Back\r\n");
        assert_eq!(modified, modified_ms(&doc));
        // create on a file that is there: replaced like any other save
        save(&doc, "# Again\r\n", None, Some(true)).unwrap();
        assert_eq!(fs::read_to_string(&doc).unwrap(), "# Again\r\n");
        assert!(temps_in(&root).is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn a_temporary_file_names_the_file_it_stands_in_for() {
        let doc = Path::new(r"C:\docs\notes.v2.md");
        let temp = temp_beside(doc).unwrap();
        let name = temp.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with(".notes.v2.md.") && name.ends_with(TEMP_SUFFIX), "{name}");
        assert_eq!(temp.parent(), doc.parent(), "beside it, on the same volume");
        assert_ne!(temp_beside(doc), Some(temp.clone()), "two saves, two names");
        assert_eq!(replaced_by(&temp).as_deref(), Some(doc));
        for other in [r"C:\docs\notes.md", r"C:\docs\.notes.md.leggimi-tmp", r"C:\docs\..12-0.leggimi-tmp", r"C:\docs\.a.md.12-x.leggimi-tmp", r"C:\docs\a.md.12-0.leggimi-tmp"] {
            assert_eq!(replaced_by(Path::new(other)), None, "{other}");
        }
    }

    /// A tree for find_in_folder, under a folder of its own (`base`) so that
    /// something can sit just outside it.
    #[cfg(windows)]
    fn find_tree(tag: &str) -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("leggimi-find-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let root = base.join("vault");
        let files = [
            "pic.png",
            r"a\pic.png",
            r"a\b\c\far.png",
            r"a\b\c\d\too-far.png",
            r".obsidian\hidden.png",
            r"node_modules\x\module.png",
            r"img\a.png",
            r"x\img\a.png",
            r"longer\same.png",
            r"zz\same.png",
            r"Notes\Città Nuova.MD",
            r"deep\down\only-here.pdf",
            r"folder-not-file.png\inside.txt",
        ];
        for f in files {
            let p = root.join(f);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, "").unwrap();
        }
        fs::write(base.join("outside.png"), "").unwrap();
        (base, dunce::canonicalize(root).unwrap())
    }

    #[cfg(windows)]
    #[test]
    fn find_in_folder_takes_the_closest_file_of_that_name() {
        let (base, root) = find_tree("closest");
        let dir = root.to_string_lossy().into_owned();
        let find = |name: &str| find_file(&dir, name).unwrap();
        let at = |rel: &str| Some(root.join(rel).to_string_lossy().into_owned());

        assert_eq!(find("pic.png"), at("pic.png"), "the shallowest of two");
        assert_eq!(find("PIC.PNG"), at("pic.png"), "case does not matter; the file's own case comes back");
        assert_eq!(find("./pic.png"), at("pic.png"));
        assert_eq!(find("same.png"), at(r"zz\same.png"), "same depth: the shortest path");
        assert_eq!(find("far.png"), at(r"a\b\c\far.png"), "as deep as the file pane goes");
        assert_eq!(find("too-far.png"), None, "deeper than the file pane");
        assert_eq!(find("only-here.pdf"), at(r"deep\down\only-here.pdf"), "any kind of file");
        assert_eq!(find("città nuova.md"), at(r"Notes\Città Nuova.MD"), "case beyond ASCII");
        assert_eq!(find("hidden.png"), None, "not in a dot folder");
        assert_eq!(find("module.png"), None, "not in a skipped folder");
        assert_eq!(find("folder-not-file.png"), None, "a folder is not a file");
        assert_eq!(find("missing.png"), None);
        // a name with folders ends the path, with either slash
        assert_eq!(find("img/a.png"), at(r"img\a.png"), "the shallowest of two");
        assert_eq!(find(r"IMG\A.png"), at(r"img\a.png"));
        assert_eq!(find("x/img/a.png"), at(r"x\img\a.png"));
        assert_eq!(find("b/c/far.png"), at(r"a\b\c\far.png"));
        assert_eq!(find("y/img/a.png"), None, "every folder named must match");
        assert_eq!(find("a.png"), at(r"img\a.png"));
        // a folder that is not there: nothing found
        let gone = root.join("gone").to_string_lossy().into_owned();
        assert_eq!(find_file(&gone, "pic.png"), Ok(None));
        // the walk stops after so many entries
        assert_eq!(find_under(&root, &["far.png".to_owned()], 5), None);
        assert_eq!(find_under(&root, &["far.png".to_owned()], MAX_FIND_ENTRIES), Some(root.join(r"a\b\c\far.png")));
        let _ = fs::remove_dir_all(&base);
    }

    #[cfg(windows)]
    #[test]
    fn find_in_folder_refuses_names_that_could_leave_the_folder() {
        let (base, root) = find_tree("refuse");
        let dir = root.to_string_lossy().into_owned();
        let pic = root.join("pic.png").to_string_lossy().into_owned();
        let refused = [
            "",
            ".",
            "..",
            "../outside.png",
            r"..\outside.png",
            "img/../pic.png",
            r"a\..\..\outside.png",
            pic.as_str(),                    // a full path, even to a file that is there
            r"\pic.png",                     // the root of the current drive
            "/pic.png",
            r"\\server\share\pic.png",       // another computer
            "//server/share/pic.png",
            r"\\127.0.0.1\c$\pic.png",
            r"\\.\pipe\leggimi",             // a device
            r"\\?\C:\pic.png",
            r"\\?\UNC\server\share\pic.png",
            "C:pic.png",                     // the drive's current folder
            "D:pic.png",
            r"C:\pic.png",
        ];
        for name in refused {
            assert_eq!(find_file(&dir, name), Ok(None), "{name:?}");
            assert_eq!(find_segments(name), None, "{name:?}");
        }
        // pasted text has no folder: never the process's working directory
        for dir in ["", "vault", r".\vault", r"\docs", "C:docs"] {
            assert_eq!(find_file(dir, "pic.png"), Err(NO_FOLDER.to_owned()), "{dir:?}");
        }
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn links_resolve_only_against_a_full_folder() {
        let root = std::env::temp_dir().join(format!("leggimi-resolve-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("guide")).unwrap();
        fs::write(root.join("a.md"), "").unwrap();
        fs::write(root.join("guide").join("README.md"), "").unwrap();
        let canon = |p: PathBuf| dunce::canonicalize(p).unwrap().to_string_lossy().into_owned();
        let dir = root.to_string_lossy().into_owned();

        assert_eq!(resolve_path(dir.clone(), "a.md".into()), Ok(canon(root.join("a.md"))));
        assert_eq!(resolve_doc(dir.clone(), "a".into()), Some(canon(root.join("a.md"))), "a link without .md");
        assert_eq!(resolve_doc(dir.clone(), "guide".into()), Some(canon(root.join("guide").join("README.md"))));
        // pasted text has no folder: never the process's working directory
        for dir in ["", "guide", r".\guide", r"\docs", "C:docs"] {
            assert_eq!(resolve_path(dir.into(), "a.md".into()), Err(NO_FOLDER.to_owned()), "{dir:?}");
            assert_eq!(resolve_doc(dir.into(), "a".into()), None, "{dir:?}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// Path arithmetic only: nothing here is looked up, so no computer is called.
    #[test]
    fn a_document_names_files_on_its_own_drive_or_share_only() {
        let on_disk = Path::new(r"C:\Users\someone\Documents\notes");
        let stays = |dir: &Path, rel: &str| doc_target(dir, rel).is_some();

        // what is relative stays with the document, however far up it goes
        for rel in ["a.png", "img/a.png", r"img\a.png", "../a.png", "../../../../a.png", "./a b.png", "/a.png", r"\a.png"] {
            assert!(stays(on_disk, rel), "{rel:?}");
        }
        assert_eq!(doc_target(on_disk, "img/a.png"), Some(on_disk.join("img/a.png")));
        // the same drive spelled out, in either case
        assert!(stays(on_disk, r"C:\Windows\a.png"));
        assert!(stays(on_disk, "c:/Windows/a.png"));

        // another computer, a device, another drive: whatever the slashes
        for rel in [
            r"\\server\share\a.png",
            "//server/share/a.png",
            r"\/server/share/a.png",
            r"/\server\share\a.png",
            "//server.example@8080/DavWWWRoot/a.png",
            "//127.0.0.1/share/a.png",
            r"\\.\pipe\leggimi",
            "//./pipe/leggimi",
            r"\\?\C:\Windows\a.png",
            r"\\?\UNC\server\share\a.png",
            r"D:\a.png",
            "D:/a.png",
            // relative to wherever the process is on that drive
            "C:a.png",
            "D:a.png",
        ] {
            assert!(!stays(on_disk, rel), "{rel:?}");
        }

        // a document that is itself on a share keeps its own files, and those only
        for on_share in [r"\\nas\docs\notes", "//nas/docs/notes", r"\\NAS\Docs\notes"] {
            let on_share = Path::new(on_share);
            for rel in ["img/a.png", "../a.png", "/a.png", r"\\nas\docs\other\a.png", "//nas/docs/a.png"] {
                assert!(stays(on_share, rel), "{on_share:?} {rel:?}");
            }
            for rel in [r"\\nas\other\a.png", "//elsewhere/docs/a.png", r"C:\Windows\a.png", r"\\.\pipe\leggimi"] {
                assert!(!stays(on_share, rel), "{on_share:?} {rel:?}");
            }
        }
        // as Windows itself names a file opened from a mapped drive
        let verbatim = Path::new(r"\\?\UNC\nas\docs\notes");
        assert!(stays(verbatim, r"img\a.png"));
        assert!(!stays(verbatim, r"\\elsewhere\docs\a.png"));

        // the commands answer the same, before they touch the disk
        let dir = on_disk.to_string_lossy().into_owned();
        assert_eq!(resolve_path(dir.clone(), "//server/share/a.png".into()), Err(OTHER_VOLUME.to_owned()));
        assert_eq!(resolve_path(dir.clone(), r"\\server\share\a.png".into()), Err(OTHER_VOLUME.to_owned()));
        assert_eq!(resolve_doc(dir.clone(), "//server/share/readme".into()), None);
        assert_eq!(resolve_doc(dir, r"\\server\share\readme".into()), None);
    }
}
