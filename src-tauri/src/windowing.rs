//! More than one document at a time: every window is a whole Leggimi with its
//! own document, file watch and launch, all in one process. A file opened
//! from outside the app (double-click, "Open with", `leggimi file.md`) gets a
//! window of its own, unless a window already shows it or sits on the home;
//! inside the app, Ctrl+click and "Open in a new window" make one.

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

use crate::{AppState, Launch, WindowSlot};

/// New windows step this far (logical px) right and down from the one they come from.
const CASCADE: f64 = 32.0;
/// Windows made this soon after the previous one (several files picked at
/// once in File Explorer or in the open dialog) cascade from it, not from the
/// window they all come from.
const BURST: Duration = Duration::from_secs(3);

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let state = window.state::<AppState>();
    match event {
        WindowEvent::Focused(true) => {
            *state.last_focused.lock().unwrap() = window.label().to_owned();
        }
        // dropping the slot also stops its file watch
        WindowEvent::Destroyed => {
            state.windows.lock().unwrap().remove(window.label());
        }
        _ => {}
    }
}

fn same_file(a: &Path, b: &Path) -> bool {
    a.as_os_str().eq_ignore_ascii_case(b.as_os_str())
}

/// A launch from outside the app (a second `leggimi` process forwarded by the
/// single-instance plugin): to the window that already shows the file (or is
/// opening it), else to a window on the home (the last used one first), else
/// to a new window. Without a file it only brings the last used window forward.
pub fn route_launch(app: &AppHandle, launch: Launch) {
    let state = app.state::<AppState>();
    let last = state.last_focused.lock().unwrap().clone();
    let canon = launch.path.as_deref().and_then(|p| dunce::canonicalize(p).ok());

    enum Route {
        To(String),
        New(String),
        Front,
    }
    // decided and claimed under one lock, so the next launch (they can arrive
    // together) finds the window busy, or the new one already reserved; the
    // lock is gone before any window is built (the main thread takes it then)
    let route = {
        let mut windows = state.windows.lock().unwrap();
        let showing = canon.as_deref().and_then(|c| {
            windows
                .iter()
                .find(|(_, s)| {
                    let shown = s.doc.as_deref().or(s.opening.as_deref());
                    shown.is_some_and(|d| same_file(d, c))
                })
                .map(|(label, _)| label.clone())
        });
        // a window on the home: its page listens, and nothing is on its way to it
        let idle = |s: &WindowSlot| s.ready && s.doc.is_none() && s.opening.is_none() && s.launch.is_none();
        let target = showing.or_else(|| {
            if launch.path.is_none() || windows.get(&last).is_some_and(idle) {
                Some(last.clone())
            } else {
                windows.iter().find(|(_, s)| idle(s)).map(|(l, _)| l.clone())
            }
        });
        match target {
            Some(label) => {
                if let (Some(c), Some(slot)) = (&canon, windows.get_mut(&label)) {
                    if slot.doc.as_deref().is_none_or(|d| !same_file(d, c)) {
                        slot.opening = Some(c.clone());
                    }
                }
                Route::To(label)
            }
            None if launch.path.is_some() => Route::New(reserve(&state, &mut windows, launch.clone())),
            None => Route::Front,
        }
    };

    match route {
        Route::New(label) => {
            let from = app.get_webview_window(&last).or_else(|| app.webview_windows().into_values().next());
            let _ = build(app, from.as_ref(), label);
        }
        Route::To(label) => match app.get_webview_window(&label) {
            Some(win) => {
                if launch.path.is_some() {
                    let _ = app.emit_to(win.label(), "open-file", &launch);
                }
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // still being built (reserved by a launch just before this one, which
            // it will open itself): nothing to add
            None if state.windows.lock().unwrap().contains_key(&label) => {}
            // closed meanwhile: a new window for a file, any other for a bare launch
            None if launch.path.is_some() => {
                let from = app.webview_windows().into_values().next();
                let _ = create_window(app, from.as_ref(), launch);
            }
            None => bring_any(app),
        },
        Route::Front => bring_any(app),
    }
}

fn bring_any(app: &AppHandle) {
    if let Some(win) = app.webview_windows().into_values().next() {
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Opens a new window for `launch` (an empty window, on the home, when it has
/// no file), placed from `from`, the window it comes from. Its page shows it
/// once it has rendered (`show_window`), like the first window.
pub fn create_window(app: &AppHandle, from: Option<&WebviewWindow>, launch: Launch) -> Result<(), String> {
    let state = app.state::<AppState>();
    let label = reserve(&state, &mut state.windows.lock().unwrap(), launch);
    build(app, from, label)
}

/// A label and a slot for a window about to be built: its launch is waiting
/// there, and its file counts as being opened.
fn reserve(state: &AppState, windows: &mut HashMap<String, WindowSlot>, launch: Launch) -> String {
    let label = format!("doc-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let opening = launch.path.as_deref().and_then(|p| dunce::canonicalize(p).ok());
    windows.insert(
        label.clone(),
        WindowSlot {
            launch: Some(launch),
            opening,
            ..Default::default()
        },
    );
    label
}

fn build(app: &AppHandle, from: Option<&WebviewWindow>, label: String) -> Result<(), String> {
    let state = app.state::<AppState>();
    // one at a time: each new window cascades from the one built just before it
    let _creating = state.creating.lock().unwrap();
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .unwrap_or_default();
    config.label = label.clone();

    // a burst cascades from its previous window, if that one is still around
    let recent = state
        .last_created
        .lock()
        .unwrap()
        .as_ref()
        .filter(|(_, at)| at.elapsed() < BURST)
        .and_then(|(l, _)| app.get_webview_window(l));
    if let Some(base) = recent.as_ref().or(from) {
        place(&mut config, base);
    }

    match WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(_) => {
            *state.last_created.lock().unwrap() = Some((label, Instant::now()));
            Ok(())
        }
        Err(e) => {
            state.windows.lock().unwrap().remove(&label);
            Err(e.to_string())
        }
    }
}

/// The size of `base`, one step right and down from it; back near the
/// top-left corner of its monitor when that would leave the work area. A
/// maximized window gives a maximized one, on the same monitor. A minimized
/// one has no place to step from (it sits at -32000): the new window keeps
/// the default size and is centred.
fn place(config: &mut WindowConfig, base: &WebviewWindow) {
    if base.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(scale) = base.scale_factor() else {
        return;
    };
    let area = base.current_monitor().ok().flatten().map(|m| {
        let wa = m.work_area();
        (
            wa.position.x as f64 / scale,
            wa.position.y as f64 / scale,
            wa.size.width as f64 / scale,
            wa.size.height as f64 / scale,
        )
    });
    if base.is_maximized().unwrap_or(false) {
        if let Some((left, top, _, _)) = area {
            config.center = false;
            config.x = Some(left + CASCADE);
            config.y = Some(top + CASCADE);
        }
        config.maximized = true;
        return;
    }
    let (Ok(pos), Ok(size)) = (base.outer_position(), base.inner_size()) else {
        return;
    };
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    let mut x = pos.x as f64 / scale + CASCADE;
    let mut y = pos.y as f64 / scale + CASCADE;
    if let Some((left, top, w, h)) = area {
        if x < left || y < top || x + width > left + w || y + height > top + h {
            x = left + CASCADE;
            y = top + CASCADE;
        }
    }
    config.center = false;
    config.x = Some(x);
    config.y = Some(y);
    config.width = width;
    config.height = height;
}
