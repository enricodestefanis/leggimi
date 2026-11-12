//! "Paste and read" from the start page's button and the command palette:
//! the clipboard's text, read here. Ctrl+V needs none of this (the page reads
//! its own paste event); a button or a command has no paste event to read.

use serde::Serialize;

/// What the clipboard holds for a paste: its text (None: no text on it), and
/// whether it holds a picture, which the page cannot open as a document.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardText {
    pub text: Option<String>,
    pub image: bool,
}

/// Error from read_clipboard_text when another app keeps the clipboard open:
/// the page says so in its own words.
pub const BUSY: &str = "clipboard-busy";

/// The clipboard's text, and whether it holds an image. Off the main thread:
/// another app may hold the clipboard for a moment (the app that is copying,
/// a clipboard manager), and this waits for it a little.
#[tauri::command]
pub async fn read_clipboard_text() -> Result<ClipboardText, String> {
    tauri::async_runtime::spawn_blocking(imp::read)
        .await
        .map_err(|e| e.to_string())?
}

/// UTF-16 up to the first NUL, or all of it when there is none; a lone
/// surrogate becomes U+FFFD.
#[cfg_attr(not(windows), allow(dead_code))]
fn until_nul(units: &[u16]) -> String {
    let end = units.iter().position(|&u| u == 0).unwrap_or(units.len());
    String::from_utf16_lossy(&units[..end])
}

#[cfg(windows)]
mod imp {
    use std::time::Duration;

    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    use super::{until_nul, ClipboardText, BUSY};

    /// How many times, and how far apart, to try opening a clipboard that
    /// another app holds.
    const OPEN_TRIES: u32 = 10;
    const OPEN_WAIT: Duration = Duration::from_millis(15);

    // The standard formats (winuser.h): text as UTF-16, and the three a
    // picture comes as (Windows makes each of them from the others).
    const CF_UNICODETEXT: u32 = 13;
    const CF_BITMAP: u32 = 2;
    const CF_DIB: u32 = 8;
    const CF_DIBV5: u32 = 17;

    /// The clipboard, open until this is dropped, whatever happens meanwhile.
    struct Open;

    impl Drop for Open {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    /// Opens the clipboard for this thread; None when another app holds it
    /// for longer than OPEN_TRIES allow. No window owns it: reading needs none.
    fn open() -> Option<Open> {
        for attempt in 0..OPEN_TRIES {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 {
                return Some(Open);
            }
            if attempt + 1 < OPEN_TRIES {
                std::thread::sleep(OPEN_WAIT);
            }
        }
        None
    }

    pub fn read() -> Result<ClipboardText, String> {
        let _open = open().ok_or_else(|| BUSY.to_owned())?;
        let available = |format: u32| unsafe { IsClipboardFormatAvailable(format) } != 0;
        let image = [CF_DIB, CF_DIBV5, CF_BITMAP].into_iter().any(available);
        // text another app put there as ANSI comes as UTF-16 too: Windows converts it
        let text = if available(CF_UNICODETEXT) { unsafe { unicode_text() } } else { None };
        Ok(ClipboardText { text, image })
    }

    /// The text on the open clipboard: up to its first NUL, within the size of
    /// its memory block (a text without one ends there).
    unsafe fn unicode_text() -> Option<String> {
        let handle = GetClipboardData(CF_UNICODETEXT);
        if handle.is_null() {
            return None;
        }
        let units = GlobalSize(handle) / 2;
        let data = GlobalLock(handle) as *const u16;
        if data.is_null() {
            return None;
        }
        let text = until_nul(std::slice::from_raw_parts(data, units));
        GlobalUnlock(handle);
        Some(text)
    }
}

#[cfg(not(windows))]
mod imp {
    use super::ClipboardText;

    pub fn read() -> Result<ClipboardText, String> {
        Err("Reading the clipboard is only available on Windows".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn utf16(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn the_text_ends_at_its_first_nul() {
        assert_eq!(until_nul(&utf16("ab\0cd\0")), "ab");
        assert_eq!(until_nul(&utf16("no end")), "no end", "bounded by its block");
        assert_eq!(until_nul(&utf16("\0")), "");
        assert_eq!(until_nul(&[]), "");
        assert_eq!(until_nul(&utf16("città 😀 中文\r\nx\0")), "città 😀 中文\r\nx", "emoji, CJK, CRLF");
        assert_eq!(until_nul(&[0x61, 0xD800, 0x62, 0]), "a\u{FFFD}b", "a lone surrogate");
    }

    #[test]
    fn the_answer_reads_as_the_page_expects() {
        let c = ClipboardText { text: Some("# Notes".into()), image: true };
        assert_eq!(serde_json::to_string(&c).unwrap(), r##"{"text":"# Notes","image":true}"##);
        assert_eq!(serde_json::to_string(&ClipboardText::default()).unwrap(), r#"{"text":null,"image":false}"#);
    }

    /// The real clipboard, only read (never written), and only what it holds
    /// told, not its text: `cargo test -- --ignored --nocapture clipboard`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_the_real_clipboard() {
        match imp::read() {
            Ok(c) => println!(
                "clipboard: text {:?} UTF-16 units, image {}",
                c.text.map(|t| t.encode_utf16().count()),
                c.image
            ),
            Err(e) => assert_eq!(e, BUSY),
        }
    }
}
