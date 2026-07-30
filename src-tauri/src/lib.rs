mod commands;
mod watcher;

use std::sync::Mutex;

use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct AppState {
    pub initial_file: Mutex<Option<String>>,
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
}

fn file_arg(args: impl Iterator<Item = String>) -> Option<String> {
    args.skip(1).find(|a| !a.starts_with('-'))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // single-instance must be the first registered plugin
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            if let Some(path) = file_arg(argv.into_iter()) {
                let _ = app.emit("open-file", path);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            *app.state::<AppState>().initial_file.lock().unwrap() = file_arg(std::env::args());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_initial_file,
            commands::read_markdown,
            commands::list_tree,
            commands::parent_dir,
            commands::watch_file,
            commands::resolve_path,
            commands::show_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
