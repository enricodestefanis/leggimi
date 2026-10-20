use std::{
    ffi::OsString,
    path::{Path, PathBuf},
    time::Duration,
};

use notify::event::{ModifyKind, RenameMode};
use notify::{EventKind, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{
    new_debouncer, new_debouncer_opt, DebounceEventResult, DebouncedEvent, Debouncer, NoCache,
    RecommendedCache,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// What became of a window's document: still there (`changed`), renamed in
/// its folder (`renamed`, to `to`), or gone (`removed`: deleted, or moved out
/// of the folder).
#[derive(Clone, Serialize)]
pub struct FileChange {
    pub kind: &'static str,
    pub path: String,
    pub to: Option<String>,
}

// Watch the parent directory, not the file itself: editors doing atomic saves
// (write temp file, rename over target) would kill a watch on the file. The
// change goes to the window (`label`) that shows the file, not to all of them.
pub fn watch(
    app: AppHandle,
    label: String,
    file: &Path,
) -> Result<Debouncer<RecommendedWatcher, RecommendedCache>, String> {
    let parent = file
        .parent()
        .ok_or("File has no parent directory")?
        .to_path_buf();
    let file_name = file.file_name().ok_or("Invalid file name")?.to_os_string();
    let watched = file.to_path_buf();

    // the default cache (file ids, on Windows) is what pairs the two halves
    // of a rename into one event, [old, new]
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |result: DebounceEventResult| {
            if let Ok(events) = result {
                let touched = events.iter().any(|e| {
                    e.paths
                        .iter()
                        .any(|p| p.file_name() == Some(file_name.as_os_str()))
                });
                if touched {
                    let _ = app.emit_to(label.as_str(), "file-changed", classify(&watched, &file_name, &events));
                }
            }
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(&parent, RecursiveMode::NonRecursive)
        .map_err(|e| e.to_string())?;

    Ok(debouncer)
}

// A file still there was changed, whatever the events say: an atomic save
// renames a temp file over it, vim renames it away and writes it anew. One
// that is gone was renamed when a rename chain leads from its name to a file
// that exists, else removed.
fn classify(watched: &Path, file_name: &OsString, events: &[DebouncedEvent]) -> FileChange {
    let path = watched.to_string_lossy().into_owned();
    if watched.exists() {
        return FileChange { kind: "changed", path, to: None };
    }
    let mut name = file_name.clone();
    let mut to: Option<PathBuf> = None;
    for e in events {
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = e.kind {
            if e.paths.len() == 2 && e.paths[0].file_name() == Some(name.as_os_str()) {
                if let Some(next) = e.paths[1].file_name() {
                    name = next.to_os_string();
                    to = Some(e.paths[1].clone());
                }
            }
        }
    }
    match to.filter(|p| p.is_file()) {
        Some(p) => FileChange {
            kind: "renamed",
            path,
            to: Some(p.to_string_lossy().into_owned()),
        },
        None => FileChange { kind: "removed", path, to: None },
    }
}

/// Watches the folder of a window's file pane, subfolders included, and
/// tells that window when what it lists may have changed: a Markdown file or
/// a folder created, removed or renamed. The page lists the folder again and
/// redraws only when the listing differs. No file-id cache: it would walk the
/// whole tree up front, and nothing here needs renames paired.
pub fn watch_tree(
    app: AppHandle,
    label: String,
    root: &Path,
) -> Result<Debouncer<RecommendedWatcher, NoCache>, String> {
    let base = root.to_path_buf();
    let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, NoCache>(
        Duration::from_millis(400),
        None,
        move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            // writes inside files never change the listing: saves are not news
            let relevant = events.iter().any(|e| {
                matches!(
                    e.kind,
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(ModifyKind::Name(_))
                ) && e.paths.iter().any(|p| crate::commands::listed_path(&base, p))
            });
            if relevant {
                let _ = app.emit_to(label.as_str(), "tree-changed", ());
            }
        },
        NoCache,
        notify::Config::default(),
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watch(root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    Ok(debouncer)
}

#[cfg(test)]
mod tests {
    use super::*;
    use notify::Event;
    use std::time::Instant;

    fn rename(from: &Path, to: &Path) -> DebouncedEvent {
        let kind = EventKind::Modify(ModifyKind::Name(RenameMode::Both));
        DebouncedEvent::new(Event::new(kind).add_path(from.to_path_buf()).add_path(to.to_path_buf()), Instant::now())
    }

    #[test]
    fn classify_tells_changed_renamed_removed() {
        let dir = std::env::temp_dir().join(format!("leggimi-classify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let doc = dir.join("doc.md");
        let name = OsString::from("doc.md");

        // still there, whatever happened around it (an atomic save renames a temp over it)
        std::fs::write(&doc, "x").unwrap();
        let c = classify(&doc, &name, &[rename(&dir.join("doc.md.tmp"), &doc)]);
        assert_eq!(c.kind, "changed");

        // renamed, also through a chain of renames in one batch
        std::fs::rename(&doc, dir.join("final.md")).unwrap();
        let c = classify(&doc, &name, &[rename(&doc, &dir.join("mid.md")), rename(&dir.join("mid.md"), &dir.join("final.md"))]);
        assert_eq!(c.kind, "renamed");
        assert_eq!(c.to.as_deref(), Some(dir.join("final.md").to_string_lossy().as_ref()));

        // gone: deleted, or renamed to a file that is no longer there either
        let c = classify(&doc, &name, &[rename(&doc, &dir.join("nowhere.md"))]);
        assert_eq!(c.kind, "removed");
        let c = classify(&doc, &name, &[]);
        assert_eq!(c.kind, "removed");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
