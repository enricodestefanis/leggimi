// Link completion in the editor (2.4): after "](" the Markdown files of the
// folder, after "![](" its pictures, after "](#" the document's headings,
// after "](other.md#" that note's headings, after "[[" the notes' names and
// after "[[Note#" their headings. The paths are relative to the document and
// written as the app writes links (paths.ts linkUrl); heading ids are the
// preview's own (renderer.ts headingAnchors). The data comes from the page
// through a provider: this module never reads main.ts.

import type { Completion, CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { linkUrl, relativePath, samePath } from "./paths";

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export interface LinkProvider {
  /** the document's folder (null: pasted text, in no folder), its path, and the Markdown files the file pane lists */
  targets(): { dir: string | null; path: string | null; files: string[] };
  /** the pictures under the document's folder */
  images(): Promise<string[]>;
  /** a note's headings; `file` null: the text being edited, given as `text` */
  headings(file: string | null, text: string): Promise<Heading[]>;
}

let provider: LinkProvider | null = null;

export function setLinkProvider(p: LinkProvider | null): void {
  provider = p;
}

const NOT_HERE = new Set(["FencedCode", "CodeBlock", "HTMLBlock", "InlineCode", "CommentBlock", "Frontmatter", "InlineMath"]);

function inCode(ctx: CompletionContext): boolean {
  for (let n: ReturnType<typeof syntaxTree>["topNode"] | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
    if (NOT_HERE.has(n.name) && n.from < ctx.pos) return true;
  }
  return false;
}

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
const MD_EXT = /\.(?:md|markdown|mdown|mkdn?|mkd|mdwn|markdn|mdtxt)$/i;
const depth = (rel: string): number => rel.split("/").length - 1 + (rel.match(/\.\.\//g)?.length ?? 0) * 2;

/** Insert `text` over [from, to), and the closer when it is not already right after. */
function applyWith(text: string, closer: string) {
  return (view: EditorView, _c: Completion, from: number, to: number): void => {
    const has = view.state.sliceDoc(to, to + closer.length) === closer;
    view.dispatch({
      changes: { from, to, insert: has ? text : text + closer },
      // after the closer: the link is written, the sentence goes on
      selection: { anchor: from + text.length + closer.length },
      userEvent: "input.complete",
    });
  };
}

/** A side panel with a note's first heading, read on demand. */
function infoOf(file: string) {
  return async (): Promise<Node | null> => {
    const heads = await provider?.headings(file, "").catch(() => []);
    const first = heads?.[0];
    if (!first) return null;
    const el = document.createElement("div");
    el.className = "cm-link-info";
    el.textContent = first.text;
    return el;
  };
}

function fileOptions(dir: string, files: string[], type: "md" | "img", closer: string): Completion[] {
  return files.map((file) => {
    const rel = relativePath(dir, file);
    return {
      label: rel,
      type: `link-${type}`,
      boost: -Math.min(40, depth(rel)),
      apply: applyWith(linkUrl(rel), closer),
      info: type === "md" ? infoOf(file) : undefined,
    };
  });
}

function headingOptions(heads: Heading[], closer: string): Completion[] {
  const seen = new Set<string>();
  return heads
    .filter((h) => !seen.has(h.id) && seen.add(h.id))
    .map((h, i) => ({
      label: h.id,
      displayLabel: h.text || h.id,
      detail: `H${h.level}`,
      type: "link-heading",
      // the document's order, not the alphabet
      boost: -Math.min(99, i) / 10,
      apply: applyWith(h.id, closer),
    }));
}

/** A file the document links to, from what is typed before "#": one the pane lists, or the document. */
function targetFile(typed: string, dir: string, path: string | null, files: string[]): string | null | undefined {
  if (!typed) return null; // the document itself
  let rel = typed;
  try {
    rel = decodeURI(typed);
  } catch {
    /* as typed */
  }
  const want = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  const found = files.find((f) => relativePath(dir, f) === want || relativePath(dir, f).toLowerCase() === want.toLowerCase());
  if (found) return found;
  if (path && relativePath(dir, path).toLowerCase() === want.toLowerCase()) return null;
  return undefined; // not a note the pane lists: no headings
}

// [text](path… or ![alt](path…, before any "#"
const LINK = /(!?)\[[^\]\n]*\]\(([^()\s#]*)$/;
// [text](path#anchor…
const ANCHOR = /\[[^\]\n]*\]\(([^()\s#]*)#([^()\s]*)$/;

export async function linkSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (!provider) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const anchor = ANCHOR.exec(before);
  const link = anchor ? null : LINK.exec(before);
  if (!anchor && !link) return null;
  if (inCode(ctx)) return null;
  const { dir, path, files } = provider.targets();

  if (anchor) {
    const typed = anchor[2];
    let file: string | null | undefined = null;
    if (anchor[1]) {
      if (!dir) return null;
      file = targetFile(anchor[1], dir, path, files);
      if (file === undefined) return null;
    }
    const heads = await provider.headings(file, file === null ? ctx.state.doc.toString() : "").catch(() => []);
    if (!heads.length) return null;
    return { from: ctx.pos - typed.length, options: headingOptions(heads, ")"), validFor: /^[^\s()#]*$/ };
  }

  if (!dir) return null;
  const typed = link![2];
  const image = link![1] === "!";
  const list = image ? await provider.images().catch(() => []) : files.filter((f) => !path || !samePath(f, path));
  if (!list.length) return null;
  return {
    from: ctx.pos - typed.length,
    options: fileOptions(dir, list, image ? "img" : "md", ")"),
    validFor: /^[^\s()#\]]*$/,
  };
}

// [[name… and [[name#heading… (also ![[ for pictures)
const WIKI = /(!?)\[\[([^[\]|#\n]*)$/;
const WIKI_ANCHOR = /\[\[([^[\]|#\n]+)#([^[\]|\n]*)$/;

const noteName = (file: string): string => fileName(file).replace(MD_EXT, "");

/** The note a [[name]] means: the same name, closest to the document first (as followLink finds it). */
function noteFile(name: string, dir: string, files: string[]): string | undefined {
  const want = name.trim().toLowerCase();
  const tail = want.includes("/") ? want : null;
  return files
    .filter((f) => {
      const rel = relativePath(dir, f).toLowerCase().replace(MD_EXT, "");
      return tail ? rel.endsWith(tail) : noteName(f).toLowerCase() === want;
    })
    .sort((a, b) => depth(relativePath(dir, a)) - depth(relativePath(dir, b)))[0];
}

export async function wikiSource(ctx: CompletionContext): Promise<CompletionResult | null> {
  if (!provider) return null;
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const anchor = WIKI_ANCHOR.exec(before);
  const wiki = anchor ? null : WIKI.exec(before);
  if (!anchor && !wiki) return null;
  if (inCode(ctx)) return null;
  const { dir, path, files } = provider.targets();
  if (!dir) return null;

  if (anchor) {
    const file = noteFile(anchor[1], dir, files);
    if (!file) return null;
    const heads = await provider.headings(file, "").catch(() => []);
    if (!heads.length) return null;
    // a wikilink names a heading by its text, as note-taking apps write it
    const options = heads.map((h, i) => ({
      label: h.text,
      detail: `H${h.level}`,
      type: "link-heading",
      boost: -Math.min(99, i) / 10,
      apply: applyWith(h.text, "]]"),
    }));
    return { from: ctx.pos - anchor[2].length, options, validFor: /^[^[\]|#\n]*$/ };
  }

  const typed = wiki![2];
  if (wiki![1] === "!") {
    const pictures = await provider.images().catch(() => []);
    if (!pictures.length) return null;
    const options = pictures.map((p) => ({ label: fileName(p), type: "link-img", apply: applyWith(fileName(p), "]]") }));
    return { from: ctx.pos - typed.length, options, validFor: /^[^[\]|#\n]*$/ };
  }

  const notes = files.filter((f) => !path || !samePath(f, path));
  const count = new Map<string, number>();
  for (const f of notes) count.set(noteName(f).toLowerCase(), (count.get(noteName(f).toLowerCase()) ?? 0) + 1);
  const options = notes.map((f) => {
    const name = noteName(f);
    // two notes with one name: the folder tells them apart
    const label = (count.get(name.toLowerCase()) ?? 0) > 1 ? relativePath(dir, f).replace(MD_EXT, "") : name;
    return { label, type: "link-md", boost: -Math.min(40, depth(relativePath(dir, f))), apply: applyWith(label, "]]"), info: infoOf(f) };
  });
  if (!options.length) return null;
  return { from: ctx.pos - typed.length, options, validFor: /^[^[\]|#\n]*$/ };
}
