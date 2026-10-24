//! Several documents at a time: every window holds tabs, each with its own
//! document, and all the windows live in one process. A file opened from
//! outside the app (double-click, "Open with", `leggimi file.md`) comes to
//! the front where a tab has it already, else gets a new tab in the window
//! used last (a window on its start page alone first); a window of its own
//! only when there is none. Inside the app, Shift+click, "Open in a new
//! window", Ctrl+Shift+N and a torn-off tab make a new window.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::utils::config::WindowConfig;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow, WebviewWindowBuilder, Window, WindowEvent};

use crate::{drag, AppState, Launch, Mode, WindowSlot};

/// New windows step this far (logical px) right and down from the one they come from.
const CASCADE: f64 = 32.0;
/// Windows made this soon after the previous one cascade from it, not from
/// the window they all come from.
const BURST: Duration = Duration::from_secs(3);

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    let state = window.state::<AppState>();
    match event {
        WindowEvent::Focused(true) => {
            let mut focus = state.focus.lock().unwrap();
            focus.retain(|l| l != window.label());
            focus.insert(0, window.label().to_owned());
        }
        // dropping the slot also stops its file watches
        WindowEvent::Destroyed => {
            state.windows.lock().unwrap().remove(window.label());
            state.focus.lock().unwrap().retain(|l| l != window.label());
        }
        _ => {}
    }
}

/// Where a launch goes; see route_launch.
#[derive(Debug, PartialEq, Eq)]
enum Target {
    /// its file is in a tab there (or on its way to one): that tab comes forward
    Activate(String),
    /// a new tab there
    Tab(String),
    /// no file: that window comes forward
    Front(String),
    /// a window of its own
    New,
}

/// The windows the way the rules below look at them: by use, the one used
/// last first (`focus`), then those never focused yet (still being built)
/// by label, so the choice is always the same.
fn by_use<'a>(windows: &'a HashMap<String, WindowSlot>, focus: &[String]) -> Vec<(&'a str, &'a WindowSlot)> {
    let mut order: Vec<(&str, &WindowSlot)> = focus
        .iter()
        .filter_map(|l| windows.get_key_value(l.as_str()))
        .map(|(l, s)| (l.as_str(), s))
        .collect();
    let mut rest: Vec<(&str, &WindowSlot)> = windows
        .iter()
        .filter(|(l, _)| !focus.contains(l))
        .map(|(l, s)| (l.as_str(), s))
        .collect();
    // doc-9 before doc-10
    rest.sort_by_key(|(l, _)| (l.len(), *l));
    order.extend(rest);
    order
}

/// The window a launch goes to. `file`: the launch's file, canonical when
/// it exists, else the full path it came with (a document deleted while a
/// tab showed it is still known by it). A window asking whether to close is
/// never picked.
fn target(windows: &HashMap<String, WindowSlot>, focus: &[String], file: Option<&Path>) -> Target {
    let order = by_use(windows, focus);
    let open = |s: &WindowSlot| !s.closing;
    let Some(file) = file else {
        // no file: the window used last comes forward (none left: a new one)
        return order
            .iter()
            .find(|(_, s)| open(s))
            .map_or(Target::New, |(l, _)| Target::Front(l.to_string()));
    };
    // 1. a tab has it, or it is on its way to one
    if let Some((l, _)) = order.iter().find(|(_, s)| open(s) && s.holds(file)) {
        return Target::Activate(l.to_string());
    }
    // 2. a window on its start page alone, nothing on its way to it
    if let Some((l, _)) = order.iter().find(|(_, s)| s.idle()) {
        return Target::Tab(l.to_string());
    }
    // 3. the window used last, also while its page is still loading (the
    //    first window, as Explorer starts a burst): it gets the file as soon
    //    as its page listens
    if let Some((l, s)) = focus.first().and_then(|l| windows.get_key_value(l.as_str())) {
        if open(s) {
            return Target::Tab(l.clone());
        }
    }
    // 4. any other whose page listens
    if let Some((l, _)) = order.iter().find(|(_, s)| open(s) && s.ready) {
        return Target::Tab(l.to_string());
    }
    Target::New
}

