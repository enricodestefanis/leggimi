//! The page draws its own title bar (`decorations: false`), with its own
//! Minimize, Maximize and Close buttons. Windows 11 shows its Snap layouts
//! (the flyout over Maximize) only for a window that answers WM_NCHITTEST
//! with HTMAXBUTTON under the pointer, which a page never can: the WebView's
//! own child window answers for every point of it. So each button gets a
//! native child window laid exactly over it, a "zone", which answers
//! HTMINBUTTON, HTMAXBUTTON or HTCLOSE and never paints, so the page shows
//! through. The technique of github.com/Zbrooklyn/tauri-snap-layouts (MIT),
//! and of Windows Terminal's drag bar.
//!
//! A zone takes the pointer from the page's button under it, so it tells the
//! page when the pointer is over it ("caption-hover", for the hover look) and
//! does what the button does on a click; Close sends WM_CLOSE, so the page
//! still asks about unsaved edits. The page says where its buttons are
//! (set_caption, CSS px of the client area) and hides the zones while
//! something covers its buttons (a modal). Windows 10 has no Snap layouts:
//! there nothing is installed and the page's buttons work alone.

use serde::{Deserialize, Serialize};

/// A caption button, as the page and "caption-hover" name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Button {
    Min,
    Max,
    Close,
}

impl Button {
    const ALL: [Button; 3] = [Button::Min, Button::Max, Button::Close];

    fn index(self) -> usize {
        self as usize
    }
}

/// One of the page's caption buttons, in CSS px of the client area.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionButton {
    pub kind: Button,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// What set_caption gets (CaptionLayout in src/tabs/contract.ts): the
/// buttons, and whether the pointer can reach them (false while a modal or
/// the preview covers them, and the zones hide).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptionLayout {
    pub buttons: Vec<CaptionButton>,
    pub visible: bool,
}

/// "caption-hover": the button under the pointer, null once it has left.
#[derive(Clone, Serialize)]
struct CaptionHover {
    button: Option<Button>,
}

/// A button as the zones keep it, in CSS px, tied to the right edge of the
/// client area (`right`: from that edge to the button's left side): a resize
/// moves the zones at once, before the page has laid its buttons out again.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Anchor {
    right: f64,
    y: f64,
    w: f64,
    h: f64,
}

impl Anchor {
    /// `width`: the client area's width in CSS px when the page measured.
    fn new(b: &CaptionButton, width: f64) -> Anchor {
        Anchor {
            right: width - b.x,
            y: b.y,
            w: b.w,
            h: b.h,
        }
    }

    /// The zone in physical px of the client area, `width` px wide at
    /// `scale`, below the `band` px kept at the top for resizing; None when
    /// nothing is left of it.
    fn rect(&self, width: i32, scale: f64, band: i32) -> Option<[i32; 4]> {
        let px = |v: f64| (v * scale).round() as i32;
        let (left, right) = (width - px(self.right), width - px(self.right - self.w));
        let (top, bottom) = (px(self.y).max(band), px(self.y + self.h));
        (left < right && top < bottom).then_some([left, top, right, bottom])
    }
}

/// Lays the zones over a new window's caption buttons, Windows 11 only; they
/// stay hidden until the page says where its buttons are.
pub fn install(window: &tauri::Window) {
    #[cfg(windows)]
    {
        use tauri::Manager as _;
        if !imp::snap_layouts() {
            return;
        }
        let Ok(hwnd) = window.hwnd() else {
            return;
        };
        let parent = hwnd.0 as isize;
        let app = window.app_handle().clone();
        let label = window.label().to_owned();
        // child windows and subclasses belong to the thread of the window
        let _ = window.run_on_main_thread(move || unsafe { imp::install(parent, app, label) });
    }
    #[cfg(not(windows))]
    let _ = window;
}

/// Places the zones over the page's caption buttons, or hides them.
#[tauri::command]
pub fn set_caption(window: tauri::WebviewWindow, layout: CaptionLayout) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let parent = hwnd.0 as isize;
        let _ = window.run_on_main_thread(move || unsafe { imp::apply(parent, &layout) });
    }
    #[cfg(not(windows))]
    let _ = (window, layout);
}

