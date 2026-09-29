// Markdown editing commands shared by the editor keymap, the format bar and
// the "/" menu. Each command edits the source text directly: the file on
// disk stays plain Markdown, there is no hidden rich-text model.
import { EditorSelection, EditorState, Line, type ChangeSpec } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

export type EditCommand = (view: EditorView) => boolean;

// ---------------------------------------------------------------- inline

// Consecutive `ch` characters starting at `pos`, walking in `dir`.
function runLength(state: EditorState, pos: number, dir: 1 | -1, ch: string): number {
  let n = 0;
  const doc = state.doc;
  while (true) {
    const p = dir === 1 ? pos + n : pos - n - 1;
    if (p < 0 || p >= doc.length || doc.sliceString(p, p + 1) !== ch) return n;
    n++;
  }
}

// Is [from, to] directly surrounded by `marker`? For "*" and "**" the run
// length decides, so italic never mistakes bold's markers for its own.
function wrappedBy(state: EditorState, from: number, to: number, marker: string): boolean {
  if (marker === "*" || marker === "**") {
    const b = runLength(state, from, -1, "*");
    const a = runLength(state, to, 1, "*");
    return marker === "*" ? b % 2 === 1 && a % 2 === 1 : b >= 2 && a >= 2;
  }
  return (
    state.sliceDoc(from - marker.length, from) === marker &&
    state.sliceDoc(to, to + marker.length) === marker
  );
}

/** Wrap each selection (or the word under the caret) in `marker`, or unwrap it. */
export function toggleWrap(marker: string): EditCommand {
  const m = marker.length;
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        let { from, to } = range;
        if (range.empty) {
          const word = state.wordAt(from);
          if (word) ({ from, to } = word);
        } else {
          // `**word **` is not bold: keep surrounding whitespace outside
          const text = state.sliceDoc(from, to);
          from += text.length - text.trimStart().length;
          to -= text.length - text.trimEnd().length;
          if (from > to) to = from;
        }
        // markers just outside the range: remove them
        if (wrappedBy(state, from, to, marker)) {
          return {
            changes: [
              { from: from - m, to: from },
              { from: to, to: to + m },
            ],
            range: EditorSelection.range(from - m, to - m),
          };
        }
        // the selection itself includes the markers: strip them
        const inner = state.sliceDoc(from, to);
        if (
          inner.length >= 2 * m &&
          inner.startsWith(marker) &&
          inner.endsWith(marker) &&
          (marker !== "*" || !inner.startsWith("**") || inner.startsWith("***"))
        ) {
          return {
            changes: { from, to, insert: inner.slice(m, inner.length - m) },
            range: EditorSelection.range(from, to - 2 * m),
          };
        }
        return {
          changes: [
            { from, insert: marker },
            { from: to, insert: marker },
          ],
          range: EditorSelection.range(from + m, to + m),
        };
      }),
      { userEvent: "input.format", scrollIntoView: true },
    );
    return true;
  };
}

export const insertLink: EditCommand = (view) => {
  const { state } = view;
  view.dispatch(
    state.changeByRange((range) => {
      const text = state.sliceDoc(range.from, range.to);
      if (/^(https?:\/\/|mailto:|www\.)\S+$/i.test(text)) {
        // a bare URL: it becomes the target, the caret goes to the label
        return {
          changes: { from: range.from, to: range.to, insert: `[](${text})` },
          range: EditorSelection.cursor(range.from + 1),
        };
      }
      const label = text || "link text";
      const insert = `[${label}](url)`;
      const urlFrom = range.from + label.length + 3;
      return {
        changes: { from: range.from, to: range.to, insert },
        // with a label already typed, go straight to the URL
        range: text
          ? EditorSelection.range(urlFrom, urlFrom + 3)
          : EditorSelection.range(range.from + 1, range.from + 1 + label.length),
      };
    }),
    { userEvent: "input.format", scrollIntoView: true },
  );
  return true;
};

// ------------------------------------------------------------ line-level

