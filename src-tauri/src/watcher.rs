use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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

use crate::same_file;

/// What became of a document open in a window: still there (`changed`),
/// renamed in its folder (`renamed`, to `to`), or gone (`removed`: deleted,
/// or moved out of the folder).
#[derive(Clone, Serialize)]
pub struct FileChange {
    pub kind: &'static str,
    pub path: String,
    pub to: Option<String>,
}

/// One window's watch on the documents in its tabs, in front or not, so a
/// tab behind also learns that its file changed, moved or went.
///
/// It watches the folders, not the files: editors doing atomic saves (write
/// a temp file, rename it over the target) would kill a watch on the file.
/// Every distinct folder once, not recursively; a change goes to that window
/// only, once per document it touches ("file-changed").
pub struct DocWatch {
    debouncer: Debouncer<RecommendedWatcher, RecommendedCache>,
    /// the folders watched now
    dirs: Vec<PathBuf>,
    /// the documents reported on, shared with the debouncer's thread
    files: Arc<Mutex<Vec<PathBuf>>>,
}

impl DocWatch {
    /// A watch for the window `label`, on nothing yet (set_files).
    pub fn new(app: AppHandle, label: String) -> Result<DocWatch, String> {
        let shared: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let watched = shared.clone();
        // the default cache (file ids, on Windows) is what pairs the two
        // halves of a rename into one event, [old, new]
        let debouncer = new_debouncer(Duration::from_millis(300), None, move |result: DebounceEventResult| {
            let Ok(events) = result else { return };
            let files = watched.lock().unwrap().clone();
            for file in files.iter().filter(|f| touched(f, &events)) {
                let _ = app.emit_to(label.as_str(), "file-changed", classify(file, &events));
            }
        })
        .map_err(|e| e.to_string())?;
        Ok(DocWatch { debouncer, dirs: Vec::new(), files: shared })
    }

    /// Follows the window's documents now: the folders no longer needed are
    /// let go, the new ones watched, the others kept (a watch made again
    /// could miss a change meanwhile). A folder that cannot be watched (gone,
    /// no access) leaves the others watched and is the error.
    pub fn set_files(&mut self, files: &[PathBuf]) -> Result<(), String> {
        let mut dirs: Vec<PathBuf> = Vec::new();
        for dir in files.iter().filter_map(|f| f.parent()) {
            if !dirs.iter().any(|d| same_file(d, dir)) {
                dirs.push(dir.to_path_buf());
            }
        }
        let mut failed = None;
        for gone in self.dirs.iter().filter(|d| !dirs.iter().any(|n| same_file(n, d))) {
            let _ = self.debouncer.unwatch(gone);
        }
        let mut now: Vec<PathBuf> = Vec::new();
        for dir in dirs {
            if self.dirs.iter().any(|d| same_file(d, &dir)) {
                now.push(dir);
                continue;
            }
            match self.debouncer.watch(&dir, RecursiveMode::NonRecursive) {
                Ok(()) => now.push(dir),
                Err(e) => failed = Some(format!("Cannot watch {}: {e}", dir.display())),
            }
        }
        self.dirs = now;
        *self.files.lock().unwrap() = files.to_vec();
        failed.map_or(Ok(()), Err)
    }

    /// The folders watched now.
    pub fn dirs(&self) -> &[PathBuf] {
        &self.dirs
    }
}

/// One of the events names the document.
fn touched(file: &Path, events: &[DebouncedEvent]) -> bool {
    events.iter().any(|e| e.paths.iter().any(|p| same_file(p, file)))
}

