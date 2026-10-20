// Right-click menus, built on the fly: the reading menu of the article and the
// file menu of the tree and the title. One element, reused; it opens at the
// pointer, flips at the window edges and takes the arrow keys like the format
// bar's menus. It replaces WebView2's own menu, whose Back, Refresh, Save as
// and Share act on the app's page rather than on the document.

export interface MenuItem {
  label: string;
  /** inner SVG markup (paths), drawn at 16 px in the toolbar's stroke style */
  icon?: string;
  /** the shortcut, shown on the right */
  kbd?: string;
  /** a muted second line */
  hint?: string;
  run: () => void;
}

/** "sep" is a separator; falsy entries are skipped, so items can be conditional */
export type MenuSpec = (MenuItem | "sep" | null | undefined | false)[];

const EDGE = 8; // the menu keeps this far from the window edges

let menu: HTMLDivElement | null = null;
let actions: (() => void)[] = [];
let returnFocus: HTMLElement | null = null;

const svg = (paths: string): string =>
  `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export function isOpen(): boolean {
  return !!menu && !menu.hidden;
}

/** Closes the menu; `restoreFocus` puts the focus back where it was before. */
export function close(restoreFocus = false): void {
  if (!menu || menu.hidden) return;
  if (menu.matches(":popover-open")) menu.hidePopover();
  menu.hidden = true;
  menu.replaceChildren();
  actions = [];
  const back = returnFocus;
  returnFocus = null;
  if (restoreFocus && back?.isConnected) back.focus({ preventScroll: true });
}

/**
 * Opens the menu with its top-left corner at (x, y), flipped to the left or
 * upwards where it would leave the window. `keyboard` (Shift+F10, the menu
 * key) also moves the focus to the first item; a pointer opening only gives
 * the menu the keys, as Windows menus do.
 */
export function openAt(spec: MenuSpec, x: number, y: number, opts: { keyboard?: boolean } = {}): void {
  const m = ensureMenu();
  close();
  // an open modal dialog (the help) makes everything outside it inert, a
  // popover above it included: the menu lives inside it then
  const host = document.querySelector("dialog:modal") ?? document.body;
  if (m.parentElement !== host) host.append(m);
  // separators only between items: none at the ends, never two in a row
  const entries: (MenuItem | "sep")[] = [];
  for (const e of spec) {
    if (!e) continue;
    if (e === "sep" && (entries.length === 0 || entries[entries.length - 1] === "sep")) continue;
    entries.push(e);
  }
  while (entries[entries.length - 1] === "sep") entries.pop();
  if (entries.length === 0) return;

  for (const e of entries) {
    if (e === "sep") {
      const sep = document.createElement("div");
      sep.className = "menu-sep";
      sep.setAttribute("role", "separator");
      m.append(sep);
      continue;
    }
    const item = document.createElement("button");
    item.type = "button";
    item.className = "menu-item ctx-item";
    item.setAttribute("role", "menuitem");
    item.tabIndex = -1;
    item.dataset.i = String(actions.length);
    actions.push(e.run);
    const icon = document.createElement("span");
    icon.className = "ctx-icon";
    if (e.icon) icon.innerHTML = svg(e.icon);
    const text = document.createElement("span");
    text.className = "ctx-text";
    const label = document.createElement("span");
    label.className = "ctx-label";
    label.textContent = e.label;
    text.append(label);
    if (e.hint) {
      const hint = document.createElement("span");
      hint.className = "ctx-hint";
      hint.textContent = e.hint;
      text.append(hint);
    }
    item.append(icon, text);
    if (e.kbd) {
      // a span: the dialogs style their own <kbd> (the menu may live in one)
      const kbd = document.createElement("span");
      kbd.className = "ctx-kbd";
      kbd.textContent = e.kbd;
      item.append(kbd);
    }
    m.append(item);
  }

  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  m.style.left = "0px";
  m.style.top = "0px";
  m.hidden = false;
  // the top layer: above the help and preview dialogs too, which are modal
  if (typeof m.showPopover === "function") m.showPopover();
  const r = m.getBoundingClientRect();
  const flipX = x + r.width > window.innerWidth - EDGE;
  const flipY = y + r.height > window.innerHeight - EDGE;
  // inside the window on every side, whatever point it was asked for
  const clamp = (v: number, size: number, room: number) => Math.max(EDGE, Math.min(v, room - size - EDGE));
  m.style.left = `${clamp(flipX ? x - r.width : x, r.width, window.innerWidth)}px`;
  m.style.top = `${clamp(flipY ? y - r.height : y, r.height, window.innerHeight)}px`;
  m.classList.toggle("flip-y", flipY);
  if (opts.keyboard) m.querySelector<HTMLButtonElement>(".ctx-item")?.focus({ preventScroll: true });
  else m.focus({ preventScroll: true });
}

function ensureMenu(): HTMLDivElement {
  if (menu) return menu;
  const m = document.createElement("div");
  m.className = "menu ctx-menu";
  m.setAttribute("role", "menu");
  m.setAttribute("popover", "manual");
  m.tabIndex = -1;
  m.hidden = true;
  menu = m;

  // a press inside must not take the selection the items act on
  m.addEventListener("mousedown", (e) => e.preventDefault());
  m.addEventListener("contextmenu", (e) => e.preventDefault());
  m.addEventListener("click", (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>(".ctx-item");
    if (!item) return;
    const run = actions[Number(item.dataset.i)];
    // focus goes back first, so an action that moves it (find bar, editor) wins
    close(true);
    run?.();
  });
  m.addEventListener("keydown", (e) => {
    const items = [...m.querySelectorAll<HTMLButtonElement>(".ctx-item")];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    switch (e.key) {
      case "ArrowDown":
        next = i < 0 ? 0 : (i + 1) % items.length;
        break;
      case "ArrowUp":
        next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      case "Escape":
      case "Tab":
        close(true);
        break;
      default:
        return; // Enter and Space click the focused button natively
    }
    e.preventDefault();
    e.stopPropagation();
    if (next >= 0) items[next]?.focus({ preventScroll: true });
  });
  document.body.append(m);

  // anything else the pointer touches, a scroll, a resize or leaving the window closes it
  document.addEventListener(
    "pointerdown",
    (e) => {
      if (isOpen() && !m.contains(e.target as Node)) close();
    },
    true,
  );
  document.addEventListener(
    "scroll",
    (e) => {
      if (!m.contains(e.target as Node)) close(); // a long menu scrolls itself
    },
    true,
  );
  window.addEventListener("resize", () => close());
  window.addEventListener("blur", () => close());
  return m;
}