/// What route_launch does once the lock is gone.
#[derive(Debug)]
enum Routed {
    /// send it to that window's page ("open-file") and bring the window forward
    Emit(String, Launch),
    /// the window's page is not listening yet: it opens it itself (its own
    /// launch, or the queue get_initial_file empties)
    Wait,
    /// no file: bring the window forward
    Front(String),
    /// a window was reserved for it: build it
    Build(String),
}

/// Decides where a launch goes and claims it there, under the lock: a burst
/// of launches (they can arrive together) finds each file on its way to the
/// window that took it, so none is lost and none opened twice. `canon`: the
/// launch's file, canonical, when it exists.
fn claim(
    windows: &mut HashMap<String, WindowSlot>,
    focus: &[String],
    mut launch: Launch,
    canon: Option<PathBuf>,
    new_label: impl FnOnce() -> String,
) -> Routed {
    let file = canon.clone().or_else(|| launch.path.as_deref().map(PathBuf::from));
    // the pages know their documents by the canonical path
    if let Some(c) = &canon {
        launch.path = Some(c.to_string_lossy().into_owned());
    }
    match target(windows, focus, file.as_deref()) {
        Target::Front(label) => Routed::Front(label),
        Target::Activate(label) => {
            let slot = &windows[&label];
            if slot.ready && slot.shown {
                launch.mode = Some(Mode::Activate);
                Routed::Emit(label, launch)
            } else {
                Routed::Wait
            }
        }
        Target::Tab(label) => {
            let slot = windows.get_mut(&label).expect("the target is there");
            if let Some(c) = canon {
                slot.expect(c);
            }
            launch.mode = Some(Mode::Tab);
            // not before the page has opened what it starts with: the
            // launches keep their order behind it
            if slot.ready && slot.shown {
                Routed::Emit(label, launch)
            } else {
                slot.queued.push(launch);
                Routed::Wait
            }
        }
        Target::New => {
            let label = new_label();
            launch.mode = None;
            windows.insert(label.clone(), WindowSlot::reserved(launch, canon));
            Routed::Build(label)
        }
    }
}

/// A launch from outside the app (a second `leggimi` process forwarded by
/// the single-instance plugin), routed as `target` says. A file that is not
/// there (a typo, a dead jump-list entry) goes by the same rules: the page
/// that gets it says it is missing.
pub fn route_launch(app: &AppHandle, launch: Launch) {
    route(app, launch, 2);
}

