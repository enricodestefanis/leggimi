// The tab strip in the toolbar: the tabs as wide as their names, a + after
// the last one, the list of every tab when they run over, a card with the
// folder and the reading time under the pointer, the right-click menus, and
// dragging: along the strip to reorder, off it to tear the tab out into a
// window of its own, and (the only tab) to carry the whole window, which can
// then join another window's strip. What a tab is and what moving it means
// stays in main.ts (the StripHost); this module draws and listens.

import { getCurrentWindow } from "@tauri-apps/api/window";
import * as contextMenu from "../contextMenu";
import { setTitle, t } from "../i18n";
import * as session from "./session";
import type { Tab } from "./session";
import type { TabHover } from "./contract";

export interface StripHost {
  activate(tab: Tab): void;
  /** with the questions about unsaved edits; `pointer`: the close button or the middle button */
  close(tab: Tab, opts?: { pointer?: boolean }): void;
  closeOthers(tab: Tab): void;
  closeRight(tab: Tab): void;
  newTab(where: "end" | "after"): void;
  reopen(): void;
  canReopen(): boolean;
  moveToNewWindow(tab: Tab): void;
  reveal(path: string): void;
  copyPath(path: string): void;
  /** the order changed (a drag along the strip) */
  reordered(): void;
  /** a tab pulled off the strip: it leaves for a window of its own, born under the pointer */
  tearOff(tab: Tab, at: { x: number; y: number }): void;
  /** the only tab dragged: the window goes with it (and may join another one) */
  dragWindow(tab: Tab): void;
  /** nothing may move while a PDF is being made of the tab in front */
  busy(): boolean;
}

// a tab comes off the strip this far above or below it, or past the window's sides
const DETACH = 36;

const svg = (paths: string, size: number, stroke = 2): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON = {
  doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  home: '<path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  down: '<polyline points="6 9 12 15 18 9"/>',
  reopen: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  window: '<rect x="2" y="3" width="20" height="18" rx="2"/><line x1="2" y1="8" x2="22" y2="8"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
};

const fileName = (p: string): string => p.split(/[\\/]/).pop() ?? p;
// a shortcut in the words of the interface ("Strg+Umschalt+T" in German)
const keyLabel = (combo: string): string =>
  combo
    .split("+")
    .map((k) => (k === "Ctrl" ? t("key.ctrl") : k === "Shift" ? t("key.shift") : k))
    .join("+");
const baseName = (p: string): string => fileName(p).replace(/\.(md|markdown|mdown|mkdn?|mdwn|markdn|mdtxt)$/i, "");
const folderOf = (p: string): string => p.slice(0, Math.max(0, p.length - fileName(p).length - 1));

let host: StripHost;
const bar = document.createElement("div");
const strip = document.createElement("div");
const btnNew = document.createElement("button");
const btnList = document.createElement("button");
const fill = document.createElement("div");
const card = document.createElement("div");
const els = new Map<number, HTMLElement>();
let ghost: HTMLElement | null = null;
let frozen = false;

const tabOf = (el: EventTarget | null): Tab | undefined => {
  const id = Number((el as HTMLElement | null)?.closest<HTMLElement>(".tab")?.dataset.id);
  return session.byId(id);
};

export function init(h: StripHost, parent: HTMLElement, before: Element | null): void {
  host = h;
  bar.id = "tabbar";
  strip.className = "tabs";
  strip.setAttribute("role", "tablist");
  strip.setAttribute("aria-label", t("tab.list"));

  btnNew.type = "button";
  btnNew.className = "tab-tool tab-new";
  setTitle(btnNew, t("tab.newTabHint"));
  btnNew.innerHTML = svg(ICON.plus, 16);
  btnNew.addEventListener("click", () => host.newTab("end"));

  btnList.type = "button";
  btnList.className = "tab-tool tab-list";
  setTitle(btnList, t("tab.allTabs"));
  btnList.setAttribute("aria-haspopup", "menu");
  btnList.hidden = true;
  btnList.innerHTML = svg(ICON.down, 16);
  btnList.addEventListener("click", () => openTabList());

  // the + rides after the last tab, inside the strip: the strip takes the free
  // width (sized from its tabs' content it would be too narrow), and when the
  // tabs run over, the + stays in sight at its right edge
  const newWrap = document.createElement("div");
  newWrap.className = "tab-new-wrap";
  newWrap.append(btnNew);
  strip.append(newWrap);
  // a strip to grab the window by, even when the tabs fill the toolbar
  fill.className = "tabbar-fill";
  bar.append(strip, btnList, fill);
  parent.insertBefore(bar, before);

  card.className = "tab-card";
  card.hidden = true;
  document.body.append(card);

  wirePointer();
  sizes.observe(bar);
  stripSizes.observe(strip);
}