/// The window menu (Restore, Move, Size, Minimize, Maximize, Close) at a
/// point on screen (physical px), or at the pointer: a window without
/// Windows' title bar no longer opens it by itself, on a right-click of the
/// empty part of the bar or on Alt+Space. Async, so the menu (a modal loop)
/// opens after the call is answered, not inside the WebView's own handler.
#[tauri::command]
pub async fn show_system_menu(window: tauri::WebviewWindow, x: Option<f64>, y: Option<f64>) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        let parent = hwnd.0 as isize;
        let at = x.zip(y).map(|(x, y)| (x.round() as i32, y.round() as i32));
        let _ = window.run_on_main_thread(move || unsafe { imp::system_menu_at(parent, at) });
    }
    #[cfg(not(windows))]
    let _ = (window, x, y);
}

#[cfg(windows)]
mod imp {
    use super::{Anchor, Button, CaptionHover, CaptionLayout};
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows_sys::Win32::Graphics::Gdi::{GetStockObject, ValidateRect, NULL_BRUSH};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        TrackMouseEvent, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT,
    };
    use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, EnableMenuItem, GetClientRect, GetCursorPos,
        GetParent, GetSystemMenu, GetWindowLongPtrW, IsZoomed, LoadCursorW, PostMessageW, RegisterClassExW,
        SetWindowLongPtrW, SetWindowPos, ShowWindow, TrackPopupMenu, GWLP_USERDATA, HTCLOSE, HTMAXBUTTON,
        HTMINBUTTON, HWND_TOP, IDC_ARROW, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, SC_CLOSE, SC_MAXIMIZE,
        SC_MINIMIZE, SC_MOVE, SC_RESTORE, SC_SIZE, SIZE_MINIMIZED, SM_CYFRAME, SWP_NOACTIVATE, SWP_SHOWWINDOW,
        SW_HIDE, TPM_RETURNCMD, TPM_RIGHTBUTTON, WM_CLOSE, WM_DPICHANGED, WM_ERASEBKGND, WM_NCDESTROY,
        WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE,
        WM_NCRBUTTONDBLCLK, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP, WM_PAINT, WM_SIZE, WM_SYSCOMMAND, WNDCLASSEXW,
        WS_CHILD, WS_CLIPSIBLINGS,
    };

    /// The id of the subclass on the windows the zones cover.
    const SUBCLASS_ID: usize = 0x4C43_4150;

    /// for the events; the same app for every window
    static APP: OnceLock<AppHandle> = OnceLock::new();

    /// One window's zones and what they know.
    struct Caption {
        label: String,
        /// Min, Max, Close
        zones: [isize; 3],
        anchors: [Option<Anchor>; 3],
        visible: bool,
        /// the button the page shows as hovered
        hover: Option<Button>,
        /// the button pressed and not yet let go
        pressed: Option<Button>,
        /// WM_NCMOUSELEAVE asked for, per zone
        tracking: [bool; 3],
    }

    thread_local! {
        /// By the window they cover. Only the UI thread, where the windows
        /// live, ever touches them.
        static CAPTIONS: RefCell<HashMap<isize, Caption>> = RefCell::new(HashMap::new());
    }

    /// Snap layouts came with Windows 11 (build 22000).
    pub fn snap_layouts() -> bool {
        windows_version::OsVersion::current().build >= 22000
    }

    fn with<T>(parent: isize, f: impl FnOnce(&mut Caption) -> T) -> Option<T> {
        CAPTIONS.with(|c| c.borrow_mut().get_mut(&parent).map(f))
    }

    fn emit(label: &str, button: Option<Button>) {
        if let Some(app) = APP.get() {
            let _ = app.emit_to(label, "caption-hover", CaptionHover { button });
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// The zones' window class, registered once: no background brush and
    /// nothing painted, so the page shows through.
    fn zone_class() -> Option<*const u16> {
        static CLASS: OnceLock<Option<Vec<u16>>> = OnceLock::new();
        CLASS
            .get_or_init(|| unsafe {
                let name = wide("LeggimiCaptionZone");
                let class = WNDCLASSEXW {
                    cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                    style: 0,
                    lpfnWndProc: Some(zone_proc),
                    cbClsExtra: 0,
                    cbWndExtra: 0,
                    hInstance: GetModuleHandleW(std::ptr::null()),
                    hIcon: std::ptr::null_mut(),
                    hCursor: LoadCursorW(std::ptr::null_mut(), IDC_ARROW),
                    hbrBackground: GetStockObject(NULL_BRUSH),
                    lpszMenuName: std::ptr::null(),
                    lpszClassName: name.as_ptr(),
                    hIconSm: std::ptr::null_mut(),
                };
                (RegisterClassExW(&class) != 0).then_some(name)
            })
            .as_ref()
            .map(|name| name.as_ptr())
    }

    /// On the UI thread: three hidden zones over `parent`, and the subclass
    /// that keeps them on its buttons.
    pub unsafe fn install(parent: isize, app: AppHandle, label: String) {
        let _ = APP.set(app);
        if with(parent, |_| ()).is_some() {
            return;
        }
        let Some(class) = zone_class() else {
            return;
        };
        let module = GetModuleHandleW(std::ptr::null());
        let mut zones = [0isize; 3];
        for button in Button::ALL {
            // WS_CLIPSIBLINGS and no WS_EX_LAYERED / WS_EX_TRANSPARENT: the
            // style set that wins the hit test over the WebView's window
            let zone = CreateWindowExW(
                0,
                class,
                std::ptr::null(),
                WS_CHILD | WS_CLIPSIBLINGS,
                0,
                0,
                0,
                0,
                parent as HWND,
                std::ptr::null_mut(),
                module,
                std::ptr::null(),
            );
            if zone.is_null() {
                zones.iter().filter(|z| **z != 0).for_each(|z| {
                    DestroyWindow(*z as HWND);
                });
                return;
            }
            SetWindowLongPtrW(zone, GWLP_USERDATA, button.index() as isize + 1);
            zones[button.index()] = zone as isize;
        }
        if SetWindowSubclass(parent as HWND, Some(parent_proc), SUBCLASS_ID, 0) == 0 {
            zones.iter().for_each(|z| {
                DestroyWindow(*z as HWND);
            });
            return;
        }
        CAPTIONS.with(|c| {
            c.borrow_mut().insert(
                parent,
                Caption {
                    label,
                    zones,
                    anchors: [None; 3],
                    visible: false,
                    hover: None,
                    pressed: None,
                    tracking: [false; 3],
                },
            )
        });
    }

    /// On the UI thread: the page's layout, then the zones placed by it.
    pub unsafe fn apply(parent: isize, layout: &CaptionLayout) {
        let hwnd = parent as HWND;
        let dpi = GetDpiForWindow(hwnd);
        if dpi == 0 {
            return;
        }
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut client);
        let width = client.right as f64 * 96.0 / dpi as f64;
        let Some(gone) = with(parent, |c| {
            c.anchors = [None; 3];
            for b in &layout.buttons {
                c.anchors[b.kind.index()] = Some(Anchor::new(b, width));
            }
            c.visible = layout.visible;
            if !layout.visible {
                c.pressed = None;
            }
            // hidden under the pointer: the page drops the hover look
            (!layout.visible && c.hover.is_some()).then(|| {
                c.hover = None;
                c.label.clone()
            })
        }) else {
            return;
        };
        place(parent);
        if let Some(label) = gone {
            emit(&label, None);
        }
    }

    /// Puts each zone over its button for the window's size, DPI and state,
    /// above the WebView, or hides it.
    unsafe fn place(parent: isize) {
        let Some((zones, anchors, visible)) = with(parent, |c| (c.zones, c.anchors, c.visible)) else {
            return;
        };
        let hwnd = parent as HWND;
        let dpi = GetDpiForWindow(hwnd);
        if dpi == 0 {
            return;
        }
        let mut client: RECT = std::mem::zeroed();
        GetClientRect(hwnd, &mut client);
        // the top SM_CYFRAME px of an undecorated window resize it (Tauri's
        // TAURI_DRAG_RESIZE_BORDERS child, there while it is not maximized):
        // a zone over them would take the resize away
        let band = if IsZoomed(hwnd) != 0 { 0 } else { GetSystemMetricsForDpi(SM_CYFRAME, dpi) };
        let scale = dpi as f64 / 96.0;
        for (i, zone) in zones.iter().enumerate() {
            let zone = *zone as HWND;
            match anchors[i].filter(|_| visible).and_then(|a| a.rect(client.right, scale, band)) {
                Some([left, top, right, bottom]) => {
                    SetWindowPos(zone, HWND_TOP, left, top, right - left, bottom - top, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
                None => {
                    ShowWindow(zone, SW_HIDE);
                }
            }
        }
    }

    /// The covered window: the zones follow its size and DPI, and go with it.
    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if msg == WM_NCDESTROY {
            CAPTIONS.with(|c| c.borrow_mut().remove(&(hwnd as isize)));
            RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
            return DefSubclassProc(hwnd, msg, wparam, lparam);
        }
        // tao and wry first: a DPI change resizes the window there
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        match msg {
            WM_SIZE if wparam as u32 != SIZE_MINIMIZED => place(hwnd as isize),
            WM_DPICHANGED => place(hwnd as isize),
            _ => {}
        }
        result
    }

    fn button_of(zone: HWND) -> Option<Button> {
        match unsafe { GetWindowLongPtrW(zone, GWLP_USERDATA) } {
            1 => Some(Button::Min),
            2 => Some(Button::Max),
            3 => Some(Button::Close),
            _ => None,
        }
    }

    fn hit(button: Button) -> u32 {
        match button {
            Button::Min => HTMINBUTTON,
            Button::Max => HTMAXBUTTON,
            Button::Close => HTCLOSE,
        }
    }

    /// Screen coordinates packed in a mouse message's LPARAM.
    fn point(lparam: LPARAM) -> (i32, i32) {
        ((lparam & 0xFFFF) as i16 as i32, ((lparam >> 16) & 0xFFFF) as i16 as i32)
    }

    unsafe extern "system" fn zone_proc(zone: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        let Some(button) = button_of(zone) else {
            return DefWindowProcW(zone, msg, wparam, lparam);
        };
        let parent = GetParent(zone);
        match msg {
            // what Windows asks to decide on Snap layouts, the cursor and the clicks
            WM_NCHITTEST => return hit(button) as LRESULT,
            WM_ERASEBKGND => return 1,
            WM_PAINT => {
                ValidateRect(zone, std::ptr::null());
                return 0;
            }
            // the page's hover look; Windows' own handling follows (the
            // flyout comes from it)
            WM_NCMOUSEMOVE => hovered(zone, parent as isize, button),
            WM_NCMOUSELEAVE => left(parent as isize, button),
            // a click is a press and a release on the same zone. Never
            // Windows' own handling of them: it would act on the zone itself
            // (SC_CLOSE destroys it, SC_MAXIMIZE fills the window with it)
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                with(parent as isize, |c| c.pressed = Some(button));
                return 0;
            }
            WM_NCLBUTTONUP => {
                if with(parent as isize, |c| c.pressed.take() == Some(button)) == Some(true) {
                    click(parent, button);
                }
                return 0;
            }
            WM_NCRBUTTONDOWN | WM_NCRBUTTONDBLCLK => return 0,
            // as on Windows' own buttons, a right-click opens the window menu
            WM_NCRBUTTONUP => {
                let (x, y) = point(lparam);
                system_menu(parent, x, y);
                return 0;
            }
            // anything a zone is asked to do is for its window
            WM_SYSCOMMAND => {
                PostMessageW(parent, msg, wparam, lparam);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(zone, msg, wparam, lparam)
    }

    unsafe fn hovered(zone: HWND, parent: isize, button: Button) {
        let Some((track, label)) = with(parent, |c| {
            let track = !std::mem::replace(&mut c.tracking[button.index()], true);
            let changed = c.hover != Some(button);
            c.hover = Some(button);
            (track, changed.then(|| c.label.clone()))
        }) else {
            return;
        };
        if track {
            // TME_NONCLIENT: the whole zone is "non-client" for Windows
            let mut ev = TRACKMOUSEEVENT {
                cbSize: std::mem::size_of::<TRACKMOUSEEVENT>() as u32,
                dwFlags: TME_LEAVE | TME_NONCLIENT,
                hwndTrack: zone,
                dwHoverTime: 0,
            };
            TrackMouseEvent(&mut ev);
        }
        if let Some(label) = label {
            emit(&label, Some(button));
        }
    }

    unsafe fn left(parent: isize, button: Button) {
        let gone = with(parent, |c| {
            c.tracking[button.index()] = false;
            if c.pressed == Some(button) {
                c.pressed = None;
            }
            // moving straight onto the next zone, its own hover came first
            (c.hover == Some(button)).then(|| {
                c.hover = None;
                c.label.clone()
            })
        });
        if let Some(Some(label)) = gone {
            emit(&label, None);
        }
    }

    /// What the button does, posted so it happens after the click is handled.
    unsafe fn click(parent: HWND, button: Button) {
        match button {
            Button::Min => PostMessageW(parent, WM_SYSCOMMAND, SC_MINIMIZE as WPARAM, 0),
            Button::Max => {
                let cmd = if IsZoomed(parent) != 0 { SC_RESTORE } else { SC_MAXIMIZE };
                PostMessageW(parent, WM_SYSCOMMAND, cmd as WPARAM, 0)
            }
            // as Windows' own button: the page's onCloseRequested still asks
            // about unsaved edits
            Button::Close => PostMessageW(parent, WM_CLOSE, 0, 0),
        };
    }

    /// The window menu at a screen point, its entries enabled as Windows
    /// would for the window's state; what is picked goes to the window.
    unsafe fn system_menu(parent: HWND, x: i32, y: i32) {
        let menu = GetSystemMenu(parent, 0);
        if menu.is_null() {
            return;
        }
        let zoomed = IsZoomed(parent) != 0;
        for (item, on) in [
            (SC_RESTORE, zoomed),
            (SC_MOVE, !zoomed),
            (SC_SIZE, !zoomed),
            (SC_MINIMIZE, true),
            (SC_MAXIMIZE, !zoomed),
            (SC_CLOSE, true),
        ] {
            EnableMenuItem(menu, item, MF_BYCOMMAND | if on { MF_ENABLED } else { MF_GRAYED });
        }
        let cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, 0, parent, std::ptr::null());
        if cmd != 0 {
            PostMessageW(parent, WM_SYSCOMMAND, cmd as WPARAM, 0);
        }
    }

    /// show_system_menu: at `at` (physical screen px), else at the pointer.
    pub unsafe fn system_menu_at(parent: isize, at: Option<(i32, i32)>) {
        let (x, y) = at.unwrap_or_else(|| {
            let mut pt = POINT { x: 0, y: 0 };
            GetCursorPos(&mut pt);
            (pt.x, pt.y)
        });
        system_menu(parent as HWND, x, y);
    }

    /// What the zones of the window `parent` are, for the spike and the
    /// tests of the real app: Min, Max, Close.
    pub fn zones(parent: isize) -> Option<[isize; 3]> {
        with(parent, |c| c.zones)
    }
}

/// The zones of a window (Min, Max, Close), once installed: for the spike
/// (examples/caption_spike.rs). Call it on the UI thread.
#[cfg(windows)]
#[doc(hidden)]
pub fn zones(parent: isize) -> Option<[isize; 3]> {
    imp::zones(parent)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn button(kind: Button, x: f64) -> CaptionButton {
        CaptionButton { kind, x, y: 0.0, w: 46.0, h: 46.0 }
    }

    #[test]
    fn zones_sit_on_the_buttons_below_the_resize_band() {
        // 1200 CSS px wide at 100 %: Close is the last 46 px, under the 4 px band
        let close = Anchor::new(&button(Button::Close, 1154.0), 1200.0);
        assert_eq!(close.rect(1200, 1.0, 4), Some([1154, 4, 1200, 46]));
        // at 150 % the same CSS layout is 1800 physical px wide
        let max = Anchor::new(&button(Button::Max, 1108.0), 1200.0);
        assert_eq!(max.rect(1800, 1.5, 6), Some([1662, 6, 1731, 69]));
        // maximized: no band, the zone reaches the top edge (Fitts)
        assert_eq!(max.rect(1800, 1.5, 0), Some([1662, 0, 1731, 69]));
    }

    #[test]
    fn zones_follow_the_right_edge_on_a_resize() {
        let min = Anchor::new(&button(Button::Min, 1062.0), 1200.0);
        // the window narrowed to 1000 CSS px before the page laid out again
        assert_eq!(min.rect(1000, 1.0, 4), Some([862, 4, 908, 46]));
        assert_eq!(min.rect(1500, 1.5, 6), Some([1293, 6, 1362, 69]));
    }

    #[test]
    fn a_zone_with_nothing_left_is_none() {
        let flat = Anchor { right: 46.0, y: 0.0, w: 46.0, h: 3.0 };
        assert_eq!(flat.rect(1200, 1.0, 4), None, "all of it inside the resize band");
        let empty = Anchor { right: 46.0, y: 0.0, w: 0.0, h: 46.0 };
        assert_eq!(empty.rect(1200, 1.0, 4), None);
    }

    #[test]
    fn the_layout_reads_as_the_page_sends_it() {
        let json = r#"{"buttons":[{"kind":"min","x":1062,"y":0,"w":46,"h":46},
            {"kind":"max","x":1108,"y":0,"w":46,"h":46},{"kind":"close","x":1154,"y":0,"w":46,"h":46}],
            "visible":true}"#;
        let layout: CaptionLayout = serde_json::from_str(json).unwrap();
        assert_eq!(layout.buttons.len(), 3);
        assert_eq!(layout.buttons[2].kind, Button::Close);
        let hover = serde_json::to_string(&CaptionHover { button: Some(Button::Max) }).unwrap();
        assert_eq!(hover, r#"{"button":"max"}"#);
        let gone = serde_json::to_string(&CaptionHover { button: None }).unwrap();
        assert_eq!(gone, r#"{"button":null}"#);
    }
}
