//! Chrome-like window drags. A window dragged by its only tab
//! (begin_window_drag), or the new window of a torn-off tab while the button
//! that tore it is still down (open_window's `follow`, taken up by
//! show_window), moves in Windows' own move loop: smooth, with Aero Snap.
//! Meanwhile the Leggimi window under the pointer (never the moving one, and
//! none where another app's window is on top) is told when the pointer is
//! over its tab strip ("tab-hover" / "tab-hover-end", the events the pages
//! send each other in their own drags); letting go there tells the moving
//! window ("window-drag-drop"), whose page then offers its tab to the other.
//!
//! The moving window would hide the ghost tab the other one draws under the
//! pointer, so while the pointer is over a strip it is cloaked (DWM keeps it,
//! unseen), as Chrome hides a tab's window over another strip; it shows
//! again when the pointer leaves. After a drop there it stays unseen while
//! its page hands the tab over and closes, and comes back if that has not
//! happened MERGE_WAIT later (or when its page calls show_window).
//!
//! Also here: which Leggimi window is where (window_at), for the pages'
//! own drags.

use std::path::Path;

use serde::Serialize;

/// A page's tab strip, in CSS px of its client area (set_strip).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Strip {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// How far around a strip (CSS px) a dragged window still merges.
pub const STRIP_MARGIN: f64 = 12.0;

impl Strip {
    /// Whether `pt` (physical screen px) is over the strip or within
    /// STRIP_MARGIN of it, for a window whose client area starts at `origin`
    /// (physical screen px) and is drawn at `scale`.
    pub fn holds(&self, origin: (i32, i32), scale: f64, pt: (i32, i32)) -> bool {
        if self.w <= 0.0 || self.h <= 0.0 {
            return false;
        }
        let edge = |o: i32, v: f64| o as f64 + v * scale;
        let (x, y) = (pt.0 as f64, pt.1 as f64);
        x >= edge(origin.0, self.x - STRIP_MARGIN)
            && x < edge(origin.0, self.x + self.w + STRIP_MARGIN)
            && y >= edge(origin.1, self.y - STRIP_MARGIN)
            && y < edge(origin.1, self.y + self.h + STRIP_MARGIN)
    }
}

/// A torn-off tab's new window, until its page shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Follow {
    /// the pointer from the window's outer top-left, physical px: kept
    /// when the window comes up where the pointer has got to meanwhile
    pub grab: (i32, i32),
    /// for "tab-hover": the tab's name and file
    pub title: String,
    pub path: Option<String>,
}

impl Follow {
    /// `at`: where the page wants the window (outer top-left, physical px),
    /// measured against the pointer now; `path`: the tab's file.
    pub fn new(at: Option<(i32, i32)>, path: Option<String>) -> Follow {
        let grab = match (at, cursor()) {
            (Some((x, y)), Some((cx, cy))) => (cx - x, cy - y),
            _ => (0, 0),
        };
        let title = path
            .as_deref()
            .and_then(|p| Path::new(p).file_name())
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        Follow { grab, title, path }
    }
}

/// "tab-hover" (TabHover in src/tabs/contract.ts): a tab carried over a
/// window, the pointer in physical screen px.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabHover {
    pub from: String,
    pub title: String,
    pub path: Option<String>,
    pub x: i32,
    pub y: i32,
}

/// "window-drag-drop" (WindowDragDrop): the moving window was let go over
/// `target`'s strip.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowDragDrop {
    pub target: String,
    pub x: i32,
    pub y: i32,
}

/// The pointer in physical screen px.
pub fn cursor() -> Option<(i32, i32)> {
    #[cfg(windows)]
    {
        imp::cursor().map(|p| (p.x, p.y))
    }
    #[cfg(not(windows))]
    None
}

