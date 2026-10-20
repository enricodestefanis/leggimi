mod commands;
mod watcher;
mod windowing;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;
use std::time::Instant;

use notify::RecommendedWatcher;
use notify_debouncer_full::{Debouncer, NoCache, RecommendedCache};
use tauri::Manager;

/// One window's share of the state, by window label.
#[derive(Default)]
pub struct WindowSlot {
    /// what the window opens with; its page takes it with get_initial_file
    pub launch: Option<Launch>,
    /// the page has called get_initial_file, so its "open-file" listener is live
    pub ready: bool,
    /// the document on screen, canonical (set by watch_file)
    pub doc: Option<PathBuf>,
    /// a document on its way to the page (handed out or routed, not yet on
    /// screen): the window is busy, and a second launch of it finds it here
    pub opening: Option<PathBuf>,
    pub watcher: Option<Debouncer<RecommendedWatcher, RecommendedCache>>,
    /// the folder the file pane shows, as last asked by the page
    pub tree_root: Option<PathBuf>,
    /// when that was asked (the page's clock), to drop older requests
    pub tree_seq: u64,
    /// its watch (none for a drive root)
    pub tree: Option<Debouncer<RecommendedWatcher, NoCache>>,
}

#[derive(Default)]
pub struct AppState {
    pub windows: Mutex<HashMap<String, WindowSlot>>,
    /// the window used last: where a launch without a file lands
    pub last_focused: Mutex<String>,
    /// the newest window and when it was made, for cascading bursts
    pub last_created: Mutex<Option<(String, Instant)>>,
    /// one window is placed and built at a time, so a burst cascades instead
    /// of stacking every window on the same spot
    pub creating: Mutex<()>,
    pub next_id: AtomicU32,
}

/// What a command line asks for: `leggimi [file] [--line N]`; also what a new
/// window is made for.
#[derive(Clone, Default, serde::Serialize)]
pub struct Launch {
    pub path: Option<String>,
    /// 1-based source line to show at the top
    pub line: Option<u32>,
    /// heading id to show at the top (a `file.md#section` link)
    pub anchor: Option<String>,
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

/// The user's preferred languages, in order (Settings > Time & language >
/// Language & region). Windows says Store apps "appear in the first supported
/// language in this list"; WebView2's `navigator.languages` reports the
/// Windows display language instead, which is often English on a machine set
/// up for an Italian user.
#[cfg(windows)]
fn preferred_languages() -> Vec<String> {
    use windows::System::UserProfile::GlobalizationPreferences;
    GlobalizationPreferences::Languages()
        .map(|list| list.into_iter().map(|tag| tag.to_string()).collect())
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn preferred_languages() -> Vec<String> {
    Vec::new()
}

/// The interface languages (LANGS in src/i18n.ts).
pub const UI_LANGS: &[&str] = &["en", "it", "de", "fr", "es", "zh-CN"];

/// wry's own WebView2 arguments, which a window's `additionalBrowserArgs` replaces.
#[cfg(windows)]
const WRY_BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// The language picked in the reading settings, mirrored by `remember_language`
/// for the next start (the page keeps its own copy in localStorage).
pub fn language_file(config_dir: &std::path::Path) -> std::path::PathBuf {
    config_dir.join("ui-language")
}

/// The interface language as i18n.ts picks it: the choice in the reading
/// settings, else the first supported language among Windows' preferred ones.
#[cfg(windows)]
fn ui_language(identifier: &str) -> &'static str {
    let saved = std::env::var_os("APPDATA")
        .map(|dir| language_file(&std::path::Path::new(&dir).join(identifier)))
        .and_then(|file| std::fs::read_to_string(file).ok());
    if let Some(lang) = saved.and_then(|s| UI_LANGS.iter().copied().find(|l| *l == s.trim())) {
        return lang;
    }
    for tag in preferred_languages() {
        let lower = tag.to_lowercase();
        if lower.starts_with("zh") {
            return "zh-CN";
        }
        let primary = lower.split('-').next().unwrap_or_default();
        if let Some(lang) = UI_LANGS.iter().copied().find(|l| *l == primary) {
            return lang;
        }
    }
    "en"
}

/// Hands the preferred languages to the page before any of its scripts run:
/// i18n.ts resolves the UI language synchronously when it loads.
fn system_languages_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let langs = serde_json::to_string(&preferred_languages()).unwrap_or_else(|_| "[]".to_owned());
    tauri::plugin::Builder::new("system-languages")
        .js_init_script(format!("window.__LEGGIMI_LANGS__ = {langs};"))
        .build()
}

/// The entries WebView2's own right-click menu may keep: editing, emoji and
/// the spelling suggestions. Compared ignoring case: the docs spell the last
/// one "spellCheck", the runtime (WebView2 155) names it "spellcheck".
#[cfg(windows)]
const NATIVE_MENU_KEEP: &[&str] = &[
    "emoji",
    "undo",
    "redo",
    "cut",
    "copy",
    "paste",
    "pasteAndMatchStyle",
    "selectAll",
    "spellCheck",
];

/// The page of a window is the app itself: in dev the dev server, otherwise
/// Tauri's own origin (`http://tauri.localhost` on Windows).
#[cfg(windows)]
fn is_app_url<R: tauri::Runtime>(app: &tauri::AppHandle<R>, url: &tauri::Url) -> bool {
    if url.host_str() == Some("tauri.localhost") || url.scheme() == "tauri" {
        return true;
    }
    tauri::is_dev() && app.config().build.dev_url.as_ref().is_some_and(|dev| dev.origin() == url.origin())
}

