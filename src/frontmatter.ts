// YAML front matter, shown as a collapsed block at the top of the document
// instead of leaking into it as text. Only the flat shapes that real front
// matter uses are parsed (key: value, key: [a, b], key followed by "- item"
// lines, quoted strings); anything else is shown verbatim.

import { t } from "./i18n";

export type FrontMatterValue = string | string[];
export type FrontMatterEntry = [key: string, value: FrontMatterValue];

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
};

// null: not a flat document (nested maps, multi-line scalars, odd syntax)
export function parse(yaml: string): FrontMatterEntry[] | null {
  const entries: FrontMatterEntry[] = [];
  const lines = yaml.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) {
      i++;
      continue;
    }
    const m = /^([A-Za-z0-9_.-]+)\s*:(.*)$/.exec(line);
    if (!m) return null;
    const key = m[1];
    const rest = m[2].trim();
    i++;
    if (rest === "" || rest === "|" || rest === ">") {
      // a block: either "- item" lines, or something we don't do
      const items: string[] = [];
      while (i < lines.length && /^\s+-\s*/.test(lines[i])) {
        items.push(unquote(lines[i].replace(/^\s+-\s*/, "")));
        i++;
      }
      if (items.length === 0) return null;
      entries.push([key, items]);
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      const inner = rest.slice(1, -1).trim();
      entries.push([key, inner ? inner.split(",").map(unquote) : []]);
    } else if (rest.startsWith("{")) {
      return null;
    } else {
      entries.push([key, unquote(rest.replace(/\s+#.*$/, ""))]);
    }
  }
  return entries;
}

/** The <details> block that replaces the front matter in the rendered article. */
export function build(yaml: string): HTMLElement {
  const details = document.createElement("details");
  details.className = "front-matter";
  details.dataset.sourceLine = "0";
  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.className = "front-matter-label";
  label.textContent = t("render.frontMatter");
  summary.append(label);
  details.append(summary);

  const entries = parse(yaml);
  if (entries && entries.length > 0) {
    const keys = document.createElement("span");
    keys.className = "front-matter-keys";
    keys.textContent = entries.map(([k]) => k).join(" · ");
    summary.append(keys);
    const table = document.createElement("table");
    for (const [k, v] of entries) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.textContent = k;
      const td = document.createElement("td");
      if (Array.isArray(v)) {
        for (const item of v) {
          const chip = document.createElement("span");
          chip.className = "front-matter-chip";
          chip.textContent = item;
          td.append(chip);
        }
      } else {
        td.textContent = v;
      }
      tr.append(th, td);
      table.append(tr);
    }
    details.append(table);
  } else {
    const pre = document.createElement("pre");
    pre.textContent = yaml.trim();
    details.append(pre);
  }
  return details;
}
