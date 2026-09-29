// The format bar above the editor: inline formats, lists, a heading picker
// and an Insert menu. Every button runs a command from editCommands.ts, the
// same ones behind the keyboard shortcuts and the "/" menu.
import { commandById, iconHtml } from "./editCommands";

const GROUPS: string[][] = [
  ["bold", "italic", "strike", "code", "link"],
  ["bullet", "ordered", "task", "quote"],
];
const HEADINGS = ["paragraph", "h1", "h2", "h3"];
const INSERTS: [id: string, hint: string][] = [
  ["table", "3 columns, 2 rows"],
  ["diagram", "Mermaid flowchart"],
  ["math", "KaTeX formula block"],
  ["codeblock", "Fenced code"],
  ["note", "Highlighted information"],
  ["tip", "A helpful suggestion"],
  ["warning", "Something to watch out for"],
  ["divider", "Horizontal rule"],
];
const CHEVRON =
  '<svg class="fb-chevron" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>';
const PLUS =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';

function tip(id: string): string {
  const c = commandById.get(id)!;
  return c.shortcut ? `${c.label} (${c.shortcut})` : c.label;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, html = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  e.innerHTML = html;
  return e;
}

export function mountFormatBar(bar: HTMLElement, run: (id: string) => void): (active: Set<string>) => void {
  bar.replaceChildren();
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Formatting");
  const buttons = new Map<string, HTMLButtonElement>();
  const menus: HTMLElement[] = [];

  const closeMenus = () => {
    for (const m of menus) m.hidden = true;
    bar.querySelectorAll("[aria-expanded]").forEach((b) => b.setAttribute("aria-expanded", "false"));
  };

  // a dropdown button plus its menu (appended to <body>, positioned on open)
  const dropdown = (btn: HTMLButtonElement, items: [id: string, hint: string][], cls: string) => {
    const menu = el("div", `menu fb-menu ${cls}`);
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    for (const [id, hint] of items) {
      const c = commandById.get(id)!;
      const item = el(
        "button",
        "menu-item fb-menu-item",
        `<span class="fb-menu-icon">${iconHtml(c.icon, 15)}</span>` +
          `<span class="fb-menu-text"><span class="menu-title">${c.label}</span>` +
          (hint ? `<span class="menu-hint">${hint}</span>` : "") +
          `</span>` +
          (c.shortcut ? `<kbd class="fb-menu-kbd">${c.shortcut}</kbd>` : ""),
      );
      item.type = "button";
      item.dataset.cmd = id;
      item.setAttribute("role", "menuitem");
      menu.append(item);
    }
    menu.addEventListener("mousedown", (e) => e.preventDefault()); // keep the editor selection
    menu.addEventListener("click", (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>("[data-cmd]")?.dataset.cmd;
      if (!id) return;
      closeMenus();
      run(id);
    });
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll<HTMLButtonElement>(".menu-item")];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = (i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next].focus();
      } else if (e.key === "Escape") {
        e.stopPropagation();
        closeMenus();
        btn.focus();
      }
    });
    document.body.append(menu);
    menus.push(menu);

    btn.setAttribute("aria-haspopup", "menu");
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = !menu.hidden;
      closeMenus();
      if (wasOpen) return;
      const r = btn.getBoundingClientRect();
      menu.style.top = `${r.bottom + 6}px`;
      menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 280))}px`;
      menu.style.right = "auto";
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      // keyboard users land in the menu; mouse users keep their caret
      if (e.detail === 0) menu.querySelector<HTMLButtonElement>(".menu-item")?.focus();
    });
  };

  // heading picker: shows the current block type
  const headingBtn = el("button", "fb-btn fb-heading", `<span class="fb-heading-label">Text</span>${CHEVRON}`);
  headingBtn.type = "button";
  headingBtn.title = "Text style";
  dropdown(
    headingBtn,
    HEADINGS.map((id) => [id, ""]),
    "fb-heading-menu",
  );
  bar.append(headingBtn);

  for (const group of GROUPS) {
    bar.append(el("span", "fb-sep"));
    for (const id of group) {
      const c = commandById.get(id)!;
      const b = el("button", "fb-btn", iconHtml(c.icon, 16));
      b.type = "button";
      b.dataset.cmd = id;
      b.title = tip(id);
      b.setAttribute("aria-label", c.label);
      b.setAttribute("aria-pressed", "false");
      buttons.set(id, b);
      bar.append(b);
    }
  }

  bar.append(el("span", "fb-sep"));
  const insertBtn = el("button", "fb-btn fb-insert", `${PLUS}<span>Insert</span>${CHEVRON}`);
  insertBtn.type = "button";
  insertBtn.title = "Insert a block — or type / at the start of a line";
  dropdown(insertBtn, INSERTS, "fb-insert-menu");
  bar.append(insertBtn);

  bar.append(el("span", "fb-spacer"));
  bar.append(el("span", "fb-hint", "Type <kbd>/</kbd> for blocks"));

  // buttons must not take the focus: the command acts on the editor selection
  bar.addEventListener("mousedown", (e) => {
    if ((e.target as HTMLElement).closest("button")) e.preventDefault();
  });
  bar.addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".fb-btn[data-cmd]")?.dataset.cmd;
    if (id) run(id);
  });
  document.addEventListener("click", (e) => {
    if (!menus.some((m) => !m.hidden)) return;
    const t = e.target as Node;
    if (!menus.some((m) => m.contains(t))) closeMenus();
  });
  window.addEventListener("resize", closeMenus);

  const headingLabel = headingBtn.querySelector<HTMLElement>(".fb-heading-label")!;
  const headingMenu = menus[0];
  return (active) => {
    for (const [id, b] of buttons) b.setAttribute("aria-pressed", String(active.has(id)));
    const h = ["h1", "h2", "h3"].find((id) => active.has(id));
    headingLabel.textContent = h ? commandById.get(h)!.label : "Text";
    headingBtn.classList.toggle("is-active", !!h);
    for (const item of headingMenu.querySelectorAll<HTMLElement>("[data-cmd]")) {
      item.classList.toggle("is-current", item.dataset.cmd === (h ?? "paragraph"));
    }
  };
}