/// What WebView2 brings along as a browser, kept out of the app:
/// - its own right-click menu shows only in text fields and in the editor
///   (the page puts Leggimi's menu everywhere else), and there it keeps what
///   edits the text, without what acts on the app's page or comes from Edge:
///   More tools (Share), Print, Writing direction, Import passwords;
/// - the browser keys are off (Ctrl+G and Ctrl+J opened Edge's find bar and
///   downloads flyout, F7 caret browsing): the page still gets every key
///   and handles its own shortcuts;
/// - a window never leaves the app: a form, an image map or a link inside an
///   SVG in a document would navigate it to a web page. Web and mail
///   addresses go to the default browser or mail app instead.
#[cfg(windows)]
fn webview_guard_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("webview-guard")
        .on_navigation(|webview, url| {
            if is_app_url(webview.app_handle(), url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
                let url = url.to_string();
                std::thread::spawn(move || tauri_plugin_opener::open_url(url, None::<&str>));
            }
            false
        })
        .on_webview_ready(|webview| {
            let _ = webview.with_webview(|pw| {
                use webview2_com::ContextMenuRequestedEventHandler;
                use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Settings3, ICoreWebView2_11};
                use windows::core::Interface;
                let _ = (|| unsafe {
                    let core = pw.controller().CoreWebView2()?;
                    core.Settings()?
                        .cast::<ICoreWebView2Settings3>()?
                        .SetAreBrowserAcceleratorKeysEnabled(false)?;
                    let core: ICoreWebView2_11 = core.cast()?;
                    let handler = ContextMenuRequestedEventHandler::create(Box::new(|_, args| {
                        if let Some(args) = args {
                            if prune_native_menu(&args.MenuItems()?)? == 0 {
                                args.SetHandled(true)?; // nothing left: no empty menu
                            }
                        }
                        Ok(())
                    }));
                    let mut token = 0i64;
                    core.add_ContextMenuRequested(&handler, &mut token)
                })();
            });
        })
        .build()
}

/// Removes the entries not in NATIVE_MENU_KEEP, and the separators left at
/// the ends or doubled; returns how many entries remain.
#[cfg(windows)]
unsafe fn prune_native_menu(
    items: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2ContextMenuItemCollection,
) -> windows::core::Result<u32> {
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use windows::core::PWSTR;
    let mut count = 0u32;
    items.Count(&mut count)?;
    // backwards, so a removal leaves the indices still to visit alone;
    // `sep_next`: what follows in the menu is a separator, or its end
    let mut sep_next = true;
    for i in (0..count).rev() {
        let item = items.GetValueAtIndex(i)?;
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        item.Kind(&mut kind)?;
        if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR {
            if sep_next {
                items.RemoveValueAtIndex(i)?;
            }
            sep_next = true;
            continue;
        }
        let mut name = PWSTR::null();
        item.Name(&mut name)?;
        let name = webview2_com::take_pwstr(name);
        if NATIVE_MENU_KEEP.iter().any(|keep| keep.eq_ignore_ascii_case(&name)) {
            sep_next = false;
        } else {
            items.RemoveValueAtIndex(i)?;
        }
    }
    items.Count(&mut count)?;
    if count > 0 {
        let mut kind = COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND::default();
        items.GetValueAtIndex(0)?.Kind(&mut kind)?;
        if kind == COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR {
            items.RemoveValueAtIndex(0)?;
            count -= 1;
        }
    }
    Ok(count)
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
    // WebView2's own parts (the menu in text fields and the editor, the print
    // preview, the spelling dictionary) speak the app's language, not Windows'
    // display language. Every window gets the same arguments: they share one
    // WebView2 environment, which takes them when it starts.
    #[cfg(windows)]
    {
        let lang = match ui_language(&context.config().identifier) {
            "en" => "en-US",
            other => other,
        };
        for window in &mut context.config_mut().app.windows {
            window.additional_browser_args = Some(format!("{WRY_BROWSER_ARGS} --lang={lang}"));
        }
    }
    let builder = tauri::Builder::default()
        // single-instance must be the first registered plugin
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let launch = parse_args(argv, Some(std::path::Path::new(&cwd)));
            // it may build a window, which must not happen on this callback's
            // thread: WebView2 deadlocks (tauri-apps/wry#583)
            let app = app.clone();
            tauri::async_runtime::spawn(async move { windowing::route_launch(&app, launch) });
        }))
        .plugin(system_languages_plugin())
        // only the first window keeps its place; the others cascade from it
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_filter(|label| label == "main")
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());
    #[cfg(windows)]
    let builder = builder.plugin(webview_guard_plugin());
    builder
        .manage(AppState::default())
        .setup(|app| {
            let cwd = std::env::current_dir().ok();
            let state = app.state::<AppState>();
            state.windows.lock().unwrap().insert(
                "main".to_owned(),
                WindowSlot {
                    launch: Some(parse_args(std::env::args(), cwd.as_deref())),
                    ..Default::default()
                },
            );
            *state.last_focused.lock().unwrap() = "main".to_owned();
            Ok(())
        })
        .on_window_event(windowing::on_window_event)
        .invoke_handler(tauri::generate_handler![
            commands::get_initial_file,
            commands::read_markdown,
            commands::write_markdown,
            commands::existing_paths,
            commands::resolve_doc,
            commands::print_to_pdf,
            commands::open_window,
            commands::open_externally,
            commands::remember_language,
            commands::export_file,
            commands::export_binary,
            commands::save_clipboard_image,
            commands::import_image,
            commands::list_tree,
            commands::search_in_tree,
            commands::parent_dir,
            commands::watch_file,
            commands::watch_tree,
            commands::resolve_path,
            commands::show_window,
            commands::is_store_install,
            commands::open_store_review
        ])
        .run(context)
        .expect("error while running tauri application");
}
