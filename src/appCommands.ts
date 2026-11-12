// The app's commands for the palette (palette.ts): every action with a key,
// and those only a menu reaches (PDF, HTML, DOCX, keep on top, the themes, a
// new page at every heading 1, the reading settings). The list is made each
// time the palette opens, with only what can be done right then: Save with
// something to save, Back with a place to go back to, the editor's commands
// while editing. main.ts provides the actions and the state through an
// AppCommandHost.
//
// The labels are the app's own strings (a tooltip without its "(Ctrl+X)", a
// menu entry, a line of the keys overlay); in the other languages the
// English label is a keyword too, so "print" finds "Stampa".

import type { PaletteCommand } from "./palette";
import { current as uiLang, t, titleParts, type Dict } from "./i18n";
import en from "./locales/en";
import * as prefs from "./prefs";
import * as theme from "./theme";

/** One of the editor's commands: editCommands.CommandInfo has these, and more. */
export interface EditorCommandInfo {
  id: string;
  label: string;
  /** inner SVG markup, or a short glyph ("H1") */
  icon: string;
  /** as displayed: "Ctrl+Shift+X", "Alt+↑" */
  shortcut?: string;
  keywords?: string;
  checked?: () => boolean;
}

/** What main.ts lends the commands: the state they depend on, and the actions. */
export interface AppCommandHost {
  // ---- the state, read as the palette opens ----
  /** a document is shown (a file or pasted text), not the start page or an error */
  hasDocument(): boolean;
  /** the document is a file on disk (pasted text is not, until it is saved) */
  isFile(): boolean;
  /** pasted text, in no file yet */
  isPasted(): boolean;
  isEditing(): boolean;
  /** the document has unsaved edits */
  isDirty(): boolean;
  /** the document has headings for the outline */
  hasOutline(): boolean;
  /** the file pane has a folder */
  hasFolder(): boolean;
  /** that folder has one above it (it is no drive root) */
  canGoUp(): boolean;
  /** the tabs of this window, start pages included */
  tabCount(): number;
  /** a closed tab to bring back */
  canReopenTab(): boolean;
  canGoBack(): boolean;
  canGoForward(): boolean;
  /** keep on top of other windows is on */
  isPinned(): boolean;

  // ---- documents ----
  pasteAsDocument(): void;
  chooseFile(): void;
  toggleEditMode(): void;
  /** Ctrl+S: saves, or asks where for pasted text */
  saveFile(): void;
  reloadCurrentDoc(): void;
  copyPath(): void;
  revealInExplorer(): void;

  // ---- tabs and windows ----
  newTab(): void;
  reopenTab(): void;
  closeTab(): void;
  stepTab(dir: 1 | -1): void;
  moveTabToNewWindow(): void;
  newWindow(): void;
  closeWindow(): void;

  // ---- navigation and panes ----
  /** Ctrl+F: the find bar, or the editor's own while editing */
  findInDocument(): void;
  /** Ctrl+Shift+F */
  searchFolder(): void;
  goUp(): void;
  goBack(): void;
  goForward(): void;
  /** Ctrl+B / Ctrl+I, the keys going into a pane that opens over the text */
  togglePane(pane: "tree" | "toc"): void;

  // ---- share and print ----
  toggleShareMenu(): void;
  copyDocAsRichText(): void;
  printDoc(): void;
  exportDocAsPdf(): void;
  exportDocAsHtml(): void;
  exportDocAsDocx(): void;

  // ---- settings (the theme and the print option are theme.ts's and prefs.ts's own) ----
  togglePin(): void;
  bumpReaderSize(dir: 1 | -1): void;
  /** Ctrl+0, keeping the place being read */
  resetReaderSize(): void;
  /** the Aa popover, with the keys in it */
  openReadingSettings(): void;

  // ---- help ----
  toggleKeysDialog(): void;
  openHelp(): void;

  // ---- the editor's own commands, while editing ----
  /** editCommands.COMMANDS (empty when not editing) */
  editorCommands(): readonly EditorCommandInfo[];
  runEditorCommand(id: string): void;
}

type Key = keyof Dict;

