// What a document may reach by naming it: files on its own drive or share, and never the app's
// own protocols.
//
// Windows calls the computer a network path names as soon as the path is looked up. A document
// that could name one ("//server/share/a.png" as an image, a video, a link) would choose whom
// the PC contacts when it is opened. The Rust commands decide (doc_target in commands.rs); the
// page asks nothing it knows will be refused.

// "\\server\share\…" or "//server/share/…", whatever the slashes; also "\\.\pipe\…" and "\\?\…"
const isNetworkPath = (path: string): boolean => /^[\\/]{2}/.test(path);

// the "\\server\share" a path is on, in one spelling; null on a drive
function shareOf(path: string): string | null {
  const m = /^[\\/]{2}(?:\?[\\/]UNC[\\/])?([^\\/]+)[\\/]+([^\\/]+)/i.exec(path);
  return m ? `\\\\${m[1]}\\${m[2]}`.toLowerCase() : null;
}

// May a document in the folder `dir` name the path `rel`? Not one on another computer, unless
// the document is on that very share.
export function reachable(dir: string, rel: string): boolean {
  if (!isNetworkPath(rel)) return true;
  const share = shareOf(rel);
  return share !== null && share === shareOf(dir);
}

// An address as the browser would read it, for a search: CSS escapes and percent escapes
// undone, compatibility forms folded (full-width letters, ideographic stops), and without the
// spaces, tabs, line ends and invisible characters a URL loses on its way.
function plain(value: string): string {
  let out = value.replace(/\\([0-9a-f]{1,6})[ \t\r\n\f]?|\\([\s\S])/gi, (_m, hex: string | undefined, ch: string) => {
    if (!hex) return ch;
    const code = parseInt(hex, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
  });
  out = out.replace(/%([0-9a-f]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return out
    .normalize("NFKC")
    .replace(/[\u3002\uff61]/g, ".")
    .replace(/[\s\u0000-\u001f\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
    .toLowerCase();
}

// The asset protocol serves the files of the document's folder, and only the renderer writes
// its addresses, for files it has resolved there. One written in the text (as an image, in a
// style, in a diagram's CSS) would have the protocol look up whatever path it holds.
const APP_PROTOCOL = /asset\.localhost|(?:^|[^a-z0-9_-])asset:/;
export const namesAppProtocol = (value: string): boolean => APP_PROTOCOL.test(plain(value));

// For a diagram's text, which Mermaid lays out in the live page before any sanitizer sees its
// SVG. The host only: "asset:" alone is a word a diagram may well have in a label.
export const namesAssetHost = (value: string): boolean => /asset\.localhost/.test(plain(value));

// attributes that are read or shown, never loaded
const TEXT_ATTRS = new Set(["alt", "title", "id", "class", "lang", "dir", "name", "datetime"]);

// Called by the sanitizer on every element it keeps, before the markup reaches a document
// that loads things: takes away each attribute that names the app's protocol. A link's own
// address stays: it loads nothing, and a click on it goes to the browser.
export function dropAppProtocol(el: Element): void {
  const link = el.localName === "a" || el.localName === "area";
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (TEXT_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-")) continue;
    if (link && (name === "href" || name === "xlink:href")) continue;
    if (!namesAppProtocol(attr.value)) continue;
    // a picture says what it was, as one whose file is not there
    if (name === "src" && el.localName === "img" && !el.getAttribute("alt")) el.setAttribute("alt", attr.value);
    el.removeAttributeNode(attr);
  }
}
