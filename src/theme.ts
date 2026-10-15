// Four palettes, two schemes. `data-theme` picks the token set (light, sepia,
// dark, black); `data-scheme` says which side of light/dark it belongs to, for
// the parts that only know two palettes: hljs, the alerts, mermaid, print.
export type Theme = "light" | "sepia" | "dark" | "black";
export type ThemePref = Theme | "system";
export type Scheme = "light" | "dark";

export const THEMES: readonly Theme[] = ["light", "sepia", "dark", "black"];

const listeners: Array<(t: Theme) => void> = [];
const media = matchMedia("(prefers-color-scheme: dark)");

const systemTheme = (): Theme => (media.matches ? "dark" : "light");

const isTheme = (v: unknown): v is Theme => (THEMES as readonly unknown[]).includes(v);

export const schemeOf = (t: Theme): Scheme => (t === "dark" || t === "black" ? "dark" : "light");

export function current(): Theme {
  const t = document.documentElement.dataset.theme;
  return isTheme(t) ? t : "light";
}

export function isDark(): boolean {
  return schemeOf(current()) === "dark";
}

// "system" is the absence of a saved override
export function currentPref(): ThemePref {
  const saved = localStorage.getItem("theme");
  return isTheme(saved) ? saved : "system";
}

export function init(): void {
  apply();
  media.addEventListener("change", () => {
    if (currentPref() === "system") apply();
  });
}

let animTimer: number | undefined;

export function setPref(next: ThemePref): void {
  if (next === "system") localStorage.removeItem("theme");
  else localStorage.setItem("theme", next);
  // cross-fade colors only while switching; no transition cost the rest of the time
  const root = document.documentElement;
  root.classList.add("theme-anim");
  clearTimeout(animTimer);
  animTimer = window.setTimeout(() => root.classList.remove("theme-anim"), 280);
  apply();
}

export function onChange(cb: (t: Theme) => void): void {
  listeners.push(cb);
}

function apply(): void {
  const pref = currentPref();
  const t = pref === "system" ? systemTheme() : pref;
  const root = document.documentElement;
  root.dataset.theme = t;
  root.dataset.scheme = schemeOf(t);
  root.dataset.themePref = pref; // mirrored in the Aa popover
  for (const cb of listeners) cb(t);
}