/// Registers a new window for window_at and watches its moves, from its
/// first moment.
pub fn install(window: &tauri::Window) {
    #[cfg(windows)]
    {
        use tauri::Manager as _;
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let hwnd = hwnd.0 as isize;
        let app = window.app_handle().clone();
        let label = window.label().to_owned();
        // a subclass belongs to the thread of its window
        let _ = window.run_on_main_thread(move || unsafe { imp::install(hwnd, app, label) });
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// The label of the top-most Leggimi window at `x`, `y` (physical screen
/// px), in the windows' true order on screen; None where another app's
/// window is on top. `exclude`: a window to see through (the one moving
/// with the pointer).
pub fn window_at(x: f64, y: f64, exclude: Option<&str>) -> Option<String> {
    #[cfg(windows)]
    unsafe {
        let pt = windows_sys::Win32::Foundation::POINT {
            x: x.round() as i32,
            y: y.round() as i32,
        };
        let exclude = exclude.and_then(imp::hwnd_of);
        imp::top_window_at(pt, exclude).and_then(imp::label_of)
    }
    #[cfg(not(windows))]
    {
        let _ = (x, y, exclude);
        None
    }
}

/// The page drags its window by its only tab: Windows' move loop, as for
/// the title bar, with the strips of the other windows watched. Nothing
/// when the button is up already (a click, not a drag).
pub fn begin(window: &tauri::WebviewWindow, path: Option<String>, title: String) {
    #[cfg(windows)]
    {
        if !imp::primary_down() {
            return;
        }
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let hwnd = hwnd.0 as isize;
        let w = window.clone();
        let _ = window.run_on_main_thread(move || {
            imp::arm(hwnd, title, path);
            let _ = w.start_dragging();
        });
    }
    #[cfg(not(windows))]
    let _ = (window, path, title);
}

/// show_window for a torn-off tab's window: while the button that tore it
/// is still down it comes up under the pointer (at the offset the page
/// asked for) and follows it in Windows' move loop, as a tab drag. False
/// when the button is up: it is shown where it is.
pub fn follow(window: &tauri::WebviewWindow, f: Follow) -> bool {
    #[cfg(windows)]
    {
        if !imp::primary_down() {
            return false;
        }
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let hwnd = hwnd.0 as isize;
        let w = window.clone();
        let _ = window.run_on_main_thread(move || unsafe {
            imp::put_under_pointer(hwnd, f.grab);
            let _ = w.show();
            let _ = w.set_focus();
            imp::arm(hwnd, f.title, f.path);
            let _ = w.start_dragging();
        });
        true
    }
    #[cfg(not(windows))]
    {
        let _ = (window, f);
        false
    }
}

/// A window left unseen by a drop on a strip comes back (its tab did not
/// move after all).
pub fn uncloak(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let hwnd = hwnd.0 as isize;
        let _ = window.run_on_main_thread(move || unsafe { imp::cloak(hwnd, false) });
    }
    #[cfg(not(windows))]
    let _ = window;
}

#[cfg(windows)]
mod imp {
    use super::{Strip, TabHover, WindowDragDrop};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use tauri::{AppHandle, Emitter, Manager};
    use windows_sys::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_CLOAK, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS,
    };
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_ESCAPE, VK_LBUTTON, VK_RBUTTON};
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetAncestor, GetCursorPos, GetSystemMetrics, GetWindow, GetWindowLongPtrW, GetWindowRect, IsIconic,
        IsWindowVisible, SetWindowPos, WindowFromPoint, GA_ROOT, GWL_EXSTYLE, GW_HWNDNEXT, SM_SWAPBUTTON,
        SWP_NOACTIVATE, SWP_NOSIZE, SWP_NOZORDER, WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_MOVING, WM_NCDESTROY,
        WS_EX_LAYERED, WS_EX_TRANSPARENT,
    };

    use crate::AppState;

    /// The id of the subclass that watches the moves.
    const SUBCLASS_ID: usize = 0x4C44_5247;
    /// A drag asked for whose move loop has not started by then never will
    /// (the button was let go first): a later move by the title bar is no
    /// tab drag.
    const ARM_TIMEOUT: Duration = Duration::from_millis(1500);
    /// At most this often a "tab-hover" to the same window.
    const HOVER_EVERY: Duration = Duration::from_millis(15);
    /// How long a window dropped on a strip stays unseen, waiting for its
    /// page to hand the tab over (the pages give up an offer after 3 s).
    pub const MERGE_WAIT: Duration = Duration::from_millis(3500);

    static APP: OnceLock<AppHandle> = OnceLock::new();
    /// Every Leggimi window by its HWND, for any thread.
    static WINDOWS: Mutex<Vec<(isize, String)>> = Mutex::new(Vec::new());

    /// A tab drag of one window.
    struct Drag {
        title: String,
        path: Option<String>,
        armed: Instant,
        /// once the move loop runs: the window's rect and the pointer then
        start: Option<(RECT, POINT)>,
        /// the window told "tab-hover" last, and when
        over: Option<String>,
        sent: Option<Instant>,
    }

    thread_local! {
        /// By the moving window. Only the UI thread, where the windows live
        /// and the move loops run, touches them.
        static DRAGS: RefCell<HashMap<isize, Drag>> = RefCell::new(HashMap::new());
    }

    pub unsafe fn install(hwnd: isize, app: AppHandle, label: String) {
        let _ = APP.set(app);
        {
            let mut windows = WINDOWS.lock().unwrap();
            windows.retain(|(h, _)| *h != hwnd);
            windows.push((hwnd, label));
        }
        SetWindowSubclass(hwnd as HWND, Some(moving_proc), SUBCLASS_ID, 0);
    }

    pub fn label_of(hwnd: isize) -> Option<String> {
        WINDOWS.lock().unwrap().iter().find(|(h, _)| *h == hwnd).map(|(_, l)| l.clone())
    }

    pub fn hwnd_of(label: &str) -> Option<isize> {
        WINDOWS.lock().unwrap().iter().find(|(_, l)| l == label).map(|(h, _)| *h)
    }

    pub fn cursor() -> Option<POINT> {
        let mut pt = POINT { x: 0, y: 0 };
        (unsafe { GetCursorPos(&mut pt) } != 0).then_some(pt)
    }

    fn key_down(vk: u16) -> bool {
        let state = unsafe { GetAsyncKeyState(vk as i32) };
        state < 0
    }

    /// The button that drags (the left one, unless swapped) is down.
    pub fn primary_down() -> bool {
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        key_down(if swapped { VK_RBUTTON } else { VK_LBUTTON })
    }

    fn window_rect(hwnd: isize) -> RECT {
        let mut rc = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        unsafe { GetWindowRect(hwnd as HWND, &mut rc) };
        rc
    }

    fn same_rect(a: &RECT, b: &RECT) -> bool {
        (a.left, a.top, a.right, a.bottom) == (b.left, b.top, b.right, b.bottom)
    }

    fn emit<S: serde::Serialize + Clone>(label: &str, event: &str, payload: S) {
        if let Some(app) = APP.get() {
            let _ = app.emit_to(label, event, payload);
        }
    }

    /// Unseen (DWM still composes it and the move loop goes on) or seen again.
    pub unsafe fn cloak(hwnd: isize, on: bool) {
        let value: BOOL = on.into();
        DwmSetWindowAttribute(
            hwnd as HWND,
            DWMWA_CLOAK as u32,
            &value as *const BOOL as *const _,
            std::mem::size_of::<BOOL>() as u32,
        );
    }

    /// Cloaked by anyone: this app, the shell (another virtual desktop).
    pub unsafe fn cloaked(hwnd: isize) -> bool {
        let mut value = 0u32;
        DwmGetWindowAttribute(
            hwnd as HWND,
            DWMWA_CLOAKED as u32,
            &mut value as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        ) == 0
            && value != 0
    }

    /// A tab drag is about to start on `hwnd` (its move loop comes next).
    pub fn arm(hwnd: isize, title: String, path: Option<String>) {
        DRAGS.with(|d| {
            d.borrow_mut().insert(
                hwnd,
                Drag {
                    title,
                    path,
                    armed: Instant::now(),
                    start: None,
                    over: None,
                    sent: None,
                },
            )
        });
    }

    /// For the spike: whether `hwnd` has a tab drag, and whether it is live.
    pub fn drag_state(hwnd: isize) -> Option<bool> {
        DRAGS.with(|d| d.borrow().get(&hwnd).map(|d| d.start.is_some()))
    }

    /// The torn-off window under the pointer, at the offset the page asked for.
    pub unsafe fn put_under_pointer(hwnd: isize, grab: (i32, i32)) {
        if let Some(pt) = cursor() {
            SetWindowPos(
                hwnd as HWND,
                std::ptr::null_mut(),
                pt.x - grab.0,
                pt.y - grab.1,
                0,
                0,
                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
        }
    }

    unsafe extern "system" fn moving_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        match msg {
            WM_ENTERSIZEMOVE => {
                if let Some(pt) = cursor() {
                    entered(hwnd as isize, pt);
                }
            }
            WM_MOVING => {
                if let Some(pt) = cursor() {
                    moved(hwnd as isize, pt);
                }
            }
            WM_EXITSIZEMOVE => {
                if let Some(pt) = cursor() {
                    ended(hwnd as isize, pt);
                }
            }
            WM_NCDESTROY => {
                DRAGS.with(|d| d.borrow_mut().remove(&(hwnd as isize)));
                WINDOWS.lock().unwrap().retain(|(h, _)| *h != hwnd as isize);
                RemoveWindowSubclass(hwnd, Some(moving_proc), SUBCLASS_ID);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }

    /// The move loop starts: a tab drag asked for just before becomes live,
    /// one asked for too long ago is dropped.
    pub fn entered(hwnd: isize, pt: POINT) {
        DRAGS.with(|d| {
            let mut d = d.borrow_mut();
            match d.get_mut(&hwnd) {
                Some(drag) if drag.start.is_none() && drag.armed.elapsed() < ARM_TIMEOUT => {
                    drag.start = Some((window_rect(hwnd), pt));
                }
                Some(_) => {
                    d.remove(&hwnd);
                }
                None => {}
            }
        });
    }

    /// The window moves with the pointer at `pt`: the strip under it, if any,
    /// hears of it.
    pub unsafe fn moved(hwnd: isize, pt: POINT) {
        let Some((prev, due, title, path)) = DRAGS.with(|d| {
            d.borrow().get(&hwnd).filter(|d| d.start.is_some()).map(|d| {
                let due = d.sent.is_none_or(|s| s.elapsed() >= HOVER_EVERY);
                (d.over.clone(), due, d.title.clone(), d.path.clone())
            })
        }) else {
            return;
        };
        let now = strip_under(pt, hwnd);
        if prev != now {
            if let Some(prev) = &prev {
                emit(prev, "tab-hover-end", ());
            }
            // unseen over a strip, so the ghost there shows
            cloak(hwnd, now.is_some());
        }
        let send = now.is_some() && (prev != now || due);
        if let (Some(target), true) = (&now, send) {
            let from = label_of(hwnd).unwrap_or_default();
            emit(target, "tab-hover", TabHover { from, title, path, x: pt.x, y: pt.y });
        }
        DRAGS.with(|d| {
            if let Some(d) = d.borrow_mut().get_mut(&hwnd) {
                d.over = now;
                if send {
                    d.sent = Some(Instant::now());
                }
            }
        });
    }

    /// The move loop is over, the pointer at `pt`: over a strip, the moving
    /// window merges there ("window-drag-drop" to its page); anywhere else,
    /// or after Esc, it stays a window of its own.
    pub unsafe fn ended(hwnd: isize, pt: POINT) {
        let Some(drag) = DRAGS.with(|d| d.borrow_mut().remove(&hwnd)) else {
            return;
        };
        let Some((rect, from_pt)) = drag.start else {
            return;
        };
        // Esc puts the window back where it was and ends the loop
        let put_back =
            same_rect(&window_rect(hwnd), &rect) && ((pt.x - from_pt.x).abs() > 4 || (pt.y - from_pt.y).abs() > 4);
        let cancelled = key_down(VK_ESCAPE) || put_back;
        let target = if cancelled { None } else { strip_under(pt, hwnd) };
        if let Some(prev) = drag.over.as_ref().filter(|p| target.as_ref() != Some(*p)) {
            emit(prev, "tab-hover-end", ());
        }
        match (target, label_of(hwnd)) {
            (Some(target), Some(from)) => {
                // its page hands the tab over and closes: never seen again
                cloak(hwnd, true);
                emit(&from, "window-drag-drop", WindowDragDrop { target: target.clone(), x: pt.x, y: pt.y });
                std::thread::spawn(move || {
                    std::thread::sleep(MERGE_WAIT);
                    let Some(app) = APP.get() else { return };
                    // still there: the merge did not happen (refused, or no
                    // offer): the window comes back and the ghost goes
                    let _ = app.run_on_main_thread(move || unsafe {
                        if label_of(hwnd).as_deref() == Some(from.as_str()) {
                            cloak(hwnd, false);
                            emit(&target, "tab-hover-end", ());
                        }
                    });
                });
            }
            _ => cloak(hwnd, false),
        }
    }

    /// The window whose strip holds `pt` (see Strip::holds), under the moving
    /// one: a page that listens and is not asking whether to close.
    pub unsafe fn strip_under(pt: POINT, moving: isize) -> Option<String> {
        let target = top_window_at(pt, Some(moving))?;
        let label = label_of(target)?;
        let strip: Strip = {
            let state = APP.get()?.state::<AppState>();
            let windows = state.windows.lock().unwrap();
            let slot = windows.get(&label)?;
            if !slot.ready || slot.closing {
                return None;
            }
            slot.strip?
        };
        let mut origin = POINT { x: 0, y: 0 };
        ClientToScreen(target as HWND, &mut origin);
        let scale = GetDpiForWindow(target as HWND) as f64 / 96.0;
        strip.holds((origin.x, origin.y), scale, (pt.x, pt.y)).then_some(label)
    }

    /// The top-level window at `pt` as the user sees it: WindowFromPoint;
    /// where that is `exclude`, the next window down the z-order that shows
    /// there.
    pub unsafe fn top_window_at(pt: POINT, exclude: Option<isize>) -> Option<isize> {
        let hit = WindowFromPoint(pt);
        if hit.is_null() {
            return None;
        }
        let root = GetAncestor(hit, GA_ROOT) as isize;
        match exclude {
            Some(ex) if root == ex => {
                let mut h = GetWindow(ex as HWND, GW_HWNDNEXT);
                while !h.is_null() {
                    if shows_at(h, pt) {
                        return Some(h as isize);
                    }
                    h = GetWindow(h, GW_HWNDNEXT);
                }
                None
            }
            _ => Some(root),
        }
    }

    /// A window the user sees at `pt`: shown, not minimized, not cloaked (on
    /// another desktop), not a click-through overlay, its visible frame
    /// around the point (not the invisible resize borders).
    unsafe fn shows_at(h: HWND, pt: POINT) -> bool {
        if IsWindowVisible(h) == 0 || IsIconic(h) != 0 || cloaked(h as isize) {
            return false;
        }
        let ex = GetWindowLongPtrW(h, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TRANSPARENT != 0 && ex & WS_EX_LAYERED != 0 {
            return false;
        }
        let mut r = RECT { left: 0, top: 0, right: 0, bottom: 0 };
        let framed = DwmGetWindowAttribute(
            h,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            &mut r as *mut RECT as *mut _,
            std::mem::size_of::<RECT>() as u32,
        ) == 0;
        if !framed {
            GetWindowRect(h, &mut r);
        }
        pt.x >= r.left && pt.x < r.right && pt.y >= r.top && pt.y < r.bottom
    }
}

/// What examples/drag_spike.rs drives without a mouse: the steps of a move
/// loop at chosen pointer positions. On the UI thread only.
#[cfg(windows)]
#[doc(hidden)]
pub mod probe {
    use windows_sys::Win32::Foundation::POINT;

    pub use super::imp::MERGE_WAIT;

    pub fn arm(hwnd: isize, title: &str, path: Option<&str>) {
        super::imp::arm(hwnd, title.to_owned(), path.map(str::to_owned));
    }
    pub fn enter(hwnd: isize, x: i32, y: i32) {
        super::imp::entered(hwnd, POINT { x, y });
    }
    pub fn moving(hwnd: isize, x: i32, y: i32) {
        unsafe { super::imp::moved(hwnd, POINT { x, y }) }
    }
    pub fn exit(hwnd: isize, x: i32, y: i32) {
        unsafe { super::imp::ended(hwnd, POINT { x, y }) }
    }
    pub fn cloaked(hwnd: isize) -> bool {
        unsafe { super::imp::cloaked(hwnd) }
    }
    /// None: no tab drag; Some(false): asked for, its move loop not started;
    /// Some(true): live.
    pub fn state(hwnd: isize) -> Option<bool> {
        super::imp::drag_state(hwnd)
    }
    pub fn strip_under(hwnd: isize, x: i32, y: i32) -> Option<String> {
        unsafe { super::imp::strip_under(POINT { x, y }, hwnd) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_strip_holds_the_pointer_with_a_margin() {
        // a 600 x 40 CSS px strip at the top of a client area that starts at
        // (100, 200) on screen, at 150 %
        let strip = Strip { x: 0.0, y: 0.0, w: 600.0, h: 40.0 };
        let at = |x, y| strip.holds((100, 200), 1.5, (x, y));
        assert!(at(100, 200), "its top-left corner");
        assert!(at(1000, 259), "the right end, the bottom row");
        assert!(at(100 - 17, 200 - 17), "12 CSS px (18 physical) around it");
        assert!(!at(100 - 19, 230), "beyond the margin on the left");
        assert!(at(500, 200 + 60 + 17), "the margin below");
        assert!(!at(500, 200 + 60 + 18), "beyond the margin below");
        assert!(!at(1100 + 18, 210), "beyond the margin on the right");
        assert!(!Strip { w: 0.0, ..strip }.holds((100, 200), 1.5, (110, 210)), "an empty strip holds nothing");
    }

    #[test]
    fn the_payloads_read_as_the_pages_expect() {
        let hover = TabHover { from: "doc-2".into(), title: "a.md".into(), path: None, x: -5, y: 7 };
        assert_eq!(
            serde_json::to_string(&hover).unwrap(),
            r#"{"from":"doc-2","title":"a.md","path":null,"x":-5,"y":7}"#
        );
        let drop = WindowDragDrop { target: "main".into(), x: 1, y: 2 };
        assert_eq!(serde_json::to_string(&drop).unwrap(), r#"{"target":"main","x":1,"y":2}"#);
    }

    #[test]
    fn a_follow_names_the_tab_by_its_file() {
        let f = Follow::new(None, Some(r"C:\docs\notes.md".into()));
        assert_eq!(f.title, "notes.md");
        assert_eq!(f.grab, (0, 0), "no place asked: no offset");
        assert_eq!(Follow::new(None, None).title, "", "a start page");
    }
}
