# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`,
where new features bump MINOR and fixes bump PATCH.

The running version is shown in the help dialog (`F1`) and on the empty screen.

## [1.13.0] - 2026-10-15

The print release.

### Added
- **Save as PDF** in the Share menu: the document is written straight to a PDF through
  WebView2's own printer, with the same paper layout as printing. No print dialog, only the
  file picker; the notice afterwards opens the folder.
- Printed pages (and the PDF) carry a **header** with the document title (the first
  heading, or the file name) and the date, and a **footer** with "page / pages".
- **New page at every heading 1**: an option in the Share menu, remembered, for printing
  and the PDF.
- A paragraph that is just **`[TOC]`** renders as a table of contents of the headings that
  follow it, as nested links; it is part of the document, so it is printed and exported too.

### Changed
- Printing from a dark theme now re-renders the diagrams in the light palette for paper;
  before, only the page chrome switched.
- The Share menu's print entry is now **Print…** (the system dialog) next to the new
  **Save as PDF**.

## [1.12.0] - 2026-10-15

The editor release: the things that make the editor safe to live in.

### Added
- **Find & replace** in the editor (`Ctrl+F` / `Ctrl+H`, `F3` / `Shift+F3` to step, match
  case, regexp and whole-word options). While reading, `Ctrl+F` still opens the document
  find bar.
- **Spellcheck** with the Windows dictionary, on by default; toggle it from the new
  **Tools** menu of the format bar.
- Line commands with their shortcuts: move the line up / down (`Alt+↑` / `Alt+↓`),
  duplicate (`Shift+Alt+↓`) and delete (`Ctrl+Shift+K`), also in the Tools menu.
- **Recovery draft**: while the buffer has unsaved changes a copy is kept aside; after a
  crash or a forced close, opening the file again offers to restore it. The file is never
  written without you.
- **Live task lists**: clicking a checkbox in the preview updates the `[ ]` / `[x]` in the
  source. While reading it writes the file at once and the notice offers *Undo*; while
  editing it changes the buffer, to be saved with `Ctrl+S`.
- **Copy a table** for Excel or Google Sheets: a button on hover puts it on the clipboard as
  tab-separated text.
- The full-window preview's copy button is now a menu: PNG (2×) or large PNG (4×), and
  for diagrams **SVG**; each can also be **saved to a file**.
- `Ctrl+C` on a selection copies it with its formatting (the same Word-friendly HTML as the
  Share copy) together with the plain text.
- **Smart links** between documents: `[text](other)` finds `other.md`, `[text](folder/)`
  opens the folder's `index.md` or `README.md`, and `other.md#section` jumps to that
  heading in the other file. A link that resolves to nothing says so.
- Right-click a file in the browser panel, or the file name in the toolbar: **Show in File
  Explorer**, **Copy path**, **Copy as Markdown link** (relative to the open document).
- **Keep on top**: a pin button in the toolbar (`Ctrl+Shift+T`).
- **Drag to scroll** like a PDF reader: the middle mouse button anywhere, the left button
  on the empty space beside the text.
- **Portable build**: `Leggimi_x.y.z_x64-portable.zip` on GitHub Releases. With the
  `leggimi-portable.txt` marker next to the exe, settings, recent files and reading
  positions live in a `data` folder beside it, and the copy never interferes with an
  installed Leggimi.

## [1.11.0] - 2026-10-15

The reading release: everything here shortens the "open, read, close" loop.

### Added
- **Reading position remembered per file**: a document opens where you stopped reading
  the last time, anchored to the nearest heading so it survives edits above it. Scrolling
  back to the top forgets the position.
- **Recent files on the empty screen**: with no document open, the window lists the files
  you opened recently (name, folder, when) and three tips; click one to reopen it. Files
  that no longer exist are dropped, and **Clear** empties the list.