/** The strip's rectangle in the page (CSS pixels): Rust needs it to tell when a window is dropped on it. */
export function rect(): DOMRect {
  return strip.getBoundingClientRect();
}

export function render(added?: Tab): void {
  // the ghost of an incoming tab steps out while the tabs take their order
  const g = ghost;
  g?.remove();
  let prev: HTMLElement | null = null;
  for (const tab of session.tabs) {
    let el = els.get(tab.id);
    if (!el) {
      el = createTab(tab);
      els.set(tab.id, el);
      sizes.observe(el);
      if (tab === added) flash(el, "opening", "tab-in");
    }
    paint(tab, el);
    const at: Element | null = prev ? prev.nextElementSibling : strip.firstElementChild;
    if (at !== el) strip.insertBefore(el, at);
    prev = el;
  }
  if (g) placeGhost(g, ghostIndex);
  bar.classList.toggle("single", session.live().length === 1);
  scheduleOverflow();
}

function createTab(tab: Tab): HTMLElement {
  const el = document.createElement("div");
  el.className = "tab";
  el.dataset.id = String(tab.id);
  el.setAttribute("role", "tab");
  el.setAttribute("aria-controls", "shell");
  el.innerHTML =
    '<span class="tab-icon" aria-hidden="true"></span>' +
    '<span class="tab-title"></span>' +
    '<button class="tab-close" type="button" tabindex="-1">' +
    `${svg(ICON.close, 13, 2.2)}<span class="tab-dot"></span><span class="tab-saved"></span></button>`;
  setTitle(el.querySelector(".tab-close")!, t("tab.close"));
  return el;
}

function paint(tab: Tab, el: HTMLElement): void {
  const isActive = session.hasActive() && tab === session.active();
  el.classList.toggle("active", isActive);
  el.classList.toggle("dirty", tab.dirty);
  // typing again right after Ctrl+S: the dot comes back at once, as in 1.15
  if (tab.dirty) el.classList.remove("saved");
  // carried off to another window: its place closes up until that window has it
  el.classList.toggle("detached", tab.leaving);
  el.classList.toggle("home", tab.path === null);
  el.setAttribute("aria-selected", String(isActive));
  el.tabIndex = isActive ? 0 : -1;
  const title = tab.path ? baseName(tab.path) : t("tab.newTab");
  const titleEl = el.querySelector<HTMLElement>(".tab-title")!;
  if (titleEl.textContent !== title) titleEl.textContent = title;
  el.setAttribute("aria-label", tab.path ? fileName(tab.path) : t("tab.newTab"));
  const icon = tab.path ? "doc" : "home";
  const iconEl = el.querySelector<HTMLElement>(".tab-icon")!;
  if (iconEl.dataset.icon !== icon) {
    iconEl.dataset.icon = icon;
    iconEl.innerHTML = svg(ICON[icon], 14);
  }
  if (tab.closing && !el.classList.contains("closing")) {
    el.style.flex = "";
    el.classList.add("closing");
    let gone = false;
    const done = (): void => {
      if (gone) return;
      gone = true;
      session.remove(tab);
      els.delete(tab.id);
      el.remove();
      updateOverflow();
    };
    el.addEventListener("transitionend", (e) => {
      if (e.target === el && e.propertyName === "flex-basis") done();
    });
    setTimeout(done, 260);
  }
}

