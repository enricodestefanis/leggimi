# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`,
where new features bump MINOR and fixes bump PATCH.

The running version is shown in the help dialog (`F1`) and on the empty screen.

## [2.0.0] - 2026-10-24

Tabs (*Schede*): several documents in one window, tabs that move between windows as in a
browser, and a title bar drawn in the colours of the theme.

### Added
- **Tabs**: every window holds several documents, a tab each, in the toolbar where the file
  name was. Each tab keeps its own place in the text, its edits (undo included), its Back and
  Forward history, find bar, outline filter and file-browser folder; coming back to a recent
  tab is instant, diagrams included.
- **Where a click opens**: a click opens in the tab in front; **Ctrl+click** or the middle
  button opens a new tab behind it, **Ctrl+Shift+click** a new tab in front, **Shift+click** a
  new window. This holds for the file browser, the recent files, the folder search and the links
  in a document; the right-click menus have **Open in a new tab** next to **Open in a new
  window**. A document already open in a tab of the window brings that tab forward.
- **Files opened from outside** (a double-click in File Explorer, `leggimi file.md`, Open with)
  arrive in a new tab of the window used last, or bring forward the tab that shows them; a
  start page in front becomes the document.
- **Ctrl+O** and files dropped on the window open a tab each; dropped on the tab strip, they go
  where they were let go.
- **Keys**: Ctrl+T new tab, Ctrl+W / Ctrl+F4 close the tab, Ctrl+Shift+T reopen the last
  closed tab (at the place it was read), Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PgDn / Ctrl+PgUp the
  next and previous tab, Ctrl+1…8 / Ctrl+9 a tab by its place, Ctrl+Shift+PgUp / PgDn move the
  tab, Ctrl+Shift+W close the window. The digits go by the key's place, so they work on AZERTY
  keyboards too; in the editor Ctrl+1–3 stay its heading commands.
- **Closing**: a tab with unsaved edits asks **Save / Don't save / Cancel**; closing the window
  asks once, naming the documents with unsaved edits. Closing the last document leaves the start
  page, and Ctrl+W on a lone start page closes the window.
- **Dragging tabs**: along the strip to reorder them (Esc puts one back), off the strip to give
  a tab a window of its own, onto another Leggimi window to move it there, unsaved edits and undo
  included. Dragging the only tab of a window carries the window, which can join another one.
- A card under the pointer shows a tab's folder and reading time; the ⌄ list shows every tab
  when they run over; a tab's right-click menu has New tab, Move to a new window, Copy path,
  Show in folder, Close, Close other tabs, Close tabs to the right and Reopen closed tab.
- **A title bar in the colours of the theme**: the toolbar is the title bar, with Minimize,
  Maximize and Close drawn by Leggimi. Drag its empty part to move the window, double-click it to
  maximize, and point at Maximize for the Windows 11 Snap layouts.
- A change of language brings every tab back after its reload, unsaved edits included.

### Changed
- The app's icon is on the start page and at the top of the help, since the title bar drawn by
  Leggimi no longer shows it.
- **Ctrl+W closes the tab**, not the window (Ctrl+Shift+W closes the window).
- **Ctrl+click and the middle button open a new tab**, not a new window; Shift+click opens a new
  window.
- **Keep on top** has no shortcut any more (Ctrl+Shift+T reopens a closed tab); its toolbar
  button stays.
- The file name, its dot of unsaved edits (and the check after Ctrl+S) and the reading time
  moved into the tab, the reading time on its card.
- In narrow windows Open and Help step out of the toolbar (Ctrl+O, F1 and the start page keep
  them), and below 560 px the + too (Ctrl+T, and the list of the tabs).

## [1.15.2] - 2026-10-22

### Fixed
- Microsoft Store version: **New → Markdown document** was missing from File Explorer's context
  menu. Windows drops a packaged app's New entry whose name is plain text; the package now
  carries its names as resources, so the entry appears, and the file type is named in the
  Windows language (*Documento Markdown*, *Markdown-Dokument*…) as with the installer.

## [1.15.1] - 2026-10-22

Finishing touches (*Rifiniture*): headings and links that behave as on GitHub, room for wide
tables and diagrams, a window that fits half a screen, the editor's keys in plain sight, and
contrast and keyboard access in every theme.

### Added
- **Wide tables and diagrams**: a table or a Mermaid diagram wider than the reading column
  widens up to the width of the window, centred, so it no longer needs sideways scrolling and
  the diagram's text is no longer shrunk. When printing or saving as PDF, a table wider than the
  page is scaled down to fit it.
