use std::{path::Path, time::Duration};

use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};
use tauri::{AppHandle, Emitter};

// Watch the parent directory, not the file itself: editors doing atomic saves
// (write temp file, rename over target) would kill a watch on the file.
pub fn watch(
    app: AppHandle,
    file: &Path,
) -> Result<Debouncer<RecommendedWatcher, RecommendedCache>, String> {
    let parent = file
        .parent()
        .ok_or("File has no parent directory")?
        .to_path_buf();
    let file_name = file.file_name().ok_or("Invalid file name")?.to_os_string();
    let emit_path = file.to_string_lossy().into_owned();

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
                    let _ = app.emit("file-changed", emit_path.clone());
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