// a class that lasts as long as its animation (a tab can run two at once)
function flash(el: HTMLElement, cls: string, animation: string): void {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  const done = (e: AnimationEvent): void => {
    if (e.animationName !== animation) return;
    el.classList.remove(cls);
    el.removeEventListener("animationend", done);
  };
  el.addEventListener("animationend", done);
}

/** A tab opened behind the one in front lights up for a moment, so the eye finds where it went. */
export function pulse(tab: Tab): void {
  const el = els.get(tab.id);
  if (!el) return;
  flash(el, "pulse", "tab-pulse");
  revealTab(tab);
}

const savedTimers = new WeakMap<HTMLElement, number>();

/** Ctrl+S answered: the tab's dot turns into a check for a moment (it stays, without animations, as long). */
export function flashSaved(tab: Tab): void {
  const el = els.get(tab.id);
  if (!el) return;
  clearTimeout(savedTimers.get(el));
  el.classList.remove("saved");
  void el.offsetWidth;
  el.classList.add("saved");
  savedTimers.set(
    el,
    window.setTimeout(() => el.classList.remove("saved"), 1400),
  );
}

/** Holds the tabs' widths while the pointer stays on the strip, so the next close button comes under it. */
export function freezeWidths(): void {
  if (session.live().length < 3) return;
  for (const x of session.live()) {
    const el = els.get(x.id);
    if (el) el.style.flex = `0 0 ${el.getBoundingClientRect().width}px`;
  }
  frozen = true;
}

function unfreezeWidths(): void {
  if (!frozen) return;
  frozen = false;
  for (const el of els.values()) el.style.flex = "";
}

// the strip and every tab: a tab growing in or out, the window resized
let overflowFrame = 0;
const scheduleOverflow = (): void => {
  cancelAnimationFrame(overflowFrame);
  overflowFrame = requestAnimationFrame(updateOverflow);
};
const sizes = new ResizeObserver(scheduleOverflow);

// the strip narrower (a window made smaller): the tab in front stays in sight
let stripWidth = 0;
const stripSizes = new ResizeObserver(() => {
  const w = strip.clientWidth;
  if (w < stripWidth && session.hasActive()) requestAnimationFrame(() => revealTab(session.active(), true));
  stripWidth = w;
});

function updateOverflow(): void {
  const over = strip.scrollWidth > strip.clientWidth + 1;
  bar.classList.toggle("overflow", over);
  bar.classList.toggle("fade-start", over && strip.scrollLeft > 1);
  bar.classList.toggle("fade-end", over && strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1);
  btnList.hidden = !over;
  for (const title of strip.querySelectorAll<HTMLElement>(".tab-title")) {
    title.classList.toggle("clipped", title.scrollWidth > title.clientWidth + 0.5);
  }
}

function revealTab(tab: Tab, instant = false): void {
  const el = els.get(tab.id);
  if (!el) return;
  const r = el.getBoundingClientRect();
  const sr = strip.getBoundingClientRect();
  // clear of the fade on the left and of the + on the right; a tab wider
  // than the room left shows its start (its icon and the start of its name),
  // and a strip with no room for the fade (a narrow window) has none (tabs.css)
  const fade = sr.width >= r.width + 48 ? 24 : 0;
  const right = sr.right - (strip.querySelector(".tab-new-wrap")?.getBoundingClientRect().width ?? 0);
  const behavior: ScrollBehavior = instant ? "instant" : "smooth";
  if (r.left < sr.left + fade) strip.scrollBy({ left: r.left - sr.left - fade, behavior });
  else if (r.right > right) strip.scrollBy({ left: Math.min(r.right - right + 8, r.left - sr.left - fade), behavior });
}

/** The tab in front in sight: now, and again once a tab growing in has its full width. */
export function revealActive(): void {
  requestAnimationFrame(() => session.hasActive() && revealTab(session.active()));
  setTimeout(() => session.hasActive() && revealTab(session.active()), 240);
}

