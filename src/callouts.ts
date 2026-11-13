// Callouts: GitHub's alerts (> [!NOTE]) and the callouts of Obsidian, Logseq and the other
// note-taking apps (> [!tip]- A title), shown as one of GitHub's five boxes. Any type reads:
// the known ones fall into the family they mean, an unknown one is a note. The markup is
// markdown-it-github-alerts' (1.0.1), which this replaces, so the stylesheet, print, the HTML
// export and the copies for Word know every callout: a <div> with the classes markdown-alert
// and markdown-alert-<family>, its title a <p class="markdown-alert-title"> after the family's
// octicon, and the type as written in data-callout. A title written after the marker is
// Markdown; a fold marker (- or +) is read and dropped: a callout is always shown open.

import type MarkdownIt from "markdown-it";
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs";
import type Token from "markdown-it/lib/token.mjs";

export type CalloutFamily = "note" | "tip" | "important" | "warning" | "caution";

// Obsidian's types and their aliases, by the GitHub box that says the same
const FAMILIES: Record<CalloutFamily, string[]> = {
  note: ["note", "info", "todo", "abstract", "summary", "tldr", "example", "quote", "cite"],
  tip: ["tip", "hint", "success", "check", "done"],
  important: ["important", "question", "help", "faq"],
  warning: ["warning", "attention"],
  caution: ["caution", "danger", "error", "failure", "fail", "missing", "bug"],
};

const FAMILY_OF = new Map<string, CalloutFamily>(
  (Object.keys(FAMILIES) as CalloutFamily[]).flatMap((family) => FAMILIES[family].map((type) => [type, family] as const)),
);

/** The box a callout type is shown as (lower case in, any type; unknown ones are notes). */
export const calloutFamily = (type: string): CalloutFamily => FAMILY_OF.get(type.toLowerCase()) ?? "note";

// GitHub's octicons (MIT), exactly as markdown-it-github-alerts wrote them
const ICONS: Record<CalloutFamily, string> = {
  note: '<svg class="octicon octicon-info mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 8a8 8 0 1 1 16 0A8 8 0 0 1 0 8Zm8-6.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13ZM6.5 7.75A.75.75 0 0 1 7.25 7h1a.75.75 0 0 1 .75.75v2.75h.25a.75.75 0 0 1 0 1.5h-2a.75.75 0 0 1 0-1.5h.25v-2h-.25a.75.75 0 0 1-.75-.75ZM8 6a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
  tip: '<svg class="octicon octicon-light-bulb mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M8 1.5c-2.363 0-4 1.69-4 3.75 0 .984.424 1.625.984 2.304l.214.253c.223.264.47.556.673.848.284.411.537.896.621 1.49a.75.75 0 0 1-1.484.211c-.04-.282-.163-.547-.37-.847a8.456 8.456 0 0 0-.542-.68c-.084-.1-.173-.205-.268-.32C3.201 7.75 2.5 6.766 2.5 5.25 2.5 2.31 4.863 0 8 0s5.5 2.31 5.5 5.25c0 1.516-.701 2.5-1.328 3.259-.095.115-.184.22-.268.319-.207.245-.383.453-.541.681-.208.3-.33.565-.37.847a.751.751 0 0 1-1.485-.212c.084-.593.337-1.078.621-1.489.203-.292.45-.584.673-.848.075-.088.147-.173.213-.253.561-.679.985-1.32.985-2.304 0-2.06-1.637-3.75-4-3.75ZM5.75 12h4.5a.75.75 0 0 1 0 1.5h-4.5a.75.75 0 0 1 0-1.5ZM6 15.25a.75.75 0 0 1 .75-.75h2.5a.75.75 0 0 1 0 1.5h-2.5a.75.75 0 0 1-.75-.75Z"></path></svg>',
  important: '<svg class="octicon octicon-report mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M0 1.75C0 .784.784 0 1.75 0h12.5C15.216 0 16 .784 16 1.75v9.5A1.75 1.75 0 0 1 14.25 13H8.06l-2.573 2.573A1.458 1.458 0 0 1 3 14.543V13H1.75A1.75 1.75 0 0 1 0 11.25Zm1.75-.25a.25.25 0 0 0-.25.25v9.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h6.5a.25.25 0 0 0 .25-.25v-9.5a.25.25 0 0 0-.25-.25Zm7 2.25v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 9a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
  warning: '<svg class="octicon octicon-alert mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"></path></svg>',
  caution: '<svg class="octicon octicon-stop mr-2" viewBox="0 0 16 16" version="1.1" width="16" height="16" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"></path></svg>',
};

