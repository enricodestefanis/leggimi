// The UI language. Dictionaries are typed against the English one, so a
// missing or extra key is a compile error. The language is resolved when this
// module loads (localStorage `lang`, else the first supported language of the
// Windows preferred languages list, which lib.rs injects as __LEGGIMI_LANGS__),
// so every module may call t() at load time.
import en from "./locales/en";
import it from "./locales/it";
import de from "./locales/de";
import fr from "./locales/fr";
import es from "./locales/es";
import zh from "./locales/zh-CN";

export type Dict = { readonly [K in keyof typeof en]: string };
export type Lang = "en" | "it" | "de" | "fr" | "es" | "zh-CN";
export type LangPref = Lang | "auto";

export const LANGS: readonly Lang[] = ["en", "it", "de", "fr", "es", "zh-CN"];
const DICTS: Record<Lang, Dict> = { en, it, de, fr, es, "zh-CN": zh };
// The help pages are ~20 KB each and a window only ever shows one, the first
// time the help opens: each is a chunk of its own, out of the startup bundle.
// (Spelled out rather than globbed, so a missing page is a compile error.)
const HELP: Record<Lang, () => Promise<{ default: string }>> = {
  en: () => import("./locales/help/en.html?raw"),
  it: () => import("./locales/help/it.html?raw"),
  de: () => import("./locales/help/de.html?raw"),
  fr: () => import("./locales/help/fr.html?raw"),
  es: () => import("./locales/help/es.html?raw"),
  "zh-CN": () => import("./locales/help/zh-CN.html?raw"),
};
const KEY = "lang";

const isLang = (v: unknown): v is Lang => (LANGS as readonly unknown[]).includes(v);

// Windows' preferred languages (Settings > Time & language), as Store apps
// are expected to follow them; navigator.languages is only the Windows display
// language in WebView2, and the fallback in the browser harness.
function systemTags(): readonly string[] {
  const injected = (window as { __LEGGIMI_LANGS__?: unknown }).__LEGGIMI_LANGS__;
  if (Array.isArray(injected) && injected.length > 0) return injected.map(String);
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function fromSystem(): Lang {
  for (const tag of systemTags()) {
    const lower = (tag ?? "").toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    const primary = lower.split("-")[0];
    if (primary === "en") return "en";
    if (isLang(primary)) return primary;
  }
  return "en";
}

export function pref(): LangPref {
  const saved = localStorage.getItem(KEY);
  return isLang(saved) ? saved : "auto";
}

// the preference this window loaded with: another window may store a new one,
// which this one only takes when it reloads
const loadedPref = pref();
const lang: Lang = loadedPref === "auto" ? fromSystem() : loadedPref;

export function activePref(): LangPref {
  return loadedPref;
}
const dict: Dict = DICTS[lang];

export function current(): Lang {
  return lang;
}

/** Stores the choice; the caller reloads the page so every module re-reads it. */
export function setPref(next: LangPref): void {
  if (next === "auto") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, next);
}

export function t(key: keyof Dict, params?: Record<string, string | number>): string {
  let s: string = dict[key] ?? en[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

export function fmtNumber(n: number): string {
  return n.toLocaleString(lang);
}

export function fmtDate(d: Date, opts: Intl.DateTimeFormatOptions): string {
  return d.toLocaleDateString(lang, opts);
}

const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });

// "just now", "5 minutes ago", "yesterday", then a short date
export function relativeTime(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return rtf.format(0, "second").replace(/^in /, "");
  const m = Math.round(s / 60);
  if (m < 60) return rtf.format(-m, "minute");
  const h = Math.round(m / 60);
  if (h < 24) return rtf.format(-h, "hour");
  const d = Math.round(h / 24);
  if (d < 30) return rtf.format(-d, "day");
  return fmtDate(new Date(ms), { day: "numeric", month: "short" });
}

/* ---- accessible names from tooltips ---- */

// The key names a tooltip's "(…)" may use in the six languages, as
// aria-keyshortcuts spells them (the UI Events key values, with "Plus" and
// "Space" for those two keys). Letters, digits and signs stand for themselves.
const MODIFIER_KEYS = new Map([
  ["ctrl", "Control"],
  ["strg", "Control"],
  ["shift", "Shift"],
  ["umschalt", "Shift"],
  ["maj", "Shift"],
  ["mayús", "Shift"],
  ["alt", "Alt"],
]);
const NAMED_KEYS = new Map([
  ["esc", "Escape"],
  ["échap", "Escape"],
  ["enter", "Enter"],
  ["invio", "Enter"],
  ["eingabe", "Enter"],
  ["entrée", "Enter"],
  ["intro", "Enter"],
  ["space", "Space"],
  ["spazio", "Space"],
  ["leertaste", "Space"],
  ["espace", "Space"],
  ["espacio", "Space"],
  ["空格", "Space"],
  ["tab", "Tab"],
  ["+", "Plus"],
  ["−", "-"], // the minus sign of "Ctrl+−" is the hyphen key
]);

