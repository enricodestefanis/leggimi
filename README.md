<p align="center">
  <img alt="Leggimi icon" src="docs/icon.png" width="120" />
</p>

# Leggimi

<p align="center">
  <a href="https://apps.microsoft.com/detail/9PG51TBZ2CB1?cid=github-badge&mode=direct"><img alt="Microsoft Store" src="https://img.shields.io/badge/Microsoft_Store-Leggimi-0078D4?logo=windows&logoColor=white" /></a>
  <a href="https://github.com/enricodestefanis/leggimi/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/enricodestefanis/leggimi?label=release&color=2ea44f" /></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-blue" /></a>
  <img alt="Windows 10 / 11" src="https://img.shields.io/badge/platform-Windows_10%2F11-lightgrey" />
  <a href="PRIVACY.md"><img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-success" /></a>
</p>

*Leggimi* — Italian for "read me" — is a fast Markdown viewer and editor for Windows, built with
Tauri 2. Double-click a `.md` file and it opens in a clean, centered reading column, where you
left it, with light, sepia, dark and black themes; an optional edit mode adds a split view with a
live preview. Files are only modified when you save explicitly. The interface speaks English,
Italian, German, French, Spanish and Simplified Chinese.

<p align="center">
  <img alt="Leggimi — reading view with the file browser, the outline, a callout and a table" src="docs/screenshot-viewer.png" width="49%" />
  <img alt="Leggimi — edit mode with find &amp; replace, the format bar and the live preview" src="docs/screenshot-editor.png" width="49%" />
</p>

<p align="center">
  <img alt="Leggimi in under a minute: a recent file reopens where it was left, the reading keys and the ? overlay, the dark theme, the view following a change on disk, find &amp; replace in the editor, a diagram full-window, the interface switching to Italian" src="docs/trailer.gif" width="98%" />
</p>

## Install

<p align="center">
  <a href="https://apps.microsoft.com/detail/9PG51TBZ2CB1?referrer=appbadge&cid=github-button&mode=direct">
    <img alt="Get it from Microsoft Store" src="https://get.microsoft.com/images/en-us%20dark.svg" width="200" />
  </a>
</p>