// "[!type]" at the start of a quote's first paragraph, then an optional fold marker, then the
// title: the rest of that line. A backslash before the bracket still counts (remark writes
// one, and markdown-it-github-alerts read it). Not "[!x](…)" nor "[!x][…]": those are links.
const MARKER_RE = /^\\?\[!([\p{L}\p{N}_-]+)\]([+-]?)(?![([])([^\n\r]*)/u;

interface CalloutMeta {
  type: string;
  family: CalloutFamily;
}

interface TitleMeta {
  family: CalloutFamily;
  /** the title as plain text, or null when the title is Markdown in an inline token */
  text: string | null;
}

// the quote's own closing token: the first one back at its level
function closingOf(tokens: Token[], open: number): number {
  const level = tokens[open].level;
  for (let i = open + 1; i < tokens.length; i++) {
    if (tokens[i].type === "blockquote_close" && tokens[i].level === level) return i;
  }
  return -1;
}

function calloutRule(state: StateCore): void {
  const tokens = state.tokens;
  // outer quotes first: a callout inside a callout is met (and turned) after its parent
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== "blockquote_open") continue;
    const para = tokens[i + 1];
    const inline = tokens[i + 2];
    if (para?.type !== "paragraph_open" || inline?.type !== "inline") continue;
    const m = MARKER_RE.exec(inline.content);
    if (!m) continue;
    const close = closingOf(tokens, i);
    if (close < 0) continue;

    const type = m[1].toLowerCase();
    const family = calloutFamily(type);
    const title = m[3].trim();
    open.type = "callout_open";
    open.tag = "div";
    open.meta = { type, family } satisfies CalloutMeta;
    tokens[close].type = "callout_close";
    tokens[close].tag = "div";

    const titleOpen = new state.Token("callout_title_open", "p", 1);
    titleOpen.block = true;
    titleOpen.level = open.level + 1;
    titleOpen.meta = { family, text: title ? null : type.charAt(0).toUpperCase() + type.slice(1) } satisfies TitleMeta;
    const added: Token[] = [titleOpen];
    if (title) {
      // parsed with the rest of the document's inline text (the core "inline" rule runs next)
      const text = new state.Token("inline", "", 0);
      text.content = title;
      text.children = [];
      text.level = open.level + 2;
      added.push(text);
    }
    const titleClose = new state.Token("callout_title_close", "p", -1);
    titleClose.block = true;
    titleClose.level = open.level + 1;
    added.push(titleClose);

    // the first paragraph keeps the lines after the marker's; with none it goes (no empty <p>)
    const body = inline.content.slice(m[0].length).trimStart();
    if (body || tokens[i + 3]?.type !== "paragraph_close") {
      inline.content = body;
      tokens.splice(i + 1, 0, ...added);
    } else {
      tokens.splice(i + 1, 3, ...added);
    }
  }
}

export default function callouts(md: MarkdownIt): void {
  // where markdown-it-github-alerts ran: after the blocks, before their inline text is parsed
  md.core.ruler.after("block", "callouts", calloutRule);
  const escape = md.utils.escapeHtml;
  md.renderer.rules.callout_open = (tokens, idx) => {
    const { type, family } = tokens[idx].meta as CalloutMeta;
    return `<div class="markdown-alert markdown-alert-${family}" data-callout="${escape(type)}">`;
  };
  md.renderer.rules.callout_title_open = (tokens, idx) => {
    const { family, text } = tokens[idx].meta as TitleMeta;
    return `<p class="markdown-alert-title">${ICONS[family]}${text === null ? "" : escape(text)}`;
  };
  md.renderer.rules.callout_title_close = () => "</p>";
}