- **Table buttons**: a small bar at the top right of every table, on hover or keyboard focus,
  with **Copy table (for Excel)** and **Open preview** (the expand icon). The right-click menu
  on a table has **Open preview** too.
- **Fit modes in the full-window preview**: **Fit** (key `0`), **Width** (key `W`, starting
  from the top; tables open this way) and **100%** (key `1`).
- **Landing highlight**: after a jump (the outline, a `#link`, the `.` / `,` heading keys, a
  `file.md#section` link, `leggimi file.md --line N`) the heading or block you land on lights
  up briefly. Back and Forward do not light it up.
- **Comment line** in the editor's Tools menu (Ctrl+/, which on Italian and German keyboards
  is Ctrl+Shift+7): wraps the lines in `<!-- -->`, so they are hidden when reading; inside a
  code block it uses that language's comment.
- While editing, a **double-click on the preview** puts the editor's cursor on that word, and
  the preview stays put. While reading, a double-click still selects a word.
- **New → Markdown document** in File Explorer creates an empty `.md` file. With the installer
  its name follows the Windows display language ("Documento Markdown" on an Italian Windows),
  and so does the name of the file type in Explorer's Type column; the Store version says
  "Markdown document".
- **Narrow windows fold their panes**: when the window gets narrow, the outline and then the
  file browser fold away by themselves; their toolbar buttons (and Ctrl+I / Ctrl+B) then open
  them over the text, closed by Esc, a click elsewhere or a pick. Below about 760 px, edit mode
  shows the editor alone; the preview comes back when the window is wider or when you go back to
  reading.
- **Saved**: after Ctrl+S the unsaved-changes dot next to the title turns into a small check
  for a moment, and screen readers hear "Saved".
- Addresses starting with `www.` become links, as on GitHub; file names such as `README.md`
  still stay text.
- **README logos** made for GitHub's themes: images marked `#gh-dark-mode-only` /
  `#gh-light-mode-only` show only in the matching theme, and the light and dark sources of a
  `<picture>` follow Leggimi's theme rather than Windows'. Printing and exports use the light
  one.
- The file browser is a real tree for the keyboard and screen readers: ↑ / ↓ move, → opens a
  folder or enters it, ← closes it or goes up, Home / End reach the ends, Enter or Space opens,
  Ctrl+Enter opens in a new window.
- The Store package declares its six languages, so the Store page lists English, Italian,
  German, French, Spanish and Chinese (Simplified).

### Changed
- **Heading anchors follow GitHub's rules**: "## 1. Introduzione" → `#1-introduzione`, "Q&A"
  → `#qa`, "What's new?" → `#whats-new`, accents kept ("Attività" → `#attività`). Tables of
  contents written for GitHub or by AI assistants now work when clicked, and **Copy link to
  this section** gives a link that also works on GitHub. Old anchors, and the reading positions
  remembered by older versions, still work.
- **In task lists only the checkbox ticks the task**: clicking or double-clicking the text (to
  select a word to copy, say) no longer changes the file.
- **Windows can be as narrow as 480 px** (was 700): Leggimi fits half a laptop screen next to
  Teams and works with the snap layouts of Windows 11.
- The **Edit** button shows the mode: a pencil while reading (*Edit (Ctrl+E)*), an open book
  while editing (*Back to reading (Ctrl+E)*). The editor fades in instead of snapping.
- **Rating** (Store version): **Rate** opens the Store's own rating dialog over Leggimi instead
  of switching to the Store app; if it cannot, the Store page opens as before. Once shown, the
  "Enjoying Leggimi?" card does not come back for 7 days.
- **Notices** have the icon that fits: success (PDF saved, task ticked), information (renamed,
  recovered draft, not a Markdown document), warning (not found, changed on disk) and error
  (save and export failures). Screen readers read them out.
- **Contrast**: text and controls reach WCAG AA in all four themes — the muted text, the
  accent used as text, primary buttons, code comments and callout titles in sepia, the hover of
  menu items in dark and black, the edges of menus and dialogs in black.
- **Keyboard**: the focus is visible everywhere (file browser, menus, copy buttons, the find
  bar); the **Aa** reading settings are reachable with Tab; the Share menu and the preview's
  copy menu work with the arrow keys, Home / End and Esc; toolbar buttons are named without
  their shortcut for screen readers.
- With Windows' **Animation effects** off, scrolls jump instead of gliding and the landing
  highlight does not animate.
