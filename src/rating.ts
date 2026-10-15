// The "rate on the Store" prompt: a small card that appears once the app has
// earned it (a few days and a handful of documents), never nags, and goes
// away for good after Rate or No thanks. Only the Store build shows it; the
// caller checks that.
interface RateState {
  firstRun: number; // ms since the epoch
  opens: number; // documents opened since firstRun
  state: "pending" | "later" | "done";
  askedAt: number; // last time the card was shown
}

const KEY = "rate-prompt";
const MIN_OPENS = 8;
const MIN_DAYS = 3;
const LATER_DAYS = 30;
const DAY = 86_400_000;

function load(): RateState {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<RateState> | null;
    if (raw && typeof raw.firstRun === "number") {
      return {
        firstRun: raw.firstRun,
        opens: Number(raw.opens) || 0,
        state: raw.state === "later" || raw.state === "done" ? raw.state : "pending",
        askedAt: Number(raw.askedAt) || 0,
      };
    }
  } catch {
    /* corrupt value: start over */
  }
  return { firstRun: Date.now(), opens: 0, state: "pending", askedAt: 0 };
}

const save = (s: RateState) => localStorage.setItem(KEY, JSON.stringify(s));

/** Call once per document open. */
export function noteOpen(): void {
  const s = load();
  if (s.state === "done") return;
  s.opens += 1;
  save(s);
}

/** True when the card may be shown now. */
export function due(now = Date.now()): boolean {
  const s = load();
  if (s.state === "done") return false;
  if (s.opens < MIN_OPENS || now - s.firstRun < MIN_DAYS * DAY) return false;
  if (s.state === "later" && now - s.askedAt < LATER_DAYS * DAY) return false;
  return true;
}

export function shown(): void {
  const s = load();
  s.askedAt = Date.now();
  save(s);
}

export function later(): void {
  const s = load();
  s.state = "later";
  s.askedAt = Date.now();
  save(s);
}

export function done(): void {
  const s = load();
  s.state = "done";
  save(s);
}
