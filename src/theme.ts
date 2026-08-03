export type Theme = "light" | "dark";
export type ThemePref = Theme | "system";

const listeners: Array<(t: Theme) => void> = [];
const media = matchMedia("(prefers-color-scheme: dark)");

const systemTheme = (): Theme => (media.matches ? "dark" : "light");

export function current(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

// "system" is the absence of a saved override
export function currentPref(): ThemePref {
  const saved = localStorage.getItem("theme");
  return saved === "light" || saved === "dark" ? saved : "system";
}

export function init(): void {
  apply();
  media.addEventListener("change", () => {
    if (currentPref() === "system") apply();
  });
}

let animTimer: number | undefined;

// light → dark → system → light
export function cycle(): void {
  const order: ThemePref[] = ["light", "dark", "system"];
  const next = order[(order.indexOf(currentPref()) + 1) % order.length];
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
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.themePref = pref; // drives the toolbar icon
  for (const cb of listeners) cb(t);
}
