// Side-pane widths. The current widths are also the minimums: a pane can be
// widened, never narrowed. Follows the idiom of prefs.ts and theme.ts — the
// absence of the localStorage key means "default".
//
// The stored width is what the user asked for; the applied width is that value
// clamped to the room available right now, so shrinking the window never
// destroys a choice — re-widening brings it back.

export type Pane = "tree" | "toc";

const DEFAULTS: Record<Pane, number> = { tree: 260, toc: 240 };
const MAX: Record<Pane, number> = { tree: 560, toc: 520 };
const CSS_VAR: Record<Pane, string> = { tree: "--tree-width", toc: "--toc-width" };
const KEY: Record<Pane, string> = { tree: "tree-width", toc: "toc-width" };
const PANES: Pane[] = ["tree", "toc"];
const MIN_CONTENT = 420; // the article must stay readable whatever happens

const KEY_STEP = 16;
const KEY_STEP_BIG = 64;

let shell: HTMLElement;
let elements: Record<Pane, HTMLElement>;
let handles: Record<Pane, HTMLElement>;
const desired: Record<Pane, number> = { ...DEFAULTS };
let raf = 0;

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export function init(opts: {
  shell: HTMLElement;
  panes: Record<Pane, HTMLElement>;
  handles: Record<Pane, HTMLElement>;
}): void {
  shell = opts.shell;
  elements = opts.panes;
  handles = opts.handles;
  for (const p of PANES) {
    desired[p] = read(p);
    wire(p);
  }
  // a narrower window shrinks the applied width without forgetting the stored one
  window.addEventListener("resize", refresh);
  apply();
}

function read(p: Pane): number {
  const n = Number(localStorage.getItem(KEY[p]));
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS[p];
  return clamp(n, DEFAULTS[p], MAX[p]);
}

function persist(p: Pane): void {
  if (desired[p] === DEFAULTS[p]) localStorage.removeItem(KEY[p]);
  else localStorage.setItem(KEY[p], String(Math.round(desired[p])));
}

const visible = (p: Pane): boolean => elements[p].offsetParent !== null;

// The other pane is measured from its stored width alone: clamping it here too
// would recurse, and its own clamp runs in the same pass anyway.
function maxFor(p: Pane): number {
  const other: Pane = p === "tree" ? "toc" : "tree";
  const taken = visible(other) ? clamp(desired[other], DEFAULTS[other], MAX[other]) : 0;
  const room = shell.clientWidth - MIN_CONTENT - taken;
  return Math.max(DEFAULTS[p], Math.min(MAX[p], room));
}

const effective = (p: Pane): number => clamp(desired[p], DEFAULTS[p], maxFor(p));

export function setDesired(p: Pane, px: number): void {
  desired[p] = clamp(px, DEFAULTS[p], maxFor(p));
  schedule();
}

export function reset(p: Pane): void {
  desired[p] = DEFAULTS[p];
  persist(p);
  apply();
}

/** Re-clamps both panes: the window resized, or a pane was shown or hidden. */
export function refresh(): void {
  apply();
}

function schedule(): void {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    apply();
  });
}

function apply(): void {
  const root = document.documentElement;
  for (const p of PANES) {
    const w = effective(p);
    root.style.setProperty(CSS_VAR[p], `${Math.round(w)}px`);
    handles[p].setAttribute("aria-valuenow", String(Math.round(w)));
    handles[p].setAttribute("aria-valuemax", String(Math.round(maxFor(p))));
  }
}

function wire(p: Pane): void {
  const h = handles[p];
  // the tree grows as the handle moves right, the outline as it moves left
  const dir = p === "tree" ? 1 : -1;
  let origin: { x: number; w: number } | null = null;

  h.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault(); // no text selection, no focus flicker
    origin = { x: e.clientX, w: effective(p) };
    h.setPointerCapture(e.pointerId);
    h.classList.add("dragging");
    document.body.classList.add("resizing");
  });
  h.addEventListener("pointermove", (e) => {
    if (!origin) return;
    setDesired(p, origin.w + dir * (e.clientX - origin.x));
  });
  const end = (): void => {
    if (!origin) return;
    origin = null;
    h.classList.remove("dragging");
    document.body.classList.remove("resizing");
    persist(p); // one write per drag, not one per frame
  };
  h.addEventListener("pointerup", end);
  h.addEventListener("pointercancel", end);
  h.addEventListener("lostpointercapture", end);
  h.addEventListener("dblclick", () => reset(p));

  h.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? KEY_STEP_BIG : KEY_STEP;
    if (e.key === "ArrowLeft") setDesired(p, effective(p) - dir * step);
    else if (e.key === "ArrowRight") setDesired(p, effective(p) + dir * step);
    else if (e.key === "Home") desired[p] = DEFAULTS[p];
    else if (e.key === "End") desired[p] = maxFor(p);
    else return;
    e.preventDefault(); // and keep the arrows from scrolling the pane
    apply();
    persist(p);
  });
}
