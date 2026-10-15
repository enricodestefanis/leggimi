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

// The MSIX build cannot bundle the WebView2 bootstrapper, and without the
// runtime the window would silently fail to appear. Explain and point to the
// download instead (Store policy 10.4.1). Returns false when the app must exit.
#[cfg(windows)]
fn ensure_webview2() -> bool {
    if tauri::webview_version().is_ok() {
        return true;
    }
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        MessageBoxW, IDOK, MB_ICONERROR, MB_OKCANCEL, SW_SHOWNORMAL,
    };

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }
    let title = wide("Leggimi");
    let text = wide(
        "Leggimi needs the Microsoft Edge WebView2 Runtime, which is not installed on this PC.\n\n\
         Press OK to open the download page, install the runtime, then start Leggimi again.",
    );
    let choice = unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), MB_OKCANCEL | MB_ICONERROR)
    };
    if choice == IDOK {
        let verb = wide("open");
        let url = wide("https://developer.microsoft.com/microsoft-edge/webview2/");
        unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            );
        }
    }
    false
}

/// `leggimi-portable.txt` next to the exe switches to portable mode: the
/// WebView2 profile (localStorage: preferences, recents, positions) lives in
/// `<exe dir>\data` and the app gets its own identifier, so it never shares
/// the single-instance mutex or the config folder with an installed copy.
fn portable_data_dir() -> Option<std::path::PathBuf> {
    let exe = dunce::canonicalize(std::env::current_exe().ok()?).ok()?;
    let dir = exe.parent()?;
    if !dir.join("leggimi-portable.txt").is_file() {
        return None;
    }
    let data = dir.join("data");
    // a read-only location (zip opened in place): behave like the installed app
    std::fs::create_dir_all(&data).ok()?;
    Some(data)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    if !ensure_webview2() {
        return;
    }
    let mut context = tauri::generate_context!();
    if let Some(data) = portable_data_dir() {
        // the WebView2 loader takes this variable over the folder Tauri passes
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &data);
        context.config_mut().identifier = "com.enrico.leggimi.portable".to_owned();
    }
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
            commands::write_markdown,
            commands::existing_paths,
            commands::resolve_doc,
            commands::export_file,
            commands::export_binary,
            commands::save_clipboard_image,
            commands::import_image,
            commands::list_tree,
            commands::search_in_tree,
            commands::parent_dir,
            commands::watch_file,
            commands::resolve_path,
            commands::show_window,
            commands::is_store_install,
            commands::open_store_review
        ])
        .run(context)
        .expect("error while running tauri application");
}