- The **help (F1) and the keys overlay (?)** cover all of 1.15: Ctrl+F4, Ctrl+R, the mouse's
  side buttons and middle click, Shift+F10 or the menu key for the right-click menu, **Copy the
  whole document**, and the editor keys — Ctrl+D (next occurrence), Alt+L (select the line),
  Ctrl+Alt+↑ / ↓ (add a cursor), Ctrl+Alt+G (go to line), Ctrl+Shift+K (delete the line), Esc
  then Tab (leave the editor). The overlay writes the key names in the interface language
  (Strg, Maj, Mayús…).
- **Lighter start**: KaTeX (formulas), the DOCX exporter and the help pages load only when
  first needed (the script loaded at startup is half the size), and the first document of a
  window appears at once, without a fade-in on top of the window's own appearance: about 0.2 s
  sooner on screen.

### Fixed
- Ctrl+M switched Tab from indenting to moving the focus, with nothing on screen to say so. It
  no longer does: Tab always indents, and Esc then Tab leaves the editor (within 2 s; press Esc
  twice if text is selected or a panel or menu is open).
- **Go to line** (Ctrl+Alt+G) was hard to read in the dark and black themes.
- Re-opening the file being edited (a double-click in File Explorer, `leggimi file.md`, a pick
  in the file browser, a drop) replaced the preview with the version on disk and moved the
  "file changed on disk" check. Unsaved edits now stay; if the file changed on disk, the usual
  notice offers **Reload**.
- `leggimi missing.md`, or a jump-list entry whose file is gone, opened an empty window; now
  the window in front shows "Not found".
- Exports and rich-text copy show a task's ticked state right away.
- The "Enjoying Leggimi?" card could show in two windows at once, and a rating given from the
  help (F1) did not count.
- "Export failed" was not translated.
- A jump into a document that was just opened (a `file.md#section` link, a remembered reading
  place) landed 4 px off, measured during the document's entrance animation.
- A "Not found" or "changed on disk" notice stayed on screen after another document opened.
- A document could cover or imitate the app's interface: fixed-position elements are now kept
  inside the reading pane, and popover and command attributes are removed.
- With a long list of recent files in a short window, the top of the start screen ("No
  document open" and the Open button) was cut off, out of the scroll's reach. It now scrolls.

## [1.15.0] - 2026-10-20

More than one document at a time, a right-click menu that belongs to the app, Back and Forward
like a browser, and a file browser that keeps up with the disk.

### Added
- **More windows**: a file opened from outside while Leggimi runs (a double-click in File
  Explorer, *Open with*, `leggimi file.md`, the jump list) gets a window of its own; if it is
  already open, its window comes to the front, and a window still on the home is reused.
  Inside the app, Ctrl+click or the middle button on a file, a recent document, a search result
  or a link opens it in a new window, as does **Open in a new window** in the file menu;
  Ctrl+Shift+N opens an empty window. Several files picked together in the open dialog, or
  dropped together, open one per window. New windows cascade from the one they come from; text
  settings and the theme follow along in every open window.
- **Right-click menu of the document**: copy the selection (with its formatting or as plain
  text) or search for it in the document or the folder; open, copy or open in a new window a
  link; open an image or a diagram, copy a code block or a table; **copy a link to the
  section** (`[Heading](file.md#heading)`, which Leggimi follows from any other document);
  **edit from here** (the editor opens at that line); copy the whole document, print, save as
  PDF. It also opens from the keyboard (Shift+F10 or the menu key).
- Ctrl+F and Ctrl+Shift+F start from the text selected in the document.
- **Back and Forward**, as in a browser: Alt+← and Alt+→, the mouse's side buttons, or the
  first entries of the right-click menu go back to where you were before a link to a section, a
  click in the outline or a move to another document, and forward again. Each window keeps its
  own history.
- **Ctrl+W and Ctrl+F4 close the window**, asking first about unsaved edits; closing the last
  one ends the app.
- **The file browser keeps up with the disk**: files added, renamed or deleted in the folder
  (in File Explorer, by another program) show up at once, without losing the collapsed folders
  or the scroll position. A document renamed while open is followed, unsaved edits included;
  one deleted or moved away stays on screen, with a notice offering to save it again.
- **Video and audio** from the document's folder play (`<video>`, `<audio>`, with their
  `<source>` and subtitles), and images with `srcset` or `<picture>` (the light and dark logos
  of many GitHub READMEs) show.

