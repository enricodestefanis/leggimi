//! "Paste and read" from the start page's button and the command palette:
//! the clipboard's text, read here. Ctrl+V needs none of this (the page reads
//! its own paste event); a button or a command has no paste event to read.

use serde::Serialize;

/// What the clipboard holds for a paste: its text (None: no text on it),
/// whether it holds a picture, which the page cannot open as a document, and
/// the formatted copy of the same selection that browsers, Word or chat apps
/// put beside the text ("HTML Format": the fragment copied, see html_fragment;
/// None when there is none), for the page to turn into Markdown.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardText {
    pub text: Option<String>,
    pub image: bool,
    pub html: Option<String>,
}

/// The largest HTML fragment read_clipboard_text passes on, in bytes: a
/// selection as big as that is no longer a paste to convert.
const MAX_HTML: usize = 4 * 1024 * 1024;

/// The fragment copied, out of the clipboard's "HTML Format" (CF_HTML): a
/// header of `Key:value` lines whose StartFragment / EndFragment give its
/// byte offsets from the start of the data (else StartHTML / EndHTML, the
/// whole HTML around it), then the HTML. An end past the data stops at the
/// data's end, as do the NULs that pad the clipboard's memory block; UTF-8,
/// with U+FFFD for any bytes that are not. None without a usable header or
/// range, for an empty fragment, or one over MAX_HTML.
#[cfg_attr(not(windows), allow(dead_code))]
fn html_fragment(data: &[u8]) -> Option<String> {
    let header = cf_html_header(data);
    let offset = |key: &str| {
        let (_, value) = header.iter().find(|(k, _)| k.eq_ignore_ascii_case(key))?;
        value.trim().parse::<usize>().ok() // -1, "none here", fails too
    };
    let range = |start: &str, end: &str| {
        let (start, end) = (offset(start)?, offset(end)?.min(data.len()));
        (start < end).then_some(start..end)
    };
    let found = &data[range("StartFragment", "EndFragment").or_else(|| range("StartHTML", "EndHTML"))?];
    // the block's padding, or an end given past the HTML
    let found = &found[..found.iter().take(MAX_HTML + 1).position(|&b| b == 0).unwrap_or(found.len())];
    if found.is_empty() || found.len() > MAX_HTML {
        return None;
    }
    Some(String::from_utf8_lossy(found).into_owned())
}