- **Reading keys** while a document is open and nothing else has the keyboard: `j` / `k`
  scroll, `.` / `,` jump to the next / previous heading, `g g` and `G` go to the top and
  the end, `n` / `N` step through the find bar's matches, and `?` opens a quick reference
  of all the keys (`F1` keeps the full help).
- **Outline filter**: on documents with eight or more headings a box above the outline
  narrows it as you type; `↑` / `↓` and `Enter` jump to an entry, `Esc` clears it.
- A **reading progress** hairline along the top of the document and the **estimated
  reading time** next to the file name (word count in its tooltip).
- **Footnotes** (`[^1]` in the text, `[^1]: …` anywhere), collected at the end of the
  document with links there and back.
- **YAML front matter** is folded into a *Front matter* block at the top instead of being
  rendered as text; click it to see the fields as a table (lists become chips). It is
  left out of printouts, rich-text copies and DOCX exports.
- Two more themes in the reading settings: **Sepia** (warm paper) and **Black** (true black
  for OLED screens). Code, callouts and diagrams follow the light or dark side of the
  theme in use.
- The Store build asks once for a rating, politely: a small card at the bottom of the
  document after a few days and a handful of documents, with *Later* (asks again in a
  month) and *No thanks* (never again).

### Changed
- Saving over a file that changed on disk since it was opened now asks before
  overwriting it, instead of silently replacing the other program's changes. The check
  is on the file's modification time, so it also covers changes the watcher missed.
- Opening the same file again (a second double-click in File Explorer) keeps the place
  being read instead of jumping to the top.

### Fixed
- The reading position kept across a live reload or a text-size change was restored on
  the wrong side of the window: the nearest heading above the top edge came back the same
  distance *below* it, so the document jumped by twice that distance. Found while testing
  the remembered position, which uses the same anchor.

## [1.10.0] - 2026-10-14

### Added
- Click a diagram or an image to open it full-window: `+` / `-` or the scroll wheel zoom
  around the pointer, dragging pans, `0` fits it to the window and `Esc` closes. Diagrams
  scale to fill the window and stay sharp at any zoom, and a button copies what you are
  looking at as an image. Reachable from the keyboard too: `Tab` to a diagram, `Enter` to
  open it.
- Both side panels can be widened by dragging their inner edge — the current widths are
  the minimum. Double-click an edge to restore the default; the arrow keys resize it from
  the keyboard. The widths are remembered, and are reduced only while the window is too
  narrow to honour them.
- A **Panels** setting in the reading popover sizes the text of the file browser and the
  outline, independently of the document text. `Ctrl`+scroll wheel over a panel changes
  that panel instead of the document.

### Fixed
- The Store build showed the app icon on a blue square in the taskbar: the package had no
  unplated icon variants, so Windows plated the logo on the system accent colour. The
  qualified `targetsize` / `altform-unplated` assets are now generated and shipped, which
  also sharpens the Start, Alt+Tab and Explorer file icons.
- An image whose file is missing is now shown as such instead of as an invisible gap.

## [1.9.0] - 2026-10-01

### Added
- A format bar above the editor: text style (normal, heading 1–3), bold, italic,
  strikethrough, inline code, link, bulleted, numbered and task lists, quote, and an
  Insert menu. Buttons light up for the formats under the cursor.
- A `/` menu at the start of a line inserts blocks by name: table, Mermaid diagram,
  KaTeX formula, code block, note/tip/warning callouts, divider, headings and lists.
- Editing shortcuts: `Ctrl+B` bold, `Ctrl+I` italic, `Ctrl+Shift+X` strikethrough,
  `Ctrl+Shift+M` inline code, `Ctrl+K` link, `Ctrl+1`–`3` headings. Every format toggles,
  and with no selection it applies to the word under the cursor.

### Changed
- `Ctrl+B` and `Ctrl+I` format text while the cursor is in the editor; elsewhere they
  still toggle the file browser and the outline.
- The editor can scroll past the last line, so the preview can follow it all the way to
  the end of the document.

