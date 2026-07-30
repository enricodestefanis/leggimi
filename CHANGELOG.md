# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/): `MAJOR.MINOR.PATCH`,
where new features bump MINOR and fixes bump PATCH.

The running version is shown in the help dialog (`F1`) and on the empty screen.

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
