export type Theme = "light" | "dark";

const listeners: Array<(t: Theme) => void> = [];
const media = matchMedia("(prefers-color-scheme: dark)");

const systemTheme = (): Theme => (media.matches ? "dark" : "light");

export function current(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function init(): void {
  const saved = localStorage.getItem("theme");
  apply(saved === "light" || saved === "dark" ? saved : systemTheme());
  media.addEventListener("change", () => {
    if (!localStorage.getItem("theme")) apply(systemTheme());
  });
}

let animTimer: number | undefined;

export function toggle(): void {
  const next: Theme = current() === "dark" ? "light" : "dark";
  localStorage.setItem("theme", next);
  // cross-fade colors only while switching; no transition cost the rest of the time
  const root = document.documentElement;
  root.classList.add("theme-anim");
  clearTimeout(animTimer);
  animTimer = window.setTimeout(() => root.classList.remove("theme-anim"), 280);
  apply(next);
}

export function onChange(cb: (t: Theme) => void): void {
  listeners.push(cb);
}

function apply(t: Theme): void {
  document.documentElement.dataset.theme = t;
  for (const cb of listeners) cb(t);
}
