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
import helpEn from "./locales/help/en.html?raw";
import helpIt from "./locales/help/it.html?raw";
import helpDe from "./locales/help/de.html?raw";
import helpFr from "./locales/help/fr.html?raw";
import helpEs from "./locales/help/es.html?raw";
import helpZh from "./locales/help/zh-CN.html?raw";

export type Dict = { readonly [K in keyof typeof en]: string };
export type Lang = "en" | "it" | "de" | "fr" | "es" | "zh-CN";
export type LangPref = Lang | "auto";

export const LANGS: readonly Lang[] = ["en", "it", "de", "fr", "es", "zh-CN"];
const DICTS: Record<Lang, Dict> = { en, it, de, fr, es, "zh-CN": zh };
const HELP: Record<Lang, string> = { en: helpEn, it: helpIt, de: helpDe, fr: helpFr, es: helpEs, "zh-CN": helpZh };
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

const lang: Lang = pref() === "auto" ? fromSystem() : (pref() as Lang);
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

// Static markup carries its English text as the fallback and a data-i18n*
// attribute naming the key: data-i18n (text), data-i18n-html (markup with
// <kbd>), data-i18n-title, data-i18n-placeholder, data-i18n-aria-label.
export function applyDom(root: ParentNode = document): void {
  const k = (el: Element, attr: string) => el.getAttribute(attr) as keyof Dict;
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(k(el, "data-i18n"));
  for (const el of root.querySelectorAll("[data-i18n-html]")) el.innerHTML = t(k(el, "data-i18n-html"));
  for (const el of root.querySelectorAll("[data-i18n-title]")) el.setAttribute("title", t(k(el, "data-i18n-title")));
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(k(el, "data-i18n-placeholder")));
  }
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(k(el, "data-i18n-aria-label")));
  }
}

export function init(): void {
  document.documentElement.lang = lang;
  const help = document.getElementById("help-text");
  if (help) help.innerHTML = HELP[lang];
  applyDom();
}
