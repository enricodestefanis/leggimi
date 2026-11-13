// The structure the editor shows beyond colours (2.4, the "structured" look):
// a band behind code blocks and front matter, a bar along quotes in the
// colour of their callout (> [!WARNING] orange), a hairline under level-1 and
// level-2 headings, and done tasks ticked in green with their text muted.
// Nothing here changes a line's height: bands are backgrounds, bars and
// hairlines inset shadows (styles/editor.css).

import { syntaxTree } from "@codemirror/language";
import { Prec, type Range } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { calloutFamily } from "./callouts";

const lineDecos = new Map<string, Decoration>();
const markDecos = new Map<string, Decoration>();
const lineDeco = (cls: string): Decoration => {
  let d = lineDecos.get(cls);
  if (!d) lineDecos.set(cls, (d = Decoration.line({ class: cls })));
  return d;
};
const markDeco = (cls: string): Decoration => {
  let d = markDecos.get(cls);
  if (!d) markDecos.set(cls, (d = Decoration.mark({ class: cls })));
  return d;
};

const CALLOUT = /^>[ \t]?\[!([A-Za-z][\w-]*)\]/;

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const tree = syntaxTree(state);
  const out: Range<Decoration>[] = [];
  for (const { from, to } of view.visibleRanges) {
    // a line class on every line of [a, b] within this visible range
    const lines = (a: number, b: number, cls: string): void => {
      const deco = lineDeco(cls);
      for (let pos = Math.max(a, from); pos <= Math.min(b, to); ) {
        const line = doc.lineAt(pos);
        out.push(deco.range(line.from));
        pos = line.to + 1;
      }
    };
    tree.iterate({
      from,
      to,
      enter(node) {
        switch (node.name) {
          case "FencedCode":
          case "CodeBlock":
          case "Frontmatter":
            lines(node.from, node.to, "cm-md-fence");
            // their insides are code: nothing in there is Markdown structure
            return false;
          case "Blockquote": {
            const first = state.sliceDoc(node.from, doc.lineAt(node.from).to);
            const callout = CALLOUT.exec(first);
            lines(node.from, node.to, callout ? `cm-md-quote cm-md-callout-${calloutFamily(callout[1])}` : "cm-md-quote");
            return;
          }
          case "ATXHeading1":
          case "SetextHeading1":
            out.push(lineDeco("cm-md-h1").range(doc.lineAt(node.from).from));
            return;
          case "ATXHeading2":
          case "SetextHeading2":
            out.push(lineDeco("cm-md-h2").range(doc.lineAt(node.from).from));
            return;
          case "CalloutMark": {
            const type = /\[!([^\]]+)\]/.exec(state.sliceDoc(node.from, node.to))?.[1] ?? "note";
            out.push(markDeco(`cm-md-callout-title cm-md-callout-${calloutFamily(type)}`).range(node.from, node.to));
            return;
          }
          case "Task": {
            const marker = node.node.getChild("TaskMarker");
            if (marker && /x/i.test(state.sliceDoc(marker.from, marker.to))) {
              out.push(markDeco("cm-md-task-done").range(marker.from, marker.to));
              if (marker.to < node.to) out.push(markDeco("cm-md-done").range(marker.to, node.to));
            }
            return;
          }
        }
      },
    });
  }
  return Decoration.set(out, true);
}

/**
 * The plugin, at the highest precedence: its marks then sit inside the
 * highlighter's spans, so the green tick and the callout's colour win over
 * the token colours under them.
 */
export const structure = Prec.highest(
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(u: ViewUpdate): void {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) {
          this.decorations = build(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  ),
);