- **Microsoft Store** (recommended): install from the [Store page](https://apps.microsoft.com/detail/9PG51TBZ2CB1?cid=github-readme&mode=direct);
  updates arrive automatically.
- **winget**: the same Store package from the command line:

  ```powershell
  winget install --id 9PG51TBZ2CB1 --source msstore
  ```
- **Direct download**: the NSIS installer (`Leggimi_x.y.z_x64-setup.exe`) is attached to every
  [GitHub release](https://github.com/enricodestefanis/leggimi/releases/latest). It is not
  code-signed, so SmartScreen may ask you to confirm on first run.
- **Portable**: `Leggimi_x.y.z_x64-portable.zip` on the same releases page; see below.

All three are the same app, free, with no accounts, no ads and no telemetry.

### Portable build

The portable zip is for a USB stick, a projects folder, or a work PC where you cannot install
anything. It is published only on GitHub Releases (the Store distributes the MSIX package).

- **Use it**: unzip anywhere you can write to and run `Leggimi.exe`. Nothing is installed: no
  file association, no Start menu entry, no `leggimi` command. Open files with `Ctrl+O`, by
  dropping them on the window, from the file browser, or from a terminal by path:
  `Leggimi.exe path\to\file.md --line 40`.
- **Where things live**: the `leggimi-portable.txt` marker next to the exe makes the app keep
  its settings, recent files, reading positions and recovery drafts in a `data` folder beside
  it, instead of the user profile. Move or copy the whole folder and everything travels with it.
  Delete the marker to use the per-user location like the installed app.
- **Side by side**: the portable copy has its own instance identity, so it runs next to an
  installed Leggimi without stealing its files or settings.
- **Update**: unzip the new version over the old folder (or replace `Leggimi.exe`); `data` is
  kept. There is no automatic update.
- **SmartScreen**: like the installer, the exe is not code-signed; on the first run Windows may
  ask you to confirm (More info → Run anyway).

## Features

- Documents always open in **viewer mode**; `Ctrl+E` switches to **edit mode**: CodeMirror
  editor on the left, live preview on the right, updated as you type
- Explicit save with `Ctrl+S`, unsaved-changes indicator and confirmation guards; line endings
  (CRLF/LF) are preserved on save
- If a preview render fails mid-edit, the last good preview stays on screen and a dismissable
  notice appears — the pane never goes blank
- **Formatting help in edit mode**: a format bar (headings, bold, italic, strikethrough, code,
  links, lists, task lists, quotes), the usual shortcuts, and a **`/` menu** at the start of a
  line that inserts tables, Mermaid diagrams, KaTeX formulas, code blocks and callouts. The file
  stays plain Markdown — every command just edits the text
- **Find & replace** (`Ctrl+F` / `Ctrl+H`), **spellcheck** with the Windows dictionary, line
  commands (`Alt+↑` / `Alt+↓` move, `Shift+Alt+↓` duplicate, `Ctrl+Shift+K` delete), and a
  **recovery draft** that offers your unsaved text back after a crash
- **Paste or drop images in edit mode**: they are saved to an `assets/` folder next to the
  document and linked with a relative path, Typora-style
- GitHub-flavored Markdown: tables, task lists, strikethrough, autolinks, **footnotes**;
  task-list checkboxes are **live** (a click updates the file, with Undo), tables have a
  **copy for Excel** button, and `Ctrl+C` copies a selection with its formatting
- **YAML front matter** folded into a block at the top of the document: click it to see the
  fields as a table, instead of reading them as stray text
- Syntax-highlighted code blocks with a copy button
- **Mermaid** diagrams, bundled locally so they work offline
- **Full-window preview** for diagrams and images: click one to open it, zoom with `+` / `−` or
  the scroll wheel around the pointer, drag to pan, `0` to fit, `Esc` to close — and a menu to
  copy it as PNG (2× or 4×) or SVG, or save it to a file. Diagrams fill the window and stay
  sharp at any zoom
- **KaTeX math**: `$…$` inline, `$$…$$` or ` ```math ` fences for display blocks
- **GitHub-style callouts**: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`, `[!CAUTION]`
- Clickable **outline** with scroll-spy, and a **filter box** on long documents (type, then
  `↑` / `↓` and `Enter` to jump)
- **Picks up where you left off**: every document remembers its reading position, and the
  empty screen lists your **recent files**
- **Reading keys**: `j` / `k` scroll, `.` / `,` jump between headings, `g g` / `G` go to the
  top and the end, `n` / `N` step through find matches, `?` shows the quick reference. A
  hairline along the top of the document shows the progress and the toolbar the estimated
  reading time; the document can also be dragged like a sheet of paper (middle button)
- **Smart links**: `[text](other)` finds `other.md`, `[text](folder/)` opens the folder's
  `index.md` or `README.md`, `other.md#section` jumps to the heading
- Right-click a file for **Show in File Explorer**, **Copy path** and **Copy as Markdown
  link**; a **pin** button (`Ctrl+Shift+T`) keeps the window on top
- **File browser** for the Markdown files in the folder you opened; collapsed folders are
  remembered across navigation and restarts
- **Resizable side panels**: drag the inner edge of the file browser or the outline to widen it
  (double-click to restore the default), and size their text independently of the document with
  **Panels** in the reading settings
- **Search across the folder** (`Ctrl+Shift+F`): full-text and file-name matches with
  snippets; opening a result highlights the term in the document
- **Live reload** when the file changes on disk, preserving your reading position; with unsaved
  edits it warns instead of overwriting your buffer, and saving over a file that changed since
  you opened it asks first
- **Share menu** (`Ctrl+Shift+E`) collecting everything that leaves the app: **copy as rich
  text** (`Ctrl+Shift+C`) to paste with formatting into Outlook, Word or Teams; **print**
  (`Ctrl+P`) and **one-click Save as PDF**, both with a header (title, date) and page numbers
  and an optional page break at every heading 1; **export to self-contained HTML or DOCX** —
  in Word, math becomes native equations and Mermaid diagrams become images
- A paragraph that is just `[TOC]` renders as a table of contents of the headings below it
- **Reading settings** (the `Aa` button): text size (`Ctrl+=` / `Ctrl+−` / `Ctrl+0` /
  `Ctrl`+scroll), sans or serif font, line spacing, column width and the **light / sepia /
  dark / black / follow Windows** theme — all remembered across restarts, never affecting
  print or export;
  the editor text scales along with the size, and **Panels** sizes the side panels
- Find in document (`Ctrl+F`), relative images
- Opened files land in Windows' **Recent items and the taskbar jump list**
- Double-click any `.md` file in File Explorer — the installer registers the association
- Single instance: further files open in the existing window
- Drag and drop files onto the window, or press `Ctrl+O`
- Built-in help (`F1`) showing the running version
- **Six languages**: English, Italian, German, French, Spanish and Simplified Chinese — the
  interface and the help follow the first supported language in your Windows preferred
  languages, with an override in the reading settings
- **Command line**: `leggimi file.md --line 40` opens a file at a line, in the running window
  if there is one; the installer adds the `leggimi` command for terminals

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+O` | Open a file |
| `Ctrl+E` | Toggle edit mode |
| `Ctrl+S` | Save the file (edit mode) |
| `Ctrl+F` | Find in document |
| `Ctrl+Shift+F` | Search across the folder |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Ctrl+B` | Toggle the file browser (bold while editing) |
| `Ctrl+I` | Toggle the outline (italic while editing) |
| `Ctrl+Shift+X` / `Ctrl+Shift+M` | Strikethrough / inline code (editing) |
| `Ctrl+K` | Insert a link (editing) |
| `Ctrl+1` … `Ctrl+3` | Heading 1 to 3 (editing) |
| `Ctrl+F` / `Ctrl+H` | Find / find and replace (editing) |
| `Alt+↑` / `Alt+↓` | Move the line (editing) |
| `Shift+Alt+↓` / `Ctrl+Shift+K` | Duplicate / delete the line (editing) |
| `Ctrl+Shift+T` | Keep the window on top |
| `/` | Block menu at the start of a line (editing) |
| `Ctrl+P` | Print or save as PDF |
| `Ctrl+Shift+C` | Copy the document as rich text |
| `Ctrl+Shift+E` | Open the Share menu |
| `Ctrl+=` / `Ctrl+−` | Larger / smaller text |
| `Ctrl+0` | Reset the text size |
| `j` / `k` | Scroll down / up (reading) |
| `.` / `,` | Next / previous heading (reading) |
| `g g` / `G` | Top / end of the document (reading) |
| `n` / `N` | Next / previous find match (reading) |
| `?` | Quick reference of the keys |
| `F1` | Show help |
| `Esc` | Close the preview, the find bar or help |

## Command line

```
leggimi [file] [--line N]
```

`leggimi README.md` opens the file (relative to the current folder) in the running window, or
starts the app. `--line 40` (or `-l 40`) shows that source line at the top: in reading mode the
block containing it, in edit mode the editor caret. The installer puts a `leggimi` command in
`%LOCALAPPDATA%\Microsoft\WindowsApps`, which is on every user's PATH; the Store build registers
`leggimi.exe` as an app execution alias; the portable build is run by its own path.

## File browser

The left panel is rooted at the folder of the document you opened and lists Markdown files up to
four levels of subfolders (capped at 2000 files). Opening a file from the panel keeps the same
root, so navigating into a subfolder does not hide the rest of the tree; the up arrow moves the
root to the parent folder. Opening a document outside the current root re-roots the panel there.
Folders you collapse stay collapsed while you navigate and across restarts; the folders on the
path of a newly selected file auto-expand to reveal it. Folders with no Markdown files are
hidden, as are hidden folders and build directories such as `node_modules`, `target` and `dist`.

## Versioning and releases

`package.json` is the single source of truth for the app version: `tauri.conf.json` reads it
from there, so the window, the installer and the version shown in the app can never drift apart.
The running version appears in the help dialog (`F1`) and on the empty screen.

To cut a release:

```powershell
npm version patch      # a fix        (1.0.0 -> 1.0.1)
npm version minor      # new features (1.0.0 -> 1.1.0)
npm run tauri build    # installer carries the new version
```

Record what changed in [CHANGELOG.md](CHANGELOG.md). `npm version` also creates a git tag; push
it with `git push --follow-tags`. Keep `src-tauri/Cargo.toml` in step for tidiness — it is the
crate version and does not drive what the app displays.

A GitHub release carries two assets from the same build: the installer
`src-tauri\target\release\bundle\nsis\Leggimi_x.y.z_x64-setup.exe` and the portable zip
produced by `npm run package:portable` (`src-tauri\target\release\bundle\portable\`), which
wraps the release exe with the `leggimi-portable.txt` marker and a short `README.txt`. The
Store gets the MSIX below.

### Microsoft Store package

The Store build is an MSIX produced by Microsoft's [winapp CLI](https://learn.microsoft.com/windows/apps/dev-tools/winapp-cli/)
(`winget install Microsoft.WinAppCli`) from the same release exe:

```powershell
npm run package:msix                     # build + package, unsigned (the Store signs it)
npm run package:msix -- -SkipBuild -Sign # reuse the exe, sign with a dev certificate for a local install
```

The package lands in `src-tauri\target\msix\`. The manifest is `src-tauri\msix\Package.appxmanifest`;
its identity values come from Partner Center and its version is stamped from `package.json` at
packaging time. To install a dev-signed package locally, trust the generated certificate once from an
elevated prompt with `winapp cert install src-tauri\msix\devcert.pfx`, then double-click the `.msix`.

The icons in `src-tauri\msix\Assets\` are generated from `src-tauri\icons\icon.png` and committed.
Re-run `npm run gen:icons` after changing the app icon. The `targetsize-*_altform-unplated` variants
are the ones Windows uses for the taskbar, Start and Alt+Tab; without them the shell plates the icon
on the manifest `BackgroundColor`, and on `transparent` that means the system accent colour.

## Development

Requirements: Node 20+, Rust stable, WebView2 (preinstalled on Windows 11).

```powershell
npm install
npm run tauri dev        # development
npm run tauri build      # produces the NSIS installer in src-tauri\target\release\bundle\nsis\
```

Note: in dev mode Vite does not apply the CSP configured in `tauri.conf.json` — test images and
Mermaid in a production build too.

To exercise the UI in a plain browser, run `npm run dev` and open
`http://localhost:1420/dev/harness.html`: it loads the real app with the Tauri backend mocked
and files kept in memory (`?doc=/samples/test-features.md` opens a sample instead of the
generated document).

## Project layout

- `src/` — TypeScript + Vite frontend (markdown-it, highlight.js, DOMPurify, mermaid,
  CodeMirror 6 for the editor)
- `src-tauri/` — Rust backend: file read/write and tree commands, debounced file watcher
  (notify), single instance, `.md` file association
- `samples/` — test documents; `test-features.md` exercises every feature
- `dev/harness.html` — browser test harness for the frontend (not part of the build)

A `private/` folder, if you create one, is excluded from git: use it for personal documents you
want to open in the app without risking committing them.

## License

Leggimi is free and open source software released under the [MIT License](LICENSE).

## Privacy

Leggimi never connects to the internet and collects no data. See [PRIVACY.md](PRIVACY.md).
