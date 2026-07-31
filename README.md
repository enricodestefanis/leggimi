# Markdown Studio

A fast Markdown viewer and editor for Windows, built with Tauri 2. Documents open in a clean,
centered reading column with light and dark themes; an optional edit mode adds a split view with
a live preview. Files are only modified when you save explicitly.


<img width="1863" height="1241" alt="Markdown Studio screen 1" src="https://github.com/user-attachments/assets/10af9556-1678-4b0c-8047-263cd3c885ba" />

<img width="1863" height="1241" alt="Markdown Studio screen 2" src="https://github.com/user-attachments/assets/6778669f-1e1e-4e14-9ed7-18ceb80250ba" />


## Features

- Documents always open in **viewer mode**; `Ctrl+E` switches to **edit mode**: CodeMirror
  editor on the left, live preview on the right, updated as you type
- Explicit save with `Ctrl+S`, unsaved-changes indicator and confirmation guards; line endings
  (CRLF/LF) are preserved on save
- If a preview render fails mid-edit, the last good preview stays on screen and a dismissable
  notice appears — the pane never goes blank
- GitHub-flavored Markdown: tables, task lists, strikethrough, autolinks
- Syntax-highlighted code blocks with a copy button
- **Mermaid** diagrams, bundled locally so they work offline
- Clickable **outline** with scroll-spy
- **File browser** for the Markdown files in the folder you opened
- **Live reload** when the file changes on disk, preserving your reading position; with unsaved
  edits it warns instead of overwriting your buffer
- Find in document (`Ctrl+F`), light/dark theme, relative images
- Double-click any `.md` file in File Explorer — the installer registers the association
- Single instance: further files open in the existing window
- Drag and drop files onto the window, or press `Ctrl+O`
- Built-in help (`F1`) showing the running version

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+O` | Open a file |
| `Ctrl+E` | Toggle edit mode |
| `Ctrl+S` | Save the file (edit mode) |
| `Ctrl+F` | Find in document |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Ctrl+B` | Toggle the file browser |
| `Ctrl+I` | Toggle the outline |
| `F1` | Show help |
| `Esc` | Close the find bar or help |

## File browser

The left panel is rooted at the folder of the document you opened and lists Markdown files up to
four levels of subfolders (capped at 2000 files). Opening a file from the panel keeps the same
root, so navigating into a subfolder does not hide the rest of the tree; the up arrow moves the
root to the parent folder. Opening a document outside the current root re-roots the panel there.
Folders with no Markdown files are hidden, as are hidden folders and build directories such as
`node_modules`, `target` and `dist`.

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

## Development

Requirements: Node 20+, Rust stable, WebView2 (preinstalled on Windows 11).

```powershell
npm install
npm run tauri dev        # development
npm run tauri build      # produces the NSIS installer in src-tauri\target\release\bundle\nsis\
```

Note: in dev mode Vite does not apply the CSP configured in `tauri.conf.json` — test images and
Mermaid in a production build too.

## Project layout

- `src/` — TypeScript + Vite frontend (markdown-it, highlight.js, DOMPurify, mermaid,
  CodeMirror 6 for the editor)
- `src-tauri/` — Rust backend: file read/write and tree commands, debounced file watcher
  (notify), single instance, `.md` file association
- `samples/` — test documents; `test-features.md` exercises every feature

A `private/` folder, if you create one, is excluded from git: use it for personal documents you
want to open in the app without risking committing them.