fn route(app: &AppHandle, launch: Launch, tries: u8) {
    let state = app.state::<AppState>();
    let canon = launch.path.as_deref().and_then(|p| dunce::canonicalize(p).ok());
    let focus = state.focus.lock().unwrap().clone();
    // decided and claimed under one lock; the lock is gone before any window
    // is built (the main thread takes it then)
    let routed = {
        let mut windows = state.windows.lock().unwrap();
        claim(&mut windows, &focus, launch.clone(), canon, || new_label(&state))
    };
    match routed {
        Routed::Build(label) => {
            let from = focus.iter().find_map(|l| app.get_webview_window(l));
            let _ = build(app, from.as_ref(), label, None);
        }
        Routed::Emit(label, payload) => match app.get_webview_window(&label) {
            Some(win) => {
                let _ = app.emit_to(win.label(), "open-file", &payload);
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
            // closed meanwhile, its slot not gone yet: forget it, try again
            None if tries > 0 => {
                state.windows.lock().unwrap().remove(&label);
                route(app, launch, tries - 1);
            }
            None => {}
        },
        Routed::Front(label) => {
            if let Some(win) = app.get_webview_window(&label) {
                // still loading: it shows itself when its page is ready
                if win.is_visible().unwrap_or(false) {
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
            }
        }
        Routed::Wait => {}
    }
}

fn new_label(state: &AppState) -> String {
    format!("doc-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1)
}

/// Opens a new window for `launch` (an empty one, on the start page, when it
/// has no file), placed from `from`, the window it comes from, or at `at`
/// (its outer top-left, physical px; a torn-off tab). Its page shows it once
/// it has rendered (`show_window`), like the first window; with `follow` it
/// then follows the pointer (drag.rs). Returns its label.
pub fn create_window(
    app: &AppHandle,
    from: Option<&WebviewWindow>,
    launch: Launch,
    at: Option<(i32, i32)>,
    follow: Option<drag::Follow>,
) -> Result<String, String> {
    let state = app.state::<AppState>();
    // a torn-off tab's file is on its way there too
    let canon = launch.file().and_then(|p| dunce::canonicalize(p).ok());
    let label = {
        let mut windows = state.windows.lock().unwrap();
        let label = new_label(&state);
        let mut slot = WindowSlot::reserved(launch, canon);
        slot.follow = follow;
        windows.insert(label.clone(), slot);
        label
    };
    build(app, from, label.clone(), at)?;
    Ok(label)
}

fn build(app: &AppHandle, from: Option<&WebviewWindow>, label: String, at: Option<(i32, i32)>) -> Result<(), String> {
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

    match at {
        // a torn-off tab: the size of the window it comes from, where the page says
        Some(_) => {
            if let Some(base) = from {
                size_like(&mut config, base);
            }
            config.center = false;
            config.maximized = false;
        }
        None => {
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
        }
    }

    match WebviewWindowBuilder::from_config(app, &config).and_then(|b| b.build()) {
        Ok(win) => {
            match at {
                // still hidden: it shows there
                Some((x, y)) => {
                    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                }
                None => *state.last_created.lock().unwrap() = Some((label, Instant::now())),
            }
            Ok(())
        }
        Err(e) => {
            state.windows.lock().unwrap().remove(&label);
            Err(e.to_string())
        }
    }
}

/// The size of `base` for a torn-off tab's window; the default size when
/// `base` fills the screen or is minimized.
fn size_like(config: &mut WindowConfig, base: &WebviewWindow) {
    if base.is_minimized().unwrap_or(false) || base.is_maximized().unwrap_or(false) {
        return;
    }
    if let (Ok(scale), Ok(size)) = (base.scale_factor(), base.inner_size()) {
        config.width = size.width as f64 / scale;
        config.height = size.height as f64 / scale;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// A window for the tables: started (listening, shown) or not, its tabs.
    fn slot(ready: bool, docs: &[&str]) -> WindowSlot {
        WindowSlot {
            ready,
            shown: ready,
            docs: docs.iter().map(PathBuf::from).collect(),
            ..Default::default()
        }
    }

    fn windows(slots: Vec<(&str, WindowSlot)>) -> HashMap<String, WindowSlot> {
        slots.into_iter().map(|(l, s)| (l.to_owned(), s)).collect()
    }

    fn focus(labels: &[&str]) -> Vec<String> {
        labels.iter().map(|l| l.to_string()).collect()
    }

    fn act(l: &str) -> Target {
        Target::Activate(l.to_owned())
    }
    fn tab(l: &str) -> Target {
        Target::Tab(l.to_owned())
    }

    const A: &str = r"C:\docs\a.md";
    const B: &str = r"C:\docs\b.md";
    const GONE: &str = r"C:\docs\gone.md";

    #[test]
    fn the_rules_in_order() {
        let closing = |docs: &[&str]| WindowSlot { closing: true, ..slot(true, docs) };
        let loading = |launch: Option<&str>| WindowSlot {
            launch: Some(Launch { path: launch.map(str::to_owned), ..Default::default() }),
            opening: launch.map(PathBuf::from).into_iter().collect(),
            ..Default::default()
        };
        let opening = |file: &str| WindowSlot { opening: vec![PathBuf::from(file)], ..slot(true, &[]) };
        #[rustfmt::skip]
        let table: Vec<(&str, Vec<(&str, WindowSlot)>, Vec<String>, Option<&str>, Target)> = vec![
            ("1. in a tab of the window used last",
                vec![("main", slot(true, &[A, B])), ("doc-1", slot(true, &[]))], focus(&["main", "doc-1"]), Some(A), act("main")),
            ("1. in a tab of a window behind: still that one",
                vec![("main", slot(true, &[B])), ("doc-1", slot(true, &[A]))], focus(&["main", "doc-1"]), Some(A), act("doc-1")),
            ("1. in two windows: the one used last",
                vec![("main", slot(true, &[A])), ("doc-1", slot(true, &[A]))], focus(&["doc-1", "main"]), Some(A), act("doc-1")),
            ("1. case does not matter",
                vec![("main", slot(true, &[A]))], focus(&["main"]), Some(r"c:\DOCS\A.MD"), act("main")),
            ("1. on its way to a tab (routed, not yet in set_tabs)",
                vec![("main", slot(true, &[B])), ("doc-1", opening(A))], focus(&["main", "doc-1"]), Some(A), act("doc-1")),
            ("1. a window being built for it opens it itself",
                vec![("main", slot(true, &[B])), ("doc-1", loading(Some(A)))], focus(&["main"]), Some(A), act("doc-1")),
            ("1. not in a window asking whether to close: a new tab elsewhere",
                vec![("main", closing(&[A])), ("doc-1", slot(true, &[B]))], focus(&["main", "doc-1"]), Some(A), tab("doc-1")),
            ("1. a deleted document still shown is found by its full path",
                vec![("main", slot(true, &[B])), ("doc-1", slot(true, &[GONE]))], focus(&["main", "doc-1"]), Some(GONE), act("doc-1")),
            ("2. a window on its start page alone, though not the last used",
                vec![("main", slot(true, &[B])), ("doc-1", slot(true, &[]))], focus(&["main", "doc-1"]), Some(A), tab("doc-1")),
            ("2. not one with a file on its way",
                vec![("main", slot(true, &[B])), ("doc-1", opening(GONE))], focus(&["main", "doc-1"]), Some(A), tab("main")),
            ("2. not one still loading (its own launch may hold a file)",
                vec![("main", slot(true, &[B])), ("doc-1", loading(None))], focus(&["main"]), Some(A), tab("main")),
            ("3. the window used last",
                vec![("main", slot(true, &[B])), ("doc-1", slot(true, &[GONE]))], focus(&["doc-1", "main"]), Some(A), tab("doc-1")),
            ("3. the window used last, minimized or not: route_launch restores it",
                vec![("main", slot(true, &[B]))], focus(&["main"]), Some(A), tab("main")),
            ("3. the first window while its page loads (a burst from Explorer)",
                vec![("main", loading(Some(B)))], focus(&["main"]), Some(A), tab("main")),
            ("4. the last used is asking whether to close: any other that listens",
                vec![("main", closing(&[B])), ("doc-1", slot(true, &[GONE])), ("doc-2", slot(false, &[]))],
                focus(&["main", "doc-1"]), Some(A), tab("doc-1")),
            ("4. the last used has closed: one that listens, in the order of use",
                vec![("main", slot(true, &[B])), ("doc-1", slot(true, &[GONE]))], focus(&["doc-9", "doc-1", "main"]), Some(A), tab("doc-1")),
            ("5. none can take it: a new window",
                vec![("main", closing(&[B]))], focus(&["main"]), Some(A), Target::New),
            ("5. no window at all",
                vec![], focus(&[]), Some(A), Target::New),
            ("a missing file by the same rules: a new tab where the page says so",
                vec![("main", slot(true, &[B]))], focus(&["main"]), Some(GONE), tab("main")),
            ("no file: the window used last comes forward",
                vec![("main", slot(true, &[B])), ("doc-1", slot(true, &[]))], focus(&["main", "doc-1"]), None, Target::Front("main".into())),
            ("no file: not one asking whether to close",
                vec![("main", closing(&[B])), ("doc-1", slot(true, &[]))], focus(&["main", "doc-1"]), None, Target::Front("doc-1".into())),
            ("no file and no window: an empty one",
                vec![], focus(&[]), None, Target::New),
        ];
        for (what, slots, focus, file, want) in table {
            let w = windows(slots);
            assert_eq!(target(&w, &focus, file.map(Path::new)), want, "{what}");
        }
    }

    /// The pages of a test run: what each window opens, by the end.
    #[derive(Default)]
    struct Pages {
        /// (window, file) for every file a page opens in a tab
        opened: Vec<(String, String)>,
        /// (window, file) for every "activate"
        activated: Vec<(String, String)>,
    }

    /// One launch through `claim`, as route_launch does it (the build of a
    /// new window is its slot); "open-file" lands in `pages`.
    fn launch(w: &mut HashMap<String, WindowSlot>, focus: &[String], next: &mut u32, pages: &mut Pages, file: &str) {
        let l = Launch { path: Some(file.to_owned()), ..Default::default() };
        let canon = Some(PathBuf::from(file));
        let routed = claim(w, focus, l, canon, || {
            *next += 1;
            format!("doc-{next}")
        });
        match routed {
            Routed::Emit(label, l) => {
                let path = l.path.unwrap();
                match l.mode {
                    Some(Mode::Tab) => pages.opened.push((label, path)),
                    Some(Mode::Activate) => pages.activated.push((label, path)),
                    None => panic!("an emitted launch has a mode"),
                }
            }
            Routed::Wait | Routed::Build(_) | Routed::Front(_) => {}
        }
    }

    /// A page starting: get_initial_file (its own launch) and, once it has
    /// opened that, show_window (the launches queued meanwhile), as the page
    /// opens them. `between`: launches that arrive in between.
    fn page_starts(
        w: &mut HashMap<String, WindowSlot>,
        label: &str,
        pages: &mut Pages,
        between: impl FnOnce(&mut HashMap<String, WindowSlot>, &mut Pages),
    ) {
        let initial = crate::commands::start(w.get_mut(label).unwrap());
        let record = |pages: &mut Pages, l: Launch| {
            if let Some(p) = l.path {
                match l.mode {
                    Some(Mode::Activate) => pages.activated.push((label.to_owned(), p)),
                    _ => pages.opened.push((label.to_owned(), p)),
                }
            }
        };
        if let Some(l) = initial {
            record(pages, l);
        }
        between(w, pages);
        for l in crate::commands::shown(w.get_mut(label).unwrap()) {
            record(pages, l);
        }
    }

    /// set_tabs: the page reports every file it opened as a tab.
    fn tabs_reported(w: &mut HashMap<String, WindowSlot>, pages: &Pages) {
        for (label, slot) in w.iter_mut() {
            let docs: Vec<PathBuf> =
                pages.opened.iter().filter(|(l, _)| l == label).map(|(_, p)| PathBuf::from(p)).collect();
            crate::commands::tabs_changed(slot, docs, None);
        }
    }

    fn files(n: usize, burst: usize) -> Vec<String> {
        (0..n).map(|i| format!(r"C:\burst\b{burst}-f{i}.md")).collect()
    }

    fn assert_once_each(pages: &Pages, all: &[String]) {
        let opened: Vec<&String> = pages.opened.iter().map(|(_, p)| p).collect();
        let distinct: HashSet<&String> = opened.iter().copied().collect();
        assert_eq!(opened.len(), distinct.len(), "no file opened twice: {opened:?}");
        for f in all {
            assert!(distinct.contains(f), "{f} opened");
        }
    }

    #[test]
    fn a_burst_at_start_goes_to_the_first_window_whole() {
        // Explorer starts Leggimi with the first of 10 files and forwards the
        // other 9 while the first window's page still loads
        let all = files(10, 0);
        let mut w = windows(vec![(
            "main",
            WindowSlot::reserved(Launch { path: Some(all[0].clone()), ..Default::default() }, Some(PathBuf::from(&all[0]))),
        )]);
        let focus = focus(&["main"]);
        let (mut next, mut pages) = (0, Pages::default());
        for f in &all[1..8] {
            launch(&mut w, &focus, &mut next, &mut pages, f);
        }
        assert_eq!(w.len(), 1, "no window of their own");
        assert!(pages.opened.is_empty(), "nothing sent before the page listens");
        // two more while the page opens its own file (listening, not shown yet),
        // and a repeat of its own file
        page_starts(&mut w, "main", &mut pages, |w, pages| {
            let mut next = 0;
            for f in [&all[8], &all[9], &all[0]] {
                launch(w, &focus, &mut next, pages, f);
            }
            assert_eq!(pages.opened.len(), 1, "still only its own file");
        });
        assert_once_each(&pages, &all);
        assert!(pages.opened.iter().all(|(l, _)| l == "main"));
        let order: Vec<&String> = pages.opened.iter().map(|(_, p)| p).collect();
        assert_eq!(order, all.iter().collect::<Vec<_>>(), "its own file first, the others in the order they came");
        // shown: the next launch goes straight to the page
        launch(&mut w, &focus, &mut next, &mut pages, r"C:\docs\later.md");
        assert_eq!(pages.opened.last().map(|(_, p)| p.as_str()), Some(r"C:\docs\later.md"));
    }

    #[test]
    fn a_window_opened_on_its_start_page_takes_the_first_queued_file_as_its_own() {
        let mut w = windows(vec![("main", WindowSlot::reserved(Launch::default(), None))]);
        let focus = focus(&["main"]);
        let (mut next, mut pages) = (0, Pages::default());
        launch(&mut w, &focus, &mut next, &mut pages, A);
        launch(&mut w, &focus, &mut next, &mut pages, B);
        let initial = crate::commands::start(w.get_mut("main").unwrap()).unwrap();
        assert_eq!(initial.path.as_deref(), Some(A));
        assert_eq!(initial.mode, None, "what it starts with");
        let rest = crate::commands::shown(w.get_mut("main").unwrap());
        assert_eq!(rest.len(), 1);
        assert_eq!((rest[0].path.as_deref(), rest[0].mode), (Some(B), Some(Mode::Tab)));
    }

    #[test]
    fn five_bursts_of_ten_with_repeats_lose_and_double_nothing() {
        let mut w = windows(vec![("main", slot(true, &[])), ("doc-1", slot(true, &[r"C:\docs\x.md"]))]);
        let focus = focus(&["doc-1", "main"]);
        let (mut next, mut pages) = (1, Pages::default());
        let mut all = Vec::new();
        for burst in 0..5 {
            let batch = files(10, burst);
            for f in &batch {
                launch(&mut w, &focus, &mut next, &mut pages, f);
                // the same file again within the burst (a double-click twice)
                if f.ends_with("f3.md") {
                    launch(&mut w, &focus, &mut next, &mut pages, f);
                }
            }
            // the pages catch up only between some bursts
            if burst % 2 == 1 {
                tabs_reported(&mut w, &pages);
            }
            all.extend(batch);
        }
        assert_eq!(w.len(), 2, "no new window: every file found a window that listens");
        assert_once_each(&pages, &all);
        assert_eq!(pages.activated.len(), 5, "each repeat brings its tab forward");
        assert!(
            pages.activated.iter().all(|(l, p)| pages.opened.contains(&(l.clone(), p.clone()))),
            "in the window that has it"
        );
        // the first file went to the window on its start page; that window,
        // busy from then on, is not the last used one, which takes the rest
        assert_eq!(pages.opened[0].0, "main");
        assert!(pages.opened[1..].iter().all(|(l, _)| l == "doc-1"));
        // a later launch of any of them finds it, whether the page reported it yet or not
        launch(&mut w, &focus, &mut next, &mut pages, &all[42]);
        assert_eq!(pages.activated.last().map(|(_, p)| p), Some(&all[42]));
    }

    #[test]
    fn set_tabs_clears_what_arrived_and_keeps_what_is_on_its_way() {
        let mut w = windows(vec![("main", slot(true, &[]))]);
        let focus = focus(&["main"]);
        let (mut next, mut pages) = (0, Pages::default());
        launch(&mut w, &focus, &mut next, &mut pages, A);
        launch(&mut w, &focus, &mut next, &mut pages, B);
        assert_eq!(w["main"].opening.len(), 2);
        // the page reports A before B arrives
        crate::commands::tabs_changed(w.get_mut("main").unwrap(), vec![PathBuf::from(A)], Some(PathBuf::from(A)));
        assert_eq!(w["main"].opening, vec![PathBuf::from(B)], "B is still on its way");
        assert!(!w["main"].idle());
        crate::commands::tabs_changed(w.get_mut("main").unwrap(), vec![PathBuf::from(A), PathBuf::from(B)], None);
        assert!(w["main"].opening.is_empty());
        // its tabs all closed: a start page again, free for the next launch
        crate::commands::tabs_changed(w.get_mut("main").unwrap(), vec![], None);
        assert!(w["main"].idle());
    }

    #[test]
    fn a_launch_while_no_window_listens_gets_one_of_its_own() {
        let mut w = windows(vec![("main", WindowSlot { closing: true, ..slot(true, &[B]) })]);
        let (mut next, mut pages) = (0, Pages::default());
        launch(&mut w, &focus(&["main"]), &mut next, &mut pages, A);
        assert!(w.contains_key("doc-1"), "reserved");
        assert_eq!(w["doc-1"].launch.as_ref().and_then(|l| l.path.as_deref()), Some(A));
        assert_eq!(w["doc-1"].launch.as_ref().and_then(|l| l.mode), None, "its own launch has no mode");
        // a second launch of it before the window is built finds it there
        launch(&mut w, &focus(&["main"]), &mut next, &mut pages, A);
        assert_eq!(w.len(), 2, "not another window");
        assert!(pages.activated.is_empty(), "nothing to send: it opens it itself");
    }
}