/** The keyboard focus is on the strip (a tab was clicked or reached with the keys). */
export const hasFocus = (): boolean => bar.contains(document.activeElement);

/** The keyboard focus onto the tab in front (F6-like arrival from the keys). */
export function focusActive(): void {
  if (session.hasActive()) els.get(session.active().id)?.focus();
}

/* ---- pointer and keys on the strip ---- */

interface Drag {
  tab: Tab;
  el: HTMLElement;
  pointerId: number;
  startX: number;
  startY: number;
  /** where the press was inside the tab, so a torn-off window comes up with the tab under the pointer */
  grabX: number;
  grabY: number;
  started: boolean;
  slots: { tab: Tab; el: HTMLElement; left: number; width: number }[];
  from: number;
  to: number;
  shift: number;
}
let drag: Drag | null = null;

function wirePointer(): void {
  strip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest(".tab-close")) return;
    const tab = tabOf(target);
    if (!tab || tab.closing) return;
    hideCard();
    if (host.busy()) return;
    // a browser brings a tab forward on the press, not on the release
    host.activate(tab);
    const el = els.get(tab.id)!;
    const r = el.getBoundingClientRect();
    drag = {
      tab,
      el,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      grabX: e.clientX - r.left,
      grabY: e.clientY - r.top,
      started: false,
      slots: [],
      from: 0,
      to: 0,
      shift: 0,
    };
  });
  window.addEventListener("pointermove", onDragMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", () => cancelDrag());

  strip.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(".tab-close");
    const tab = tabOf(btn);
    if (btn && tab) host.close(tab, { pointer: true });
  });
  // the middle button closes, without autoscroll
  strip.addEventListener("mousedown", (e) => {
    if (e.button === 1) e.preventDefault();
  });
  strip.addEventListener("auxclick", (e) => {
    const tab = tabOf(e.target);
    if (e.button === 1 && tab) host.close(tab, { pointer: true });
  });
  bar.addEventListener("pointerleave", unfreezeWidths);
  bar.addEventListener("contextmenu", (e) => {
    // the empty end of the bar is title bar: its menu is the window's (chrome.ts)
    if ((e.target as HTMLElement).closest(".tabbar-fill")) return;
    e.preventDefault();
    const tab = tabOf(e.target);
    hideCard();
    const keyboard = e.button !== 2;
    const r = (tab ? els.get(tab.id) : btnNew)?.getBoundingClientRect();
    const x = keyboard && r ? r.left + 12 : e.clientX;
    const y = keyboard && r ? r.bottom + 2 : e.clientY;
    contextMenu.openAt(tab ? tabMenu(tab) : stripMenu(), x, y, { keyboard });
  });
  strip.addEventListener(
    "wheel",
    (e) => {
      if (strip.scrollWidth <= strip.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  strip.addEventListener("scroll", () => {
    hideCard();
    updateOverflow();
  });

  // the hover card: after a pause on a tab, then at once from tab to tab
  strip.addEventListener("pointerover", (e) => {
    const tab = tabOf(e.target);
    if (!tab || drag?.started) return;
    scheduleCard(tab);
  });
  strip.addEventListener("pointerleave", () => hideCard(true));

  // arrows move along the tabs, Enter or Space shows one, Delete closes it
  strip.addEventListener("keydown", (e) => {
    const tab = tabOf(e.target);
    if (!tab) return;
    const list = session.live();
    const i = list.indexOf(tab);
    let to: Tab | undefined;
    if (e.key === "ArrowRight") to = list[(i + 1) % list.length];
    else if (e.key === "ArrowLeft") to = list[(i - 1 + list.length) % list.length];
    else if (e.key === "Home") to = list[0];
    else if (e.key === "End") to = list[list.length - 1];
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      host.activate(tab);
      return;
    } else if (e.key === "Delete") {
      e.preventDefault();
      host.close(tab);
      return;
    }
    if (!to) return;
    e.preventDefault();
    for (const x of list) {
      const el = els.get(x.id);
      if (el) el.tabIndex = x === to ? 0 : -1;
    }
    els.get(to.id)?.focus();
    revealTab(to);
  });
}

// off the strip, up or down, or past the window's sides
function farFromStrip(cx: number, cy: number): boolean {
  const r = bar.getBoundingClientRect();
  return cy < r.top - DETACH || cy > r.bottom + DETACH || cx < -DETACH || cx > innerWidth + DETACH;
}

function onDragMove(e: PointerEvent): void {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  if (!d.started) {
    if (Math.abs(e.clientX - d.startX) < 5 && Math.abs(e.clientY - d.startY) < 5) return;
    // the only tab: dragging it carries the window, as its title bar would
    if (session.live().length === 1) {
      drag = null;
      host.dragWindow(d.tab);
      return;
    }
    beginDrag(d);
  }
  if (farFromStrip(e.clientX, e.clientY)) {
    // pulled off: the tab leaves for a window of its own, born under the
    // pointer, which then follows it (and can join another window's strip)
    tearOff(d, e);
    return;
  }
  moveDrag(d, e.clientX - d.startX);
}

function beginDrag(d: Drag): void {
  d.started = true;
  hideCard();
  measure(d);
  // the moves keep coming outside the window, for as long as the button is down
  try {
    d.el.setPointerCapture(d.pointerId);
  } catch {
    /* the pointer is gone already */
  }
  bar.classList.add("reordering");
  d.el.classList.add("dragging");
}

function measure(d: Drag): void {
  const list = session.live();
  d.slots = list.map((tab) => {
    const el = els.get(tab.id)!;
    const r = el.getBoundingClientRect();
    return { tab, el, left: r.left, width: r.width };
  });
  d.from = d.to = list.indexOf(d.tab);
  const gap = d.slots.length > 1 ? d.slots[1].left - (d.slots[0].left + d.slots[0].width) : 0;
  d.shift = d.slots[d.from].width + gap;
}

function moveDrag(d: Drag, dx: number): void {
  const { slots, from } = d;
  const me = slots[from];
  // inside the strip: from the first tab's left edge to the last one's right
  const min = slots[0].left - me.left;
  const max = slots[slots.length - 1].left + slots[slots.length - 1].width - (me.left + me.width);
  const x = Math.max(min, Math.min(max, dx));
  d.el.style.transform = `translateX(${x}px)`;
  // a neighbour gives way once the edge of the tab in hand passes its middle:
  // the centre could never pass the middle of the first or last tab, since
  // the strip's ends stop it first
  const left = me.left + x;
  const right = left + me.width;
  let to = from;
  for (let i = from + 1; i < slots.length; i++) if (right > slots[i].left + slots[i].width / 2) to = i;
  for (let i = from - 1; i >= 0; i--) if (left < slots[i].left + slots[i].width / 2) to = i;
  d.to = to;
  slots.forEach((slot, i) => {
    if (i === from) return;
    const shift = i > from && i <= to ? -d.shift : i < from && i >= to ? d.shift : 0;
    slot.el.style.transform = shift ? `translateX(${shift}px)` : "";
  });
}

function settle(d: Drag): void {
  for (const slot of d.slots) {
    slot.el.style.transition = "none";
    slot.el.style.transform = "";
  }
  void d.el.offsetWidth;
  for (const slot of d.slots) slot.el.style.transition = "";
  d.el.classList.remove("dragging");
  bar.classList.remove("reordering");
}

function tearOff(d: Drag, e: PointerEvent): void {
  drag = null;
  settle(d);
  // the window is placed so the tab sits under the pointer, as it was grabbed
  const dpr = devicePixelRatio;
  const at = { x: Math.round(e.screenX * dpr - (d.grabX + 48) * dpr), y: Math.round(e.screenY * dpr - (d.grabY + 8) * dpr) };
  host.tearOff(d.tab, at);
}

function endDrag(e: PointerEvent): void {
  const d = drag;
  if (!d || e.pointerId !== d.pointerId) return;
  drag = null;
  if (!d.started) return;
  if (farFromStrip(e.clientX, e.clientY)) {
    tearOff(d, e);
    return;
  }
  const before = d.el.getBoundingClientRect().left;
  for (const slot of d.slots) {
    slot.el.style.transition = "none";
    slot.el.style.transform = "";
  }
  if (d.to !== d.from) {
    session.move(d.tab, d.to);
    render();
    host.reordered();
  }
  // the dropped tab glides from where the pointer left it into its place
  const after = d.el.getBoundingClientRect().left;
  d.el.style.transform = `translateX(${before - after}px)`;
  void d.el.offsetWidth;
  for (const slot of d.slots) slot.el.style.transition = "";
  d.el.classList.remove("dragging");
  bar.classList.remove("reordering");
  d.el.style.transform = "";
}

/** Escape, or the pointer taken away: the tab goes back where it was. */
export function cancelDrag(): boolean {
  const d = drag;
  drag = null;
  if (!d?.started) return false;
  settle(d);
  try {
    d.el.releasePointerCapture(d.pointerId);
  } catch {
    /* released already */
  }
  return true;
}

export const dragging = (): boolean => drag?.started ?? false;

/* ---- a tab carried over this window from another one ---- */

let origin: Promise<{ x: number; y: number }> | null = null;
let originAt = 0;

// the pointer's screen position (physical pixels) as x in this page
async function clientX(screenX: number): Promise<number> {
  if (!origin || performance.now() - originAt > 1000) {
    originAt = performance.now();
    origin = getCurrentWindow()
      .innerPosition()
      .then((p) => ({ x: p.x, y: p.y }))
      .catch(() => ({ x: 0, y: 0 }));
  }
  const o = await origin;
  return (screenX - o.x) / devicePixelRatio;
}

// the tabs left of x (measured as if the ghost were not there)
function indexAt(x: number): number {
  const gw = ghost ? ghost.getBoundingClientRect().width : 0;
  let i = 0;
  let afterGhost = false;
  for (const el of strip.children) {
    if (el === ghost) {
      afterGhost = true;
      continue;
    }
    if (!el.classList.contains("tab") || el.classList.contains("closing") || el.classList.contains("detached")) continue;
    const r = el.getBoundingClientRect();
    if (x > r.left + r.width / 2 - (afterGhost ? gw : 0)) i++;
  }
  return i;
}

/** Where a tab let go at this screen x lands among the tabs. */
export async function dropIndex(screenX: number): Promise<number> {
  return indexAt(await clientX(screenX));
}

/** Where something let go at this x of the page lands among the tabs (files dropped on the strip). */
export const indexAtClient = (x: number): number => indexAt(x);

/** A tab from another window hovers over this one: the strip opens a place for it. */
export async function showGhost(h: TabHover): Promise<void> {
  const x = await clientX(h.x);
  if (!ghost) {
    ghost = document.createElement("div");
    ghost.className = "tab ghost";
    ghost.setAttribute("aria-hidden", "true");
    ghost.innerHTML = `<span class="tab-icon">${svg(h.path ? ICON.doc : ICON.home, 14)}</span><span class="tab-title"></span>`;
    flash(ghost, "opening", "tab-in");
  }
  ghost.querySelector(".tab-title")!.textContent = h.path ? baseName(h.path) : h.title || t("tab.newTab");
  ghostIndex = indexAt(x);
  placeGhost(ghost, ghostIndex);
  scheduleOverflow();
}

let ghostIndex = 0;

function placeGhost(g: HTMLElement, i: number): void {
  const list = session.live();
  const before = (i < list.length ? els.get(list[i].id) : null) ?? strip.querySelector(".tab-new-wrap");
  if (g.nextElementSibling !== before || !g.isConnected) strip.insertBefore(g, before);
}

export function hideGhost(): void {
  ghost?.remove();
  ghost = null;
  origin = null;
  scheduleOverflow();
}

/* ---- menus and the hover card ---- */

function tabMenu(tab: Tab): contextMenu.MenuSpec {
  const list = session.live();
  const path = tab.path;
  return [
    { label: t("tab.newTab"), icon: ICON.plus, kbd: keyLabel("Ctrl+T"), run: () => host.newTab("after") },
    "sep",
    list.length > 1 && { label: t("tab.moveToWindow"), icon: ICON.window, run: () => host.moveToNewWindow(tab) },
    path !== null && { label: t("file.copyPath"), icon: ICON.copy, run: () => host.copyPath(path) },
    path !== null && { label: t("file.reveal"), icon: ICON.folder, run: () => host.reveal(path) },
    "sep",
    { label: t("tab.closeTab"), icon: ICON.close, kbd: keyLabel("Ctrl+W"), run: () => host.close(tab) },
    list.length > 1 && { label: t("tab.closeOthers"), run: () => host.closeOthers(tab) },
    list.indexOf(tab) < list.length - 1 && { label: t("tab.closeRight"), run: () => host.closeRight(tab) },
    "sep",
    host.canReopen() && { label: t("tab.reopen"), icon: ICON.reopen, kbd: keyLabel("Ctrl+Shift+T"), run: () => host.reopen() },
  ];
}

function stripMenu(): contextMenu.MenuSpec {
  return [
    { label: t("tab.newTab"), icon: ICON.plus, kbd: keyLabel("Ctrl+T"), run: () => host.newTab("end") },
    host.canReopen() && { label: t("tab.reopen"), icon: ICON.reopen, kbd: keyLabel("Ctrl+Shift+T"), run: () => host.reopen() },
  ];
}

function openTabList(): void {
  const r = btnList.getBoundingClientRect();
  const front = session.hasActive() ? session.active() : null;
  contextMenu.openAt(
    [
      ...session.live().map((tab) => ({
        label: tab.path ? fileName(tab.path) : t("tab.newTab"),
        hint: tab.path ? folderOf(tab.path) : undefined,
        icon: tab.path ? ICON.doc : ICON.home,
        kbd: tab === front ? "●" : undefined,
        run: () => host.activate(tab),
      })),
      "sep",
      // a narrow window has no room for the + (tabs.css)
      { label: t("tab.newTab"), icon: ICON.plus, kbd: keyLabel("Ctrl+T"), run: () => host.newTab("end") },
    ],
    r.left,
    r.bottom + 4,
  );
}

let cardTimer: number | undefined;
let cardFor: Tab | null = null;

function scheduleCard(tab: Tab): void {
  clearTimeout(cardTimer);
  if (cardFor === tab && !card.hidden) return;
  // from one tab to the next the card follows at once, as in Edge
  cardTimer = window.setTimeout(() => showCard(tab), card.hidden ? 550 : 0);
}

function showCard(tab: Tab): void {
  const el = els.get(tab.id);
  if (!el || tab.closing || drag?.started || contextMenu.isOpen()) return;
  cardFor = tab;
  card.replaceChildren();
  const name = document.createElement("div");
  name.className = "tab-card-name";
  name.textContent = tab.path ? fileName(tab.path) : t("tab.newTab");
  const where = document.createElement("div");
  where.className = "tab-card-path";
  where.textContent = tab.path ? folderOf(tab.path) : t("tab.startPage");
  card.append(name, where);
  const metaText = tab.dirty ? t("tab.unsaved") : tab.meta;
  if (tab.path && metaText) {
    const meta = document.createElement("div");
    meta.className = tab.dirty ? "tab-card-meta unsaved" : "tab-card-meta";
    meta.textContent = metaText;
    card.append(meta);
  }
  card.hidden = false;
  const r = el.getBoundingClientRect();
  const w = card.offsetWidth;
  card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  card.style.top = `${r.bottom + 6}px`;
  card.classList.remove("card-in");
  void card.offsetWidth;
  card.classList.add("card-in");
}

export function hideCard(soon = false): void {
  clearTimeout(cardTimer);
  if (soon) {
    cardTimer = window.setTimeout(() => hideCard(), 80);
    return;
  }
  card.hidden = true;
  cardFor = null;
}