function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const r of state.selection.ranges) {
    const last = state.doc.lineAt(r.to).number;
    for (let n = state.doc.lineAt(r.from).number; n <= last; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      lines.push(state.doc.line(n));
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

// Apply line-start edits and keep carets after any inserted prefix.
function dispatchLineChanges(view: EditorView, changes: ChangeSpec[]): void {
  const set = view.state.changes(changes);
  view.dispatch({
    changes: set,
    selection: view.state.selection.map(set, 1),
    userEvent: "input.format",
    scrollIntoView: true,
  });
}

export type ListKind = "bullet" | "ordered" | "task" | "quote";

const LIST_PREFIX = /^(\s*)([-*+] \[[ xX]\] |[-*+] |\d+[.)] )?/;
const QUOTE_PREFIX = /^(\s*)> ?/;

function listKindOf(prefix: string | undefined): ListKind | null {
  if (!prefix) return null;
  if (/\[[ xX]\]/.test(prefix)) return "task";
  if (/^\d/.test(prefix)) return "ordered";
  return "bullet";
}

/** Toggle a list or quote marker on every selected line. */
export function toggleLinePrefix(kind: ListKind): EditCommand {
  return (view) => {
    const lines = selectedLines(view.state);
    const content = lines.filter((l) => l.text.trim() !== "");
    const targets = content.length ? content : lines;
    const changes: ChangeSpec[] = [];

    if (kind === "quote") {
      const allQuoted = targets.every((l) => QUOTE_PREFIX.test(l.text));
      for (const l of targets) {
        const q = QUOTE_PREFIX.exec(l.text);
        if (allQuoted && q) changes.push({ from: l.from + q[1].length, to: l.from + q[0].length });
        else if (!allQuoted && !q) changes.push({ from: l.from, insert: "> " });
      }
      dispatchLineChanges(view, changes);
      return true;
    }

    const allOfKind = targets.every((l) => listKindOf(LIST_PREFIX.exec(l.text)?.[2]) === kind);
    targets.forEach((l, i) => {
      const [, indent, prefix = ""] = LIST_PREFIX.exec(l.text)!;
      const from = l.from + indent.length;
      const to = from + prefix.length;
      if (allOfKind) {
        changes.push({ from, to });
      } else {
        const insert = kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${i + 1}. `;
        changes.push({ from, to, insert });
      }
    });
    dispatchLineChanges(view, changes);
    return true;
  };
}

const HEADING_PREFIX = /^(#{1,6})[ \t]+|^#{1,6}$/;

/** Make the selected lines a heading of `level`; the same level again (or 0) removes it. */
export function setHeading(level: number): EditCommand {
  return (view) => {
    const lines = selectedLines(view.state);
    const allAtLevel = lines.every((l) => HEADING_PREFIX.exec(l.text)?.[1]?.length === level);
    const changes: ChangeSpec[] = lines.map((l) => {
      const cur = HEADING_PREFIX.exec(l.text);
      const insert = level > 0 && !allAtLevel ? "#".repeat(level) + " " : "";
      return { from: l.from, to: l.from + (cur ? cur[0].length : 0), insert };
    });
    dispatchLineChanges(view, changes);
    return true;
  };
}

// ---------------------------------------------------------------- blocks

/**
 * Insert a block on its own lines, with blank lines around it. `{{…}}` in
 * the template marks the placeholder that ends up selected.
 */
export function insertBlock(template: string): EditCommand {
  return (view) => {
    const { state } = view;
    const doc = state.doc;
    const line = doc.lineAt(state.selection.main.head);
    const open = template.indexOf("{{");
    const close = template.indexOf("}}");
    const body = open >= 0 ? template.slice(0, open) + template.slice(open + 2, close) + template.slice(close + 2) : template;

    let from: number, to: number, before: string;
    if (line.text.trim() === "") {
      // an empty line (or one only left with the "/" query) becomes the block
      from = line.from;
      to = line.to;
      const prev = line.number > 1 ? doc.line(line.number - 1) : null;
      before = prev && prev.text.trim() !== "" ? "\n" : "";
    } else {
      from = to = line.to;
      before = "\n\n";
    }
    const next = line.number < doc.lines ? doc.line(line.number + 1) : null;
    const after = next && next.text.trim() !== "" ? "\n" : "";

    const start = from + before.length;
    const selection =
      open >= 0
        ? EditorSelection.range(start + open, start + close - 2)
        : EditorSelection.cursor(start + body.length);
    view.dispatch({
      changes: { from, to, insert: before + body + after },
      selection,
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  };
}

// --------------------------------------------------------- active state

/** Formats present at the main caret, for highlighting format-bar buttons. */
export function activeFormats(state: EditorState): Set<string> {
  const active = new Set<string>();
  const head = state.selection.main.head;
  for (let node: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(state).resolveInner(head, -1); node; node = node.parent) {
    switch (node.name) {
      case "StrongEmphasis": active.add("bold"); break;
      case "Emphasis": active.add("italic"); break;
      case "Strikethrough": active.add("strike"); break;
      case "InlineCode": active.add("code"); break;
      case "Link": active.add("link"); break;
      case "Blockquote": active.add("quote"); break;
      case "ATXHeading1": case "SetextHeading1": active.add("h1"); break;
      case "ATXHeading2": case "SetextHeading2": active.add("h2"); break;
      case "ATXHeading3": active.add("h3"); break;
      case "ListItem": {
        const text = state.doc.lineAt(node.from).text;
        const kind = listKindOf(LIST_PREFIX.exec(text)?.[2]);
        if (kind && !active.has("bullet") && !active.has("ordered") && !active.has("task")) active.add(kind);
        break;
      }
    }
  }
  return active;
}

// --------------------------------------------------------------- registry

export interface CommandInfo {
  id: string;
  label: string;
  /** inner SVG markup on a 24×24 stroke grid, or a short text glyph */
  icon: string;
  run: EditCommand;
  shortcut?: string;
  /** extra words the "/" menu matches on */
  keywords?: string;
  /** listed in the "/" menu and the Insert menu */
  block?: boolean;
}

const I = {
  bold: '<path d="M6 4h8a4 4 0 0 1 0 8H6z"/><path d="M6 12h9a4 4 0 0 1 0 8H6z"/>',
  italic: '<line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  bullet: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  ordered: '<line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task: '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  quote: '<line x1="4" y1="5" x2="4" y2="19"/><line x1="9" y1="7" x2="20" y2="7"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="17" x2="16" y2="17"/>',
  table: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/>',
  diagram: '<rect x="3" y="3" width="6" height="6" rx="1"/><rect x="15" y="15" width="6" height="6" rx="1"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/>',
  math: '<path d="M18 7V4H6l6 8-6 8h12v-3"/>',
  codeBlock: '<rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="10 9 7 12 10 15"/><polyline points="14 9 17 12 14 15"/>',
  note: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  tip: '<path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/>',
  warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  divider: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="8" y1="6" x2="16" y2="6" opacity=".35"/><line x1="8" y1="18" x2="16" y2="18" opacity=".35"/>',
};

export const COMMANDS: CommandInfo[] = [
  { id: "bold", label: "Bold", icon: I.bold, run: toggleWrap("**"), shortcut: "Ctrl+B" },
  { id: "italic", label: "Italic", icon: I.italic, run: toggleWrap("*"), shortcut: "Ctrl+I" },
  { id: "strike", label: "Strikethrough", icon: I.strike, run: toggleWrap("~~"), shortcut: "Ctrl+Shift+X" },
  { id: "code", label: "Inline code", icon: I.code, run: toggleWrap("`"), shortcut: "Ctrl+Shift+M" },
  { id: "link", label: "Link", icon: I.link, run: insertLink, shortcut: "Ctrl+K" },
  { id: "h1", label: "Heading 1", icon: "H1", run: setHeading(1), shortcut: "Ctrl+1", keywords: "title h1", block: true },
  { id: "h2", label: "Heading 2", icon: "H2", run: setHeading(2), shortcut: "Ctrl+2", keywords: "subtitle h2", block: true },
  { id: "h3", label: "Heading 3", icon: "H3", run: setHeading(3), shortcut: "Ctrl+3", keywords: "h3", block: true },
  { id: "paragraph", label: "Normal text", icon: "¶", run: setHeading(0), keywords: "paragraph plain" },
  { id: "bullet", label: "Bulleted list", icon: I.bullet, run: toggleLinePrefix("bullet"), keywords: "unordered ul", block: true },
  { id: "ordered", label: "Numbered list", icon: I.ordered, run: toggleLinePrefix("ordered"), keywords: "ordered ol", block: true },
  { id: "task", label: "Task list", icon: I.task, run: toggleLinePrefix("task"), keywords: "todo checkbox checklist", block: true },
  { id: "quote", label: "Quote", icon: I.quote, run: toggleLinePrefix("quote"), keywords: "blockquote citation", block: true },
  {
    id: "table", label: "Table", icon: I.table, keywords: "grid columns rows", block: true,
    run: insertBlock("| {{Column}} | Column | Column |\n| --- | --- | --- |\n| Cell | Cell | Cell |\n| Cell | Cell | Cell |"),
  },
  {
    id: "diagram", label: "Diagram", icon: I.diagram, keywords: "mermaid flowchart chart flow graph", block: true,
    run: insertBlock("```mermaid\nflowchart LR\n  A[{{Start}}] --> B{Decision}\n  B -->|Yes| C[Do it]\n  B -->|No| D[Skip]\n```"),
  },
  {
    id: "math", label: "Formula", icon: I.math, keywords: "math katex latex equation", block: true,
    run: insertBlock("$$\n{{E = mc^2}}\n$$"),
  },
  { id: "codeblock", label: "Code block", icon: I.codeBlock, keywords: "fence snippet pre", block: true, run: insertBlock("```\n{{code}}\n```") },
  { id: "note", label: "Note callout", icon: I.note, keywords: "alert info admonition", block: true, run: insertBlock("> [!NOTE]\n> {{Useful information.}}") },
  { id: "tip", label: "Tip callout", icon: I.tip, keywords: "alert hint admonition", block: true, run: insertBlock("> [!TIP]\n> {{A helpful suggestion.}}") },
  { id: "warning", label: "Warning callout", icon: I.warning, keywords: "alert caution important admonition", block: true, run: insertBlock("> [!WARNING]\n> {{Something to watch out for.}}") },
  { id: "divider", label: "Divider", icon: I.divider, keywords: "hr rule separator line", block: true, run: insertBlock("---\n") },
];

export const commandById = new Map(COMMANDS.map((c) => [c.id, c]));

/** SVG (or text glyph) element for a command icon. */
export function iconHtml(icon: string, size = 16): string {
  if (!icon.startsWith("<")) return `<span class="cmd-glyph">${icon}</span>`;
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
}