### Changed
- **F5 and Ctrl+R reload the file** from disk and keep the reading position; with unsaved edits
  they do nothing. They used to reload the whole app, which closed the document.
- The right-click menu of WebView2 (Back, Refresh, Save as, Print, Share, Copy link to
  highlight) no longer appears: its entries acted on the app's own page, not on the document. It
  stays in text fields and in the editor, for the spelling suggestions and cut/copy/paste, and
  there too it loses what does not edit the text: More tools (Share), Print, Writing direction
  and Edge's Import passwords. The spelling suggestions stay.

- **Browser keys are off**: Ctrl+G and Ctrl+J opened Edge's own find bar and downloads panel
  inside the window, and F7 offered caret browsing; with the help or the preview open, Ctrl+F
  and Ctrl+P could reach Edge's find bar and print dialog. Leggimi's own shortcuts are unchanged.
- **Links to other files**: a link to an image opens it in the preview, to a folder in the
  file browser, and to any other file (a PDF, a spreadsheet) a notice offers to open it in its
  own app (programs and scripts are only shown in File Explorer). It used to show an English
  read error, or open a CSV or text file as if it were Markdown. `mailto:` and `tel:` links open
  the mail and phone apps instead of doing nothing.
- The text stays as typed: `README.md` or `main.rs` written in a sentence no longer becomes a
  web link (only real addresses do), and `(c)`, `(tm)`, `--` and `...` are no longer turned into
  ©, ™, – and …; quotes still curl.
- `Ctrl+A` while reading selects the document, not the whole window.
- The "unsaved changes" questions have their buttons in the app's language (Discard, Cancel)
  instead of Windows' Yes / No.
- **Spellcheck in the app's language**: WebView2's own parts (the spelling dictionary and its
  suggestions, the menu in text fields and the editor, the print preview) follow Leggimi's
  language instead of Windows' display language: Italian text on an English Windows is no
  longer all underlined. After a language change in the reading settings they follow from the
  next start.
- **Tags that change the page show as text**, as on GitHub: `<style>`, `<script>`, `<title>`,
  `<textarea>`, `<iframe>` and the like. A `<style>` block restyled the whole app, and a
  `<title>` or `<textarea>` named in a sentence hid or swallowed the rest of the document. An
  `<iframe>` (a YouTube embed) was never shown and now appears as its code. Other unknown tags
  (`<name>`) stay hidden, as on GitHub; the help says how to write them.

### Fixed
- The middle button did nothing on a recent file of the home; it opens it in a new window, as
  Ctrl+click does.
- A file renamed or deleted outside the app kept its old row in the file browser, and clicking
  it showed a raw "Cannot open … (os error 2)" in place of the document; now the browser
  updates, and a file that is gone gets a "Not found" notice while the document on screen stays.
- Headings named like a part of the app ("Toolbar", "App", "Find bar", "Read progress"…) took
  that part's styles: one vanished, others stuck to the top or filled the window, and some
  disappeared from print.
- Headings such as "Links", "Images", "Title", "Name" or "Timeline" had no anchor: they were
  missing from the outline and from `[TOC]`, and links to them went nowhere.
- Links to a heading with accented letters (`#attività`) did not scroll to it.
- A document could take the window out of the app: an HTML form, an image map or a link inside
  an SVG or a Mermaid diagram navigated it to the web page, and Leggimi was gone from that
  window. Now a window always stays on the app; web addresses open in the browser.

## [1.14.0] - 2026-10-15

The Italian release: the interface speaks six languages, and the app answers from the
command line.

### Added
- **Localized interface**: English, Italian, German, French, Spanish and Simplified Chinese,
  including the menus, the notices, the home screen, the keys overlay and the whole F1 help.
  The language is the first supported one in the Windows preferred languages (Settings >
  Time & language), as Windows promises for Store apps, even when the Windows display
  language is another; **Language** in the reading settings overrides it (the window
  reloads, keeping the open document).
- **Command line**: `leggimi file.md` opens a file and `--line 40` (or `-l 40`) opens it at
  that line, in the running window if there is one. The installer adds a `leggimi` command
  for terminals, the Store build registers it as an app execution alias.
- Relative paths on the command line are resolved against the shell's own folder, also when
  a Leggimi window is already open.

### Changed
- Dates and numbers follow the interface language (reading time, recent files, the date in
  the print header).
- Exported HTML carries the interface language in its `lang` attribute.

### Fixed
- Mermaid edge labels in the dark and black themes sat on light grey boxes (mermaid's own
  dark palette); they now take the page background.

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