### Fixed
- The live preview keeps what you are editing in view while you type or move the cursor
  (click, arrow keys, selection): the whole table, formula, diagram or list when it fits,
  otherwise the part holding the cursor. Before, text near the end of a file could stay
  hidden below the preview's bottom edge.
- Scroll sync now knows where display formulas (`$$` blocks and ```` ```math ```` fences)
  and raw HTML blocks sit in the preview; before, it could only guess.
- With the editor scrolled to the very top, the preview now starts at the very top too.
- A selection inside the current line was invisible in the editor: the highlight of the
  active line covered it.
- Task lists: a plain item in the same list as a checklist lost its bullet, and a long
  checklist item wrapped back to the page edge instead of lining up with its text.
- `Ctrl+S` in the editor no longer triggers the save twice.

## [1.8.3] - 2026-09-28

### Added
- More Markdown extensions are recognized everywhere (file associations, Open dialog, file
  browser, folder search and links): `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.markdn`, `.mdtxt`.
- The Microsoft Store build shows a "Rate on the Store" card in the help dialog (`F1`).
  The GitHub build is unchanged.

## [1.8.2] - 2026-09-14

### Added
- Microsoft Store packaging: an MSIX manifest, Store tile assets and `npm run package:msix`,
  which builds the release exe and packages it with Microsoft's winapp CLI.
- A privacy policy (`PRIVACY.md`): Leggimi never connects to the internet and collects no data.
- If the WebView2 Runtime is missing, the app now explains it and opens the download page
  instead of failing silently.

## [1.8.1] - 2026-09-14

### Added
- The project is now released under the MIT License (`LICENSE` file, manifests, README
  and the help dialog).

### Fixed
- **Outline highlight at the end of the document**: short trailing sections could
  never become the active entry, because the scroll-spy only activated a heading
  once it reached the top of the pane. The activation line now slides down over
  the last viewport of scroll, so every entry gets its turn and the last one is
  active at the bottom. A clicked entry is highlighted immediately and stays so
  until you scroll again yourself; the active entry is also kept in view inside
  the outline panel.

## [1.8.0] - 2026-08-04

### Added
- **Reading settings**: a new `Aa` toolbar button opens a popover with text size
  (eight steps, 13–22 px), sans or serif font, line spacing (compact / normal /
  relaxed) and column width (narrow / normal / wide / full). Everything is
  remembered across restarts and the defaults reproduce the previous look exactly.
- Text-size shortcuts: `Ctrl+=` / `Ctrl+−` step the size, `Ctrl+0` resets it, and
  `Ctrl`+scroll wheel works over the document and the editor. The reading position
  is preserved while the text reflows.
- The editor text scales with the chosen reading size (keeping its 14:16 ratio to
  the document).

### Changed
- **Toolbar consolidated from 9 to 6 buttons**: Copy as rich text and Print moved
  into the Export menu, which is now the **Share** menu (`Ctrl+Shift+E`); the theme
  button became a Light / Dark / Auto control inside the `Aa` popover.
- Printing and exports always use the standard text layout, whatever reading
  settings are active.

### Fixed
- Readability: article links are now always underlined (subtle terracotta
  underline, full strength on hover) and their light-theme color is darkened
  to meet WCAG AA contrast (4.0:1 → 5.4:1); inline code chips get a clearly
  visible background and a crisper border in both themes, with full-strength
  text even inside blockquotes. Rich-text copy, HTML and DOCX export match.

## [1.7.1] - 2026-08-03

### Changed
- **Rich-text copy rebuilt**: the clipboard now carries fully inline-styled HTML, so
  pasting into Word, Outlook, Gmail, Google Docs or Teams keeps the document's look —
  syntax-colored code in a shaded box with a language label, bordered tables with a
  tinted header row, terracotta links and blockquotes, tinted alert callouts and
  ☑/☐ task lists. Formulas travel as MathML only (native, editable Word equations —
  no more doubled math) and Mermaid diagrams as crisp PNGs. Output is always
  light-themed, whatever the app theme. In Word, paste with
  "Keep Source Formatting" to get the full styling.
- Pasting into a plain-text editor (Notepad, VS Code…) now yields the original
  markdown source instead of flattened text.

### Fixed
- Copying or exporting DOCX from dark theme produced unreadable Mermaid PNGs
  (light strokes on a white page): diagrams now briefly re-render on the neutral
  theme for the snapshot, then switch back.

## [1.7.0] - 2026-08-03

### Added
- **Three-state theme**: the toolbar button now cycles light → dark → follow Windows.
  In "follow Windows" the app tracks the system light/dark setting live, including
  re-rendering Mermaid diagrams. The button icon shows what the next click switches to.
- **Windows Recent & jump list**: every file opened is registered with
  `SHAddToRecentDocs`, so it appears in Windows' Recent items and in the app's
  taskbar jump list.

### Changed
- **New app icon** for the Leggimi identity: a white page with a folded corner,
  a markdown `#` heading and text lines on the terracotta accent.

### Fixed
- Exported HTML/DOCX and rich-text copy now embed local images correctly: asset-protocol
  URLs (`http://asset.localhost`) were mistaken for web URLs and left un-inlined, and the
  production CSP did not allow fetching them.
- DOCX export, which Word renders through its limited HTML filter: task lists no longer
  degrade to plain bullets (☑/☐ symbols now), alert callouts keep their per-type color
  and get a text icon instead of the dropped SVG, and relative links to other files
  (e.g. `nested/deeper.md`) become working `file:///` links. The link fix applies to
  HTML export and rich-text copy too. Export menu now also on `Ctrl+Shift+E`.

### Notes
- The `.md`/`.markdown` file association and "Open with" were already registered by
  the installer since 0.1.0. Mica/acrylic window effects were evaluated and skipped:
  the app draws an opaque themed background, so they would not be visible.

## [1.6.0] - 2026-08-03

### Added
- **DOCX export**: the export button now opens a small menu with HTML and DOCX. The
  Word document carries KaTeX math as MathML (Word converts it to native equations)
  and Mermaid diagrams as PNG images; local images are embedded. Optimized for
  Microsoft Word — other editors may not open the format faithfully.

## [1.5.0] - 2026-08-03

### Added
- **Images into the editor**: pasting a screenshot saves it as
  `assets/pasted-<timestamp>.png` next to the document; dropping an image file copies
  it into `assets/` under its own name (uniquified if taken). Both insert a
  relative-path `![]()` link at the cursor and the live preview picks it up
  immediately.

## [1.4.0] - 2026-08-03

### Added
- **Search across the folder** (`Ctrl+Shift+F` or the box above the file tree): full-text
  and file-name search over every Markdown file under the current root, with the same
  depth and skip rules as the tree. Results show the file and a match snippet; opening
  one carries the query into the document's find bar so the term is highlighted in place.
  `Esc` clears the search and brings the tree back.

## [1.3.0] - 2026-08-03

### Added
- **Copy as rich text** (`Ctrl+Shift+C` or the clipboard button): the rendered document
  goes on the clipboard as formatted HTML plus a plain-text fallback, ready for Outlook,
  Word or Teams. Local images are embedded as data URIs.
- **Print / save as PDF** (`Ctrl+P` or the printer button): prints only the article with
  a paper-oriented stylesheet — panes and toolbar hidden, page margins, no clipped code or
  tables, light theme forced around the native dialog.
- **Export as HTML** (download button): writes a single self-contained `.html` file with
  styles and local images embedded, rendered like the in-app preview.

## [1.2.0] - 2026-08-03

### Added
- **KaTeX math rendering**, bundled for offline use: `$…$` inline, `$$…$$` or a
  ` ```math ` fence for display blocks. Long formulas scroll sideways instead of
  breaking the reading column.
- **GitHub-style alert callouts** (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
  `[!WARNING]`, `[!CAUTION]`) with the GitHub palette in both themes.

## [1.1.0] - 2026-08-03

### Changed
- The app is now **Leggimi** — Italian for "read me". "Markdown Studio" collides with an
  existing app on the Microsoft Store, so the name changed ahead of Store publishing.
- The installer identifier changed to `com.enrico.leggimi`: a previous "Markdown Studio"
  install is treated as a different app and must be uninstalled manually.

## [1.0.2] - 2026-08-03

### Fixed
- The file browser remembers which folders you collapsed. Selecting a file used to
  rebuild the whole tree fully expanded; now the collapse state survives file
  selection, watcher reloads and app restarts, and selecting a file in the same
  root just moves the highlight without rebuilding. Folders on the path of a newly
  selected file still auto-expand to reveal it.

## [1.0.1] - 2026-07-31

### Added
- Scroll sync in edit mode: scrolling the editor keeps the preview aligned with the
  visible source lines (one-way — scrolling the preview by hand stays free until the
  editor moves again). Entering edit mode opens the editor at the section being read,
  with the caret placed there.

### Fixed
- Hiding the file browser and/or the outline no longer pushes the reading column to
  the left: each pane now has an explicit grid column, so the content stays centered
  in any combination of open panels.

## [1.0.0] - 2026-07-30

### Added
- **Edit mode** (`Ctrl+E` or the pencil button): CodeMirror 6 editor on the left, live preview
  on the right, updated ~200 ms after you stop typing. Documents still always open in viewer mode.
- Explicit save with `Ctrl+S` or the save button; an orange dot next to the file name (and a `•`
  in the window title) marks unsaved changes.
- Confirmation guards against losing unsaved changes when leaving edit mode, opening another
  document (from any entry point) or closing the window.
- If the open file changes on disk while the buffer has unsaved edits, a warning bar with a
  Reload action appears instead of overwriting the buffer; without unsaved edits the editor
  follows the disk as before.
- Error-safe preview: if a render fails mid-edit the last good preview stays on screen with a
  dismissable notice — the pane never goes blank. Unchanged Mermaid diagrams are reused between
  preview refreshes so they don't flicker while typing.
- UI polish: entrance animations for the help dialog, find bar and documents; theme toggle
  cross-fade; animated folder collapse in the file browser; visible keyboard-focus outlines;
  toolbar group separators. All animations respect the system reduced-motion setting.

### Changed
- The app is now **Markdown Studio** — it is no longer read-only. The installer identifier is
  unchanged, so it upgrades existing installs in place.
- Saved files keep their original line endings (CRLF or LF); a UTF-8 BOM, stripped when the
  file is read, is not re-added on save.

## [0.2.0] - 2026-07-30

### Added
- Built-in help dialog covering navigation, shortcuts and rendering, opened with `F1`
  or the toolbar button.
- Up button in the file browser to move the browse root to the parent folder.
- `Ctrl+I` toggles the outline panel.
- Version indicator in the help dialog and on the empty screen.

### Fixed
- The file browser no longer re-roots on the folder of every document opened. Opening a
  file from a subfolder used to hide the rest of the tree with no way back; the browse
  root now survives navigation within itself.
- Listing a drive root no longer fails, and Windows system folders are skipped when
  walking upwards.
- The empty screen no longer showed through below short documents: its `display: flex`
  rule outranked the `hidden` attribute.
- The fallback for an invalid Mermaid diagram is now styled like any other code block.

### Changed
- The interface, documentation and sample documents are now in English.
- Sample documents replaced; `samples/nested/deeper.md` covers folder navigation.

## [0.1.0] - 2026-07-29

### Added
- First release: read-only Markdown viewer built with Tauri 2.
- GitHub-flavored Markdown, syntax highlighting with a copy button, Mermaid diagrams
  bundled for offline use.
- Outline with scroll-spy, file browser, live reload preserving the reading position.
- Find in document, light/dark theme, relative images.
- `.md` file association through the NSIS installer, single instance, drag and drop.