// 24-px stroke icons, drawn at 16 px like the toolbar's and the menus'
const ICON = {
  paste:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  edit: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  read: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  reload: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  tab: '<rect x="2" y="6" width="20" height="15" rx="2"/><path d="M2 10h20"/><path d="M7 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"/>',
  reopen: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  next: '<polyline points="9 18 15 12 9 6"/>',
  prev: '<polyline points="15 18 9 12 15 6"/>',
  moveOut: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  newWindow:
    '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="12" y1="11" x2="12" y2="18"/><line x1="8.5" y1="14.5" x2="15.5" y2="14.5"/>',
  closeWindow:
    '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="8" x2="22" y2="8"/><line x1="9.5" y1="12" x2="14.5" y2="17"/><line x1="14.5" y1="12" x2="9.5" y2="17"/>',
  find: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  folderFind:
    '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><circle cx="12" cy="13.5" r="2.5"/><line x1="16" y1="17.5" x2="14" y2="15.5"/>',
  up: '<path d="M12 19V5"/><polyline points="5 12 12 5 19 12"/>',
  back: '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  forward: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  tree: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
  toc: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/>',
  richText:
    '<path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="13" y2="16"/>',
  print:
    '<polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
  pdf: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="11"/><polyline points="9 15 12 18 15 15"/>',
  html: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  docx: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/>',
  pageBreak:
    '<path d="M5 9V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v5"/><path d="M5 15v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/><line x1="2" y1="12" x2="5" y2="12"/><line x1="10" y1="12" x2="14" y2="12"/><line x1="19" y1="12" x2="22" y2="12"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 7 3 3H7l3-3z"/>',
  light:
    '<circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="6.34" y2="6.34"/><line x1="17.66" y1="17.66" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="6.34" y2="17.66"/><line x1="17.66" y1="6.34" x2="19.07" y2="4.93"/>',
  sepia:
    '<path d="M17 18a5 5 0 0 0-10 0"/><line x1="12" y1="2" x2="12" y2="9"/><line x1="4.22" y1="10.22" x2="5.64" y2="11.64"/><line x1="1" y1="18" x2="3" y2="18"/><line x1="21" y1="18" x2="23" y2="18"/><line x1="18.36" y1="11.64" x2="19.78" y2="10.22"/><line x1="23" y1="22" x2="1" y2="22"/>',
  dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
  black: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" fill="currentColor"/>',
  system: '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  resetSize: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  keys: '<rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6.01" y2="10"/><line x1="10" y1="10" x2="10.01" y2="10"/><line x1="14" y1="10" x2="14.01" y2="10"/><line x1="18" y1="10" x2="18.01" y2="10"/><line x1="7" y1="14" x2="17" y2="14"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
};

const THEMES: readonly [theme.ThemePref, Key, string][] = [
  ["light", "rs.light", ICON.light],
  ["sepia", "rs.sepia", ICON.sepia],
  ["dark", "rs.dark", ICON.dark],
  ["black", "rs.black", ICON.black],
  ["system", "rs.auto", ICON.system],
];

// What the palette suggests before anything is typed, after the commands
// used recently: what one does next on the start page, while reading, while
// editing. The rest follow in the order of the list.
const SUGGEST = {
  start: ["open", "paste", "searchFolder", "newWindow", "reading", "help"],
  reading: ["find", "edit", "share", "toc", "searchFolder", "print"],
  editing: ["edit", "save", "find", "editor:find", "share", "print"],
};

// the other languages also find a command by its English words
const ENGLISH_TOO = uiLang() !== "en";

const words = (...parts: (string | undefined | false)[]): string | undefined => parts.filter(Boolean).join(" ") || undefined;

// A command whose label is the string `key` (a tooltip loses its "(Ctrl+X)").
function command(id: string, key: Key, icon: string, run: () => void, keys?: string, more?: string): PaletteCommand {
  const label = titleParts(t(key)).label;
  const english = titleParts(en[key]).label;
  return { id, label, icon, run, keys, keywords: words(ENGLISH_TOO && english !== label && english, more) };
}