// A file still there was changed, whatever the events say: an atomic save
// renames a temp file over it, vim renames it away and writes it anew. One
// that is gone was renamed when a rename chain leads from it to a file that
// exists, else removed.
fn classify(watched: &Path, events: &[DebouncedEvent]) -> FileChange {
    let path = watched.to_string_lossy().into_owned();
    if watched.exists() {
        return FileChange { kind: "changed", path, to: None };
    }
    let mut at = watched.to_path_buf();
    let mut to: Option<PathBuf> = None;
    for e in events {
        if let EventKind::Modify(ModifyKind::Name(RenameMode::Both)) = e.kind {
            if e.paths.len() == 2 && same_file(&e.paths[0], &at) {
                at = e.paths[1].clone();
                to = Some(at.clone());
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

        // still there, whatever happened around it (an atomic save renames a temp over it)
        std::fs::write(&doc, "x").unwrap();
        let c = classify(&doc, &[rename(&dir.join("doc.md.tmp"), &doc)]);
        assert_eq!(c.kind, "changed");

        // renamed, also through a chain of renames in one batch
        std::fs::rename(&doc, dir.join("final.md")).unwrap();
        let c = classify(&doc, &[rename(&doc, &dir.join("mid.md")), rename(&dir.join("mid.md"), &dir.join("final.md"))]);
        assert_eq!(c.kind, "renamed");
        assert_eq!(c.to.as_deref(), Some(dir.join("final.md").to_string_lossy().as_ref()));

        // gone: deleted, or renamed to a file that is no longer there either
        let c = classify(&doc, &[rename(&doc, &dir.join("nowhere.md"))]);
        assert_eq!(c.kind, "removed");
        let c = classify(&doc, &[]);
        assert_eq!(c.kind, "removed");

        // a file of the same name in another watched folder is another document
        let other = dir.join("sub");
        std::fs::create_dir_all(&other).unwrap();
        let c = classify(&doc, &[rename(&other.join("doc.md"), &other.join("final.md"))]);
        assert_eq!(c.kind, "removed", "not renamed by another folder's rename");
        assert!(touched(&doc, &[rename(&dir.join("DOC.md"), &dir.join("x.md"))]), "case does not matter");
        assert!(!touched(&doc, &[rename(&other.join("doc.md"), &other.join("x.md"))]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn one_watch_follows_the_folders_of_the_tabs() {
        let root = std::env::temp_dir().join(format!("leggimi-docwatch-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (a, b) = (root.join("a"), root.join("b"));
        std::fs::create_dir_all(&a).unwrap();
        std::fs::create_dir_all(&b).unwrap();
        let (tx, rx) = std::sync::mpsc::channel::<Vec<PathBuf>>();
        // DocWatch's own parts, its debouncer reporting what it saw (the
        // real one sends "file-changed" to a window)
        let files: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
        let seen = files.clone();
        let debouncer = new_debouncer(Duration::from_millis(100), None, move |r: DebounceEventResult| {
            if let Ok(events) = r {
                let hit: Vec<PathBuf> = seen.lock().unwrap().iter().filter(|f| touched(f, &events)).cloned().collect();
                if !hit.is_empty() {
                    let _ = tx.send(hit);
                }
            }
        })
        .unwrap();
        let mut w = DocWatch { debouncer, dirs: Vec::new(), files };
        let docs = [a.join("one.md"), a.join("two.md"), b.join("three.md")];
        w.set_files(&docs).unwrap();
        assert_eq!(w.dirs().len(), 2, "two folders for three documents");
        std::fs::write(&docs[2], "x").unwrap();
        let hit = rx.recv_timeout(Duration::from_secs(5)).expect("a change in the second folder");
        assert!(hit.iter().any(|p| same_file(p, &docs[2])));
        // the tab of folder b closed: b is let go, a kept
        w.set_files(&docs[..2]).unwrap();
        assert_eq!(w.dirs().len(), 1);
        std::fs::write(&docs[2], "y").unwrap();
        std::fs::write(&docs[1], "y").unwrap();
        let hit = rx.recv_timeout(Duration::from_secs(5)).expect("a change in the first folder");
        assert!(hit.iter().all(|p| !same_file(p, &docs[2])), "nothing from the folder let go");
        // a folder that is not there: an error, the rest still watched
        assert!(w.set_files(&[a.join("one.md"), root.join("gone").join("x.md")]).is_err());
        assert_eq!(w.dirs().len(), 1);
        drop(w);
        let _ = std::fs::remove_dir_all(&root);
    }
}
