// The "rate on the Store" prompt: a small card that appears once the app has
// earned it (a few days and a handful of documents) and never nags. Once shown
// it stays away for a week even when it went unanswered (it left with its
// document, or its window closed); Later puts it off for a month; Rate or No
// thanks, on the card or in the help, end it for good. Every window shares the
// state through localStorage: the window that shows the card claims it
// (shown), which makes due() false everywhere else. Only the Store build shows
// it; the caller checks that.
interface RateState {
  firstRun: number; // ms since the epoch
  opens: number; // documents opened since firstRun
  state: "pending" | "later" | "done";
  askedAt: number; // last time the card was shown or put off
}

const KEY = "rate-prompt";
const MIN_OPENS = 8;
const MIN_DAYS = 3;
const PENDING_DAYS = 7;
const LATER_DAYS = 30;
const DAY = 86_400_000;

function parse(raw: string | null): RateState | null {
  try {
    const v = JSON.parse(raw ?? "null") as Partial<RateState> | null;
    if (v && typeof v.firstRun === "number") {
      return {
        firstRun: v.firstRun,
        opens: Number(v.opens) || 0,
        state: v.state === "later" || v.state === "done" ? v.state : "pending",
        askedAt: Number(v.askedAt) || 0,
      };
    }
  } catch {
    /* corrupt value: start over */
  }
  return null;
}

function load(): RateState {
  return parse(localStorage.getItem(KEY)) ?? { firstRun: Date.now(), opens: 0, state: "pending", askedAt: 0 };
}

const save = (s: RateState) => localStorage.setItem(KEY, JSON.stringify(s));

/** Call once per document open. */
export function noteOpen(): void {
  const s = load();
  if (s.state === "done") return;
  s.opens += 1;
  save(s);
}

/** True when the card may be shown now (in any window: check again right before showing it). */
export function due(now = Date.now()): boolean {
  const s = load();
  if (s.state === "done") return false;
  if (s.opens < MIN_OPENS || now - s.firstRun < MIN_DAYS * DAY) return false;
  return now - s.askedAt >= (s.state === "later" ? LATER_DAYS : PENDING_DAYS) * DAY;
}

/** The card is on screen: it belongs to this window now, and the week starts. */
export function shown(now = Date.now()): void {
  const s = load();
  s.askedAt = now;
  save(s);
}

export function later(now = Date.now()): void {
  const s = load();
  // a stale card must not undo a Rate or No thanks given in another window
  if (s.state === "done") return;
  s.state = "later";
  s.askedAt = now;
  save(s);
}

export function done(): void {
  const s = load();
  s.state = "done";
  save(s);
}

/**
 * Calls `cb` when another window shows the card, puts it off or ends it, so
 * this window can hide its own (a window never hears of its own writes).
 * Documents counted in another window do not call it: the card on screen here
 * must not vanish because a file was opened elsewhere.
 */
export function onChange(cb: () => void): void {
  window.addEventListener("storage", (e) => {
    if (e.storageArea !== localStorage || (e.key !== KEY && e.key !== null)) return;
    // no record yet reads as a card never shown (the first document counted)
    const before = parse(e.oldValue) ?? { state: "pending", askedAt: 0 };
    const after = parse(e.newValue);
    if (after && before.state === after.state && before.askedAt === after.askedAt) return;
    cb();
  });
}
