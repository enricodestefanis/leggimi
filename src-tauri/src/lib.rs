mod commands;
mod watcher;

use std::sync::Mutex;

use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, RecommendedCache};
use tauri::{Emitter, Manager};

#[derive(Default)]
pub struct AppState {
    pub initial: Mutex<Option<Launch>>,
    pub watcher: Mutex<Option<Debouncer<RecommendedWatcher, RecommendedCache>>>,
}

/// What a command line asks for: `leggimi [file] [--line N]`.
#[derive(Clone, Default, serde::Serialize)]
pub struct Launch {
    pub path: Option<String>,
    /// 1-based source line to show at the top
    pub line: Option<u32>,
}

/// `leggimi file.md`, `leggimi --line 40 file.md`, `leggimi file.md -l 40`,
/// `--line=40`; `--` ends the options; unknown flags are ignored. A relative
/// file is resolved against `cwd`, the directory of the shell that ran it.
pub fn parse_args<I: IntoIterator<Item = String>>(args: I, cwd: Option<&std::path::Path>) -> Launch {
    let mut it = args.into_iter().skip(1);
    let mut launch = Launch::default();
    let mut positional_only = false;
    while let Some(a) = it.next() {
        match a.as_str() {
            "--" if !positional_only => positional_only = true,
            "--line" | "-l" if !positional_only => launch.line = it.next().and_then(|v| v.parse().ok()),
            s if !positional_only && s.starts_with("--line=") => launch.line = s[7..].parse().ok(),
            s if !positional_only && s.starts_with('-') => {}
            s if launch.path.is_none() => {
                let p = std::path::PathBuf::from(s);
                let p = if p.is_relative() {
                    cwd.map(|c| c.join(&p)).unwrap_or(p)
                } else {
                    p
                };
                launch.path = Some(p.to_string_lossy().into_owned());
            }
            _ => {}
        }
    }
    launch
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
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            let launch = parse_args(argv, Some(std::path::Path::new(&cwd)));
            if launch.path.is_some() {
                let _ = app.emit("open-file", launch);
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .setup(|app| {
            let cwd = std::env::current_dir().ok();
            *app.state::<AppState>().initial.lock().unwrap() =
                Some(parse_args(std::env::args(), cwd.as_deref()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_initial_file,
            commands::read_markdown,
            commands::write_markdown,
            commands::existing_paths,
            commands::resolve_doc,
            commands::print_to_pdf,
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
