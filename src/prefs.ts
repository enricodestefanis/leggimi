// Reader preferences behind the Aa popover: text size, font family, line
// spacing, column width and the side panels' text size. Follows theme.ts's
// idiom — the absence of the localStorage key means "defaults", which
// reproduce the classic look.

export type ReaderFont = "sans" | "serif";
export type LineHeight = "compact" | "normal" | "relaxed";
export type ColumnWidth = "narrow" | "normal" | "wide" | "full";
export type SideSize = "small" | "normal" | "large";

export interface ReaderPrefs {
  size: number;
  font: ReaderFont;
  lineHeight: LineHeight;
  width: ColumnWidth;
  sideSize: SideSize;
  /** printing: start a new page at every heading 1 */
  printBreakH1: boolean;
}

export const SIZE_STEPS = [13, 14, 15, 16, 17, 18, 20, 22];
export const SIDE_STEPS: readonly SideSize[] = ["small", "normal", "large"];
export const DEFAULTS: ReaderPrefs = {
  size: 16,
  font: "sans",
  lineHeight: "normal",
  width: "normal",
  sideSize: "normal",
  printBreakH1: false,
};

const KEY = "reader-prefs";
const listeners: Array<(p: ReaderPrefs) => void> = [];

const isOneOf = <T extends string>(v: unknown, all: readonly T[]): v is T =>
  typeof v === "string" && (all as readonly string[]).includes(v);

function snapSize(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULTS.size;
  let best = SIZE_STEPS[0];
  for (const s of SIZE_STEPS) if (Math.abs(s - n) < Math.abs(best - n)) best = s;
  return best;
}

export function get(): ReaderPrefs {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    /* corrupt value: fall back to defaults */
  }
  const o = (raw ?? {}) as Partial<Record<keyof ReaderPrefs, unknown>>;
  return {
    size: snapSize(o.size),
    font: isOneOf(o.font, ["sans", "serif"]) ? o.font : DEFAULTS.font,
    lineHeight: isOneOf(o.lineHeight, ["compact", "normal", "relaxed"])
      ? o.lineHeight
      : DEFAULTS.lineHeight,
    width: isOneOf(o.width, ["narrow", "normal", "wide", "full"]) ? o.width : DEFAULTS.width,
    sideSize: isOneOf(o.sideSize, SIDE_STEPS) ? o.sideSize : DEFAULTS.sideSize,
    printBreakH1: o.printBreakH1 === true,
  };
}

export function set(patch: Partial<ReaderPrefs>): void {
  const next = { ...get(), ...patch };
  const isDefault = (Object.keys(DEFAULTS) as (keyof ReaderPrefs)[]).every(
    (k) => next[k] === DEFAULTS[k],
  );
  if (isDefault) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(next));
  apply(next);
}

export function bumpSize(dir: 1 | -1): void {
  const i = SIZE_STEPS.indexOf(get().size);
  set({ size: SIZE_STEPS[Math.max(0, Math.min(SIZE_STEPS.length - 1, i + dir))] });
}

export function bumpSideSize(dir: 1 | -1): void {
  const i = SIDE_STEPS.indexOf(get().sideSize);
  set({ sideSize: SIDE_STEPS[Math.max(0, Math.min(SIDE_STEPS.length - 1, i + dir))] });
}

export function reset(): void {
  set({ ...DEFAULTS, printBreakH1: get().printBreakH1 });
}

export function onChange(cb: (p: ReaderPrefs) => void): void {
  listeners.push(cb);
}

export function init(): void {
  apply(get());
}

/**
 * Another window changed the preferences (they share localStorage): apply
 * them here too. `wrap` runs the change, so the caller can keep its place.
 */
export function syncAcrossWindows(wrap: (fn: () => void) => void): void {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY || e.key === null) wrap(() => apply(get()));
  });
}

function apply(p: ReaderPrefs): void {
  const root = document.documentElement;
  root.style.setProperty("--reader-font-size", `${p.size}px`);
  root.dataset.readerFont = p.font;
  root.dataset.readerLh = p.lineHeight;
  root.dataset.readerWidth = p.width;
  root.dataset.sideSize = p.sideSize;
  if (p.printBreakH1) root.dataset.printH1Break = "1";
  else delete root.dataset.printH1Break;
  for (const cb of listeners) cb(p);
}