/// The `Key:value` lines that open CF_HTML data, up to the HTML (a line that
/// starts with `<`) or the first line that is not one, within its first 64 KB.
#[cfg_attr(not(windows), allow(dead_code))]
fn cf_html_header(data: &[u8]) -> Vec<(String, String)> {
    let head = &data[..data.len().min(64 * 1024)];
    let mut header = Vec::new();
    for line in head.split(|&b| b == b'\n' || b == b'\r').filter(|l| !l.is_empty()) {
        let line = String::from_utf8_lossy(line);
        let Some((key, value)) = line.split_once(':') else { break };
        if key.is_empty() || !key.bytes().all(|b| b.is_ascii_alphanumeric()) {
            break; // the HTML, `<html>` or `<!--StartFragment-->`
        }
        header.push((key.to_owned(), value.to_owned()));
    }
    header
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
        CloseClipboard, GetClipboardData, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    use super::{html_fragment, until_nul, ClipboardText, BUSY};

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
        let html = html_format().filter(|&f| available(f)).and_then(|f| unsafe { html_data(f) });
        Ok(ClipboardText { text, image, html })
    }

    /// The number of the clipboard format "HTML Format" (CF_HTML), the same
    /// for every app; None if Windows will not say.
    fn html_format() -> Option<u32> {
        let name: Vec<u16> = "HTML Format".encode_utf16().chain(std::iter::once(0)).collect();
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        (format != 0).then_some(format)
    }

    /// The HTML fragment on the open clipboard (html_fragment), read in place:
    /// only the fragment is copied out of the memory block.
    unsafe fn html_data(format: u32) -> Option<String> {
        let handle = GetClipboardData(format);
        if handle.is_null() {
            return None;
        }
        let size = GlobalSize(handle);
        let data = GlobalLock(handle) as *const u8;
        if data.is_null() {
            return None;
        }
        let html = html_fragment(std::slice::from_raw_parts(data, size));
        GlobalUnlock(handle);
        html
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
        let c = ClipboardText { text: Some("# Notes".into()), image: true, html: Some("<b>Notes</b>".into()) };
        assert_eq!(
            serde_json::to_string(&c).unwrap(),
            r##"{"text":"# Notes","image":true,"html":"<b>Notes</b>"}"##
        );
        assert_eq!(
            serde_json::to_string(&ClipboardText::default()).unwrap(),
            r#"{"text":null,"image":false,"html":null}"#
        );
    }

    /// CF_HTML as Windows documents it, with `eol` ending the header's lines:
    /// the offsets count bytes from the start of the data, header included.
    fn cf_html_eol(eol: &str, before: &str, fragment: &str, after: &str, source: Option<&str>) -> Vec<u8> {
        let header = |sh: usize, eh: usize, sf: usize, ef: usize| {
            let source = source.map(|s| format!("SourceURL:{s}{eol}")).unwrap_or_default();
            format!("Version:0.9{eol}StartHTML:{sh:010}{eol}EndHTML:{eh:010}{eol}StartFragment:{sf:010}{eol}EndFragment:{ef:010}{eol}{source}")
        };
        let start_html = header(0, 0, 0, 0).len();
        let start_fragment = start_html + before.len();
        let end_fragment = start_fragment + fragment.len();
        let end_html = end_fragment + after.len();
        format!("{}{before}{fragment}{after}", header(start_html, end_html, start_fragment, end_fragment)).into_bytes()
    }

    fn cf_html(before: &str, fragment: &str, after: &str, source: Option<&str>) -> Vec<u8> {
        cf_html_eol("\r\n", before, fragment, after, source)
    }

    #[test]
    fn the_html_is_the_fragment_copied() {
        let before = "<html><body>\r\n<!--StartFragment-->";
        let after = "<!--EndFragment-->\r\n</body>\r\n</html>";
        let fragment = "<table><tr><th>Città</th></tr><tr><td>中文 😀</td></tr></table>";
        let data = cf_html(before, fragment, after, Some("https://example.com/a:b?c=d"));
        assert_eq!(html_fragment(&data).as_deref(), Some(fragment), "UTF-8, a SourceURL with colons");
        // the memory block is bigger than the data: zeros after it
        let mut padded = data.clone();
        padded.extend([0u8; 13]);
        assert_eq!(html_fragment(&padded).as_deref(), Some(fragment), "padding");
        // a header with LF only, or CR only
        for eol in ["\n", "\r"] {
            assert_eq!(html_fragment(&cf_html_eol(eol, before, fragment, after, None)).as_deref(), Some(fragment), "{eol:?}");
        }
        // keys in another case, a space before a number (the same length: the offsets hold)
        let text = String::from_utf8(data).unwrap();
        let loose = text.replace("StartFragment:", "startfragment:").replace("EndFragment:0", "ENDFRAGMENT: ");
        assert_eq!(html_fragment(loose.as_bytes()).as_deref(), Some(fragment), "{loose}");
        // the HTML that follows the header is not read as more header, colons and all
        let header = cf_html_header(&cf_html("<html xmlns:o=\"urn:x\">\r\nKey:1\r\n", "<p>x</p>", "</html>", None));
        assert_eq!(header.len(), 5, "{header:?}");
    }

    #[test]
    fn without_fragment_offsets_the_whole_html_is_taken() {
        let html = "<html><body><p>Ciao</p></body></html>";
        let head = |start: usize, end: usize| format!("Version:1.0\r\nStartHTML:{start:010}\r\nEndHTML:{end:010}\r\n");
        let start = head(0, 0).len();
        let data = format!("{}{html}", head(start, start + html.len()));
        assert_eq!(html_fragment(data.as_bytes()).as_deref(), Some(html), "no StartFragment/EndFragment");
        // fragment offsets that say "none" (-1) fall back as well
        let head = |s: usize, e: usize| format!("Version:1.0\r\nStartHTML:{s:010}\r\nEndHTML:{e:010}\r\nStartFragment:-1\r\nEndFragment:-1\r\n");
        let start = head(0, 0).len();
        let data = format!("{}{html}", head(start, start + html.len()));
        assert_eq!(html_fragment(data.as_bytes()).as_deref(), Some(html));
        // no offsets at all, no header at all: nothing
        assert_eq!(html_fragment(b"Version:0.9\r\n<html></html>"), None);
        assert_eq!(html_fragment(html.as_bytes()), None);
        assert_eq!(html_fragment(b""), None);
        assert_eq!(html_fragment(&[0u8; 16]), None);
    }

    #[test]
    fn offsets_out_of_range_are_clamped_or_refused() {
        let fragment = "<p>uno</p>";
        let data = cf_html("<html><body><!--StartFragment-->", fragment, "<!--EndFragment--></body></html>", None);
        let text = String::from_utf8(data.clone()).unwrap();
        let start = text.find(fragment).unwrap();
        let with = |sf: &str, ef: &str| {
            let mut t = text.clone();
            let field = |t: &mut String, key: &str, value: &str| {
                let at = t.find(key).unwrap() + key.len();
                let end = at + t[at..].find("\r\n").unwrap();
                t.replace_range(at..end, value);
            };
            field(&mut t, "StartFragment:", sf);
            field(&mut t, "EndFragment:", ef);
            t
        };
        // the header keeps its length when the numbers keep 10 digits
        let pad = |n: usize| format!("{n:010}");
        // an end past the data stops at its end
        let past = with(&pad(start), &pad(99_999_999));
        assert_eq!(html_fragment(past.as_bytes()).as_deref(), Some(&past[start..]));
        // a start past the data, or an end before the start: the whole HTML instead
        let whole = &text[text.find("<html>").unwrap()..];
        assert_eq!(html_fragment(with(&pad(99_999_999), &pad(99_999_999)).as_bytes()).as_deref(), Some(whole));
        assert_eq!(html_fragment(with(&pad(start + 5), &pad(start)).as_bytes()).as_deref(), Some(whole));
        // an empty fragment, too
        assert_eq!(html_fragment(with(&pad(start), &pad(start)).as_bytes()).as_deref(), Some(whole));
        // nothing usable anywhere: nothing
        let bad = with(&pad(99_999_999), &pad(1)).replace("StartHTML:", "StartHTML:9").replace("EndHTML:", "EndHTML:-");
        assert_eq!(html_fragment(bad.as_bytes()), None);
        // an offset in the middle of a character: U+FFFD, not a panic
        let mut accented = String::from_utf8(cf_html("<html><body>", "<p>è</p>", "</body></html>", None)).unwrap();
        let at = accented.find('è').unwrap();
        let k = accented.find("StartFragment:").unwrap() + "StartFragment:".len();
        accented.replace_range(k..k + 10, &pad(at + 1));
        assert_eq!(html_fragment(accented.as_bytes()).as_deref(), Some("\u{FFFD}</p>"));
    }

    #[test]
    fn bytes_that_are_not_utf8_become_replacement_characters() {
        let mut data = cf_html("<html><body>", "<p>caf?</p>", "</body></html>", None);
        // "café" in Windows-1252, where UTF-8 is expected: one byte for the é
        let q = data.iter().position(|&b| b == b'?').unwrap();
        data[q] = 0xE9;
        assert_eq!(html_fragment(&data).as_deref(), Some("<p>caf\u{FFFD}</p>"));
    }

    #[test]
    fn a_fragment_over_the_limit_is_left_out() {
        let big = format!("<p>{}</p>", "x".repeat(MAX_HTML));
        assert_eq!(html_fragment(&cf_html("<html><body>", &big, "</body></html>", None)), None);
        let fits = format!("<p>{}</p>", "x".repeat(MAX_HTML - 7));
        assert_eq!(html_fragment(&cf_html("<html><body>", &fits, "</body></html>", None)).map(|h| h.len()), Some(MAX_HTML));
    }

    /// Real "HTML Format" data saved to files (salva_appunti.py writes them as
    /// `<sample>\html.html`, header included), each cut as read_clipboard_text
    /// cuts it: `LEGGIMI_CF_HTML=<folder> cargo test --lib -- --ignored
    /// --nocapture saved_html`.
    #[test]
    #[ignore]
    fn cuts_saved_html_samples() {
        let root = std::path::PathBuf::from(std::env::var("LEGGIMI_CF_HTML").expect("LEGGIMI_CF_HTML: the samples' folder"));
        let mut samples: Vec<_> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.path().join("html.html")).filter(|p| p.is_file()).collect();
        samples.sort();
        for path in samples {
            let data = std::fs::read(&path).unwrap();
            let html = html_fragment(&data);
            let start: String = html.as_deref().unwrap_or("").chars().take(80).collect();
            println!("{}: {} bytes -> {:?} bytes, starting {start:?}", path.display(), data.len(), html.as_ref().map(|h| h.len()));
            assert!(html.is_some(), "{}", path.display());
        }
    }

    /// The real clipboard, only read (never written), and only what it holds
    /// told, not its text: `cargo test -- --ignored --nocapture clipboard`.
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn reads_the_real_clipboard() {
        match imp::read() {
            Ok(c) => println!(
                "clipboard: text {:?} UTF-16 units, image {}, html {:?} bytes",
                c.text.map(|t| t.encode_utf16().count()),
                c.image,
                c.html.map(|h| h.len())
            ),
            Err(e) => assert_eq!(e, BUSY),
        }
    }
}
