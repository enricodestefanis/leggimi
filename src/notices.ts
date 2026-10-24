// The notice bar at the top of the reading pane: one message at a time, with
// an optional action and a dismiss button. Its icon says what kind of message
// it is (a saved PDF is no warning), and a hidden live region reads it out:
// a bar that appears at the moment its text changes is not reliably announced.

export type NoticeKind = "warning" | "error" | "info" | "success";

export interface NoticeOptions {
  action?: { label: string; fn: () => void };
  /** survives routine refreshes: only hide(true) removes it */
  sticky?: boolean;
  onDismiss?: () => void;
  /** the icon (and its colour); "warning" when not given */
  kind?: NoticeKind;
}

interface Elements {
  bar: HTMLElement;
  icon: HTMLElement;
  msg: HTMLElement;
  action: HTMLButtonElement;
  close: HTMLButtonElement;
  /** role=status, for everything but errors */
  status: HTMLElement;
  /** role=alert, for errors */
  alert: HTMLElement;
}

const svg = (body: string): string =>
  `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const ICONS: Record<NoticeKind, string> = {
  warning: svg(
    '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  ),
  error: svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
  info: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  success: svg('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>'),
};

let els: Elements | null = null;
let actionFn: (() => void) | null = null;
let dismissFn: (() => void) | null = null;
let sticky = false;
// the notice on screen, for its tab to take along when another comes forward
let shown: { message: string; opts: NoticeOptions } | null = null;

export function init(elements: Elements): void {
  els = elements;
  elements.action.addEventListener("click", () => actionFn?.());
  elements.close.addEventListener("click", () => {
    const fn = dismissFn;
    hide(true);
    fn?.();
  });
}

export function show(message: string, opts: NoticeOptions = {}): void {
  if (!els) return;
  const kind = opts.kind ?? "warning";
  dismissFn = opts.onDismiss ?? null;
  els.bar.dataset.kind = kind;
  els.icon.innerHTML = ICONS[kind];
  els.msg.textContent = message;
  els.msg.title = message;
  if (opts.action) {
    els.action.textContent = opts.action.label;
    els.action.hidden = false;
    actionFn = opts.action.fn;
  } else {
    els.action.hidden = true;
    actionFn = null;
  }
  sticky = opts.sticky ?? false;
  shown = { message, opts };
  els.bar.hidden = false;
  announce(message, kind === "error" ? "assertive" : "polite");
}

/**
 * A sticky notice on screen (a file changed on disk, a draft to restore, a
 * file gone), to be shown again when its tab comes back to the front.
 */
export function snapshot(): { message: string; opts: NoticeOptions } | null {
  return els && !els.bar.hidden && sticky ? shown : null;
}

// sticky notices (a file changed on disk, a recovered draft) survive routine
// preview refreshes; force removes them too
export function hide(force = false): void {
  if (!els || (sticky && !force)) return;
  els.bar.hidden = true;
  sticky = false;
  shown = null;
  actionFn = null;
  dismissFn = null;
}

let announceTimer: number | undefined;

/** Reads a message out to screen readers without showing anything. */
export function announce(message: string, politeness: "polite" | "assertive" = "polite"): void {
  if (!els) return;
  const region = politeness === "assertive" ? els.alert : els.status;
  // a live region speaks when its text changes: empty it first, so the same
  // message twice in a row is read twice
  clearTimeout(announceTimer);
  els.status.textContent = "";
  els.alert.textContent = "";
  announceTimer = window.setTimeout(() => (region.textContent = message), 60);
}