// "Ctrl+Shift+E" → "Control+Shift+E"; null when it is no key combination
// (a "(double-click to reset)" is part of the text, not a shortcut)
function keyCombo(text: string): string | null {
  // the plus key itself: "+" alone, or the end of "Ctrl++"
  const parts = text === "+" ? ["+"] : text.endsWith("++") ? [...text.slice(0, -2).split("+"), "+"] : text.split("+");
  const keys: string[] = [];
  for (const [i, part] of parts.entries()) {
    const word = part.trim().toLowerCase();
    if (i < parts.length - 1) {
      const modifier = MODIFIER_KEYS.get(word);
      if (!modifier) return null;
      keys.push(modifier);
      continue;
    }
    const key =
      NAMED_KEYS.get(word) ??
      (/^f(?:[1-9]|1[0-9]|2[0-4])$/.test(word) || /^[\x21-\x7e]$/.test(word) ? word.toUpperCase() : null);
    if (!key) return null;
    keys.push(key);
  }
  return keys.join("+");
}

/**
 * Splits a tooltip into its label and its shortcut: "Save (Ctrl+S)" →
 * { label: "Save", keys: "Control+S" }. A tooltip without one keeps all of it
 * as the label, with keys null. Several shortcuts ("(Ctrl+= / Ctrl+−)") come
 * back space-separated, as aria-keyshortcuts lists them.
 */
export function titleParts(title: string): { label: string; keys: string | null } {
  const m = /^(.*?)\s*[(（]([^()（）]+)[)）]\s*$/su.exec(title);
  if (m && m[1]) {
    const combos = m[2].trim().split(/\s+\/\s+/).map(keyCombo);
    if (combos.every((c) => c !== null)) return { label: m[1], keys: combos.join(" ") };
  }
  return { label: title, keys: null };
}

/**
 * Sets `el`'s tooltip and the name a screen reader says for it: the tooltip
 * without its shortcut, which goes to aria-keyshortcuts instead. Icon buttons
 * get a name this way, and buttons whose face is a glyph ("Aa", "A") a real one.
 */
export function setTitle(el: Element, title: string): void {
  const { label, keys } = titleParts(title);
  el.setAttribute("title", title);
  el.setAttribute("aria-label", label);
  if (keys) el.setAttribute("aria-keyshortcuts", keys);
  else el.removeAttribute("aria-keyshortcuts");
}

// The keys overlay writes its key caps in English; these differ by language
// ("Strg", "Maj", "Leertaste"). Only caps whose whole text is the name change.
const KEY_CAPS = new Map<string, keyof Dict>([
  ["Ctrl", "key.ctrl"],
  ["Shift", "key.shift"],
  ["Space", "key.space"],
  ["Esc", "key.esc"],
  ["PgUp", "key.pgUp"],
  ["PgDn", "key.pgDn"],
]);

// Static markup carries its English text as the fallback and a data-i18n*
// attribute naming the key: data-i18n (text), data-i18n-html (markup with
// <kbd>), data-i18n-title, data-i18n-placeholder, data-i18n-aria-label. A
// title also names its element (setTitle), unless data-i18n-aria-label does.
export function applyDom(root: ParentNode = document): void {
  const k = (el: Element, attr: string) => el.getAttribute(attr) as keyof Dict;
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(k(el, "data-i18n"));
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(k(el, "data-i18n-html"));
  for (const kbd of root.querySelectorAll("#keys-dialog kbd")) {
    const key = KEY_CAPS.get((kbd.textContent ?? "").trim());
    if (key) kbd.textContent = t(key);
  }
  for (const el of root.querySelectorAll("[data-i18n-title]")) {
    const title = t(k(el, "data-i18n-title"));
    if (el.hasAttribute("data-i18n-aria-label")) el.setAttribute("title", title);
    else setTitle(el, title);
  }
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(k(el, "data-i18n-placeholder")));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(k(el, "data-i18n-aria-label")));
  }
}

const helpLoads = new WeakMap<HTMLElement, Promise<void>>();

/**
 * Fills `target` with the help page of the UI language, the first time only
 * (later calls return the same promise). It never rejects: a page that could
 * not be loaded leaves `target` as it was, and the next call tries again.
 */
export function loadHelp(target: HTMLElement): Promise<void> {
  let load = helpLoads.get(target);
  if (!load) {
    load = HELP[lang]().then(
      (page) => {
        target.innerHTML = page.default;
      },
      () => {
        helpLoads.delete(target);
      },
    );
    helpLoads.set(target, load);
  }
  return load;
}

export function init(): void {
  document.documentElement.lang = lang;
  applyDom();
}