/** The commands that can be run now, in the order the palette suggests them. */
export function buildCommands(h: AppCommandHost): PaletteCommand[] {
  const doc = h.hasDocument();
  const file = doc && h.isFile();
  const pasted = doc && h.isPasted();
  const editing = doc && h.isEditing();
  const dirty = doc && h.isDirty();
  const folder = h.hasFolder();
  const severalTabs = h.tabCount() > 1;
  const p = prefs.get();
  const sizes = prefs.SIZE_STEPS;
  const themeNow = theme.currentPref();
  const list: PaletteCommand[] = [];
  const add = (c: PaletteCommand | false): void => {
    if (c) list.push(c);
  };

  // documents (in the editor, Ctrl+V pastes into the text)
  add(command("paste", "keys.paste", ICON.paste, h.pasteAsDocument, editing ? undefined : "Ctrl+V"));
  add(command("open", "empty.open", ICON.folder, h.chooseFile, "Ctrl+O"));
  add(doc && command("edit", editing ? "toolbar.read" : "toolbar.edit", editing ? ICON.read : ICON.edit, h.toggleEditMode, "Ctrl+E"));
  add((dirty || pasted) && command("save", pasted ? "tab.saveAs" : "toolbar.save", ICON.save, h.saveFile, "Ctrl+S"));
  add(file && !dirty && command("reload", "keys.reload", ICON.reload, h.reloadCurrentDoc, "F5"));
  add(file && command("copyPath", "file.copyPath", ICON.copy, h.copyPath));
  add(file && command("reveal", "file.reveal", ICON.folder, h.revealInExplorer));

  // tabs and windows
  add(command("newTab", "tab.newTab", ICON.tab, h.newTab, "Ctrl+T"));
  add(h.canReopenTab() && command("reopenTab", "tab.reopen", ICON.reopen, h.reopenTab, "Ctrl+Shift+T"));
  add(command("closeTab", "tab.closeTab", ICON.close, h.closeTab, "Ctrl+W"));
  add(severalTabs && command("nextTab", "pal.nextTab", ICON.next, () => h.stepTab(1), "Ctrl+Tab"));
  add(severalTabs && command("prevTab", "pal.prevTab", ICON.prev, () => h.stepTab(-1), "Ctrl+Shift+Tab"));
  add(severalTabs && command("moveTab", "tab.moveToWindow", ICON.moveOut, h.moveTabToNewWindow));
  add(command("newWindow", "keys.newWindow", ICON.newWindow, h.newWindow, "Ctrl+Shift+N"));
  add(command("closeWindow", "keys.closeWindow", ICON.closeWindow, h.closeWindow, "Ctrl+Shift+W"));

  // navigation and panes (in the editor, Ctrl+B and Ctrl+I are bold and italic)
  add(doc && command("find", "keys.find", ICON.find, h.findInDocument, "Ctrl+F"));
  add(folder && command("searchFolder", "keys.searchFolder", ICON.folderFind, h.searchFolder, "Ctrl+Shift+F"));
  add(folder && h.canGoUp() && command("up", "pane.up", ICON.up, h.goUp));
  add(h.canGoBack() && command("back", "ctx.back", ICON.back, h.goBack, "Alt+←"));
  add(h.canGoForward() && command("forward", "ctx.forward", ICON.forward, h.goForward, "Alt+→"));
  add(command("tree", "toolbar.tree", ICON.tree, () => h.togglePane("tree"), editing ? undefined : "Ctrl+B"));
  add(doc && h.hasOutline() && command("toc", "toolbar.toc", ICON.toc, () => h.togglePane("toc"), editing ? undefined : "Ctrl+I"));

  // share and print
  add(doc && command("share", "keys.share", ICON.share, h.toggleShareMenu, "Ctrl+Shift+E"));
  add(doc && command("copyRich", "share.copy", ICON.richText, h.copyDocAsRichText, "Ctrl+Shift+C"));
  add(doc && command("print", "share.print", ICON.print, h.printDoc, "Ctrl+P"));
  add(doc && command("pdf", "share.pdf", ICON.pdf, h.exportDocAsPdf));
  add(doc && command("html", "share.html", ICON.html, h.exportDocAsHtml));
  add(doc && command("docx", "share.docx", ICON.docx, h.exportDocAsDocx));

  // settings
  add({
    ...command("breakH1", "share.breakH1", ICON.pageBreak, () => prefs.set({ printBreakH1: !prefs.get().printBreakH1 })),
    checked: p.printBreakH1,
  });
  add({ ...command("pin", "keys.pin", ICON.pin, h.togglePin), checked: h.isPinned() });
  for (const [pref, key, icon] of THEMES) {
    const label = t("pal.theme", { name: t(key) });
    const english = en["pal.theme"].split("{name}").join(en[key]);
    add({
      id: `theme.${pref}`,
      label,
      icon,
      keywords: words(ENGLISH_TOO && english),
      // the theme in use is ticked; the others are choices, not boxes to tick
      checked: pref === themeNow ? true : undefined,
      run: () => theme.setPref(pref),
    });
  }
  add(p.size < sizes[sizes.length - 1] && command("larger", "rs.larger", "A+", () => h.bumpReaderSize(1), "Ctrl+="));
  add(p.size > sizes[0] && command("smaller", "rs.smaller", "A−", () => h.bumpReaderSize(-1), "Ctrl+−"));
  add(p.size !== prefs.DEFAULTS.size && command("resetSize", "pal.resetSize", ICON.resetSize, h.resetReaderSize, "Ctrl+0"));
  add(
    command(
      "reading",
      "toolbar.reading",
      "Aa",
      h.openReadingSettings,
      undefined,
      words(t("cmd.kwReading"), ENGLISH_TOO && en["cmd.kwReading"]),
    ),
  );

  // help
  add(command("keys", "cmd.keys", ICON.keys, h.toggleKeysDialog, "?"));
  add(command("help", "toolbar.help", ICON.help, h.openHelp, "F1"));

  // the editor's own, tagged as such
  if (editing) {
    const enLabels = en as Readonly<Record<string, string>>;
    for (const c of h.editorCommands()) {
      const english = enLabels[`cmd.${c.id}`];
      add({
        id: `editor:${c.id}`,
        label: c.label,
        icon: c.icon,
        keys: c.shortcut,
        keywords: words(ENGLISH_TOO && english !== c.label && english, c.keywords),
        checked: c.checked?.(),
        group: "editor",
        run: () => h.runEditorCommand(c.id),
      });
    }
  }

  const first = SUGGEST[editing ? "editing" : doc ? "reading" : "start"];
  const rank = (c: PaletteCommand): number => {
    const i = first.indexOf(c.id);
    return i < 0 ? first.length : i;
  };
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map((x) => x.c);
}
