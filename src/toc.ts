let spyCleanup: (() => void) | null = null;

// Headings whose top edge is within this band below the pane's top edge count
// as "reached". Near the end of the document the band grows progressively (see
// activationLine) so short trailing sections can still become active.
const BASE_LINE = 90;
// While a click's smooth scroll is running, every scroll event re-arms this idle
// timer; when it fires the programmatic scroll is over. (scrollend is not used:
// one left over from a previous user scroll can arrive right after the click.)
const SETTLE_IDLE_MS = 250;

// the current outline, for the filter box and the reading keys
let heads: HTMLElement[] = [];
let items: HTMLButtonElement[] = [];
let cursor = -1; // index into items, the keyboard-highlighted filter result
// the reading keys' "next / previous heading", bound to the spy's state by build()
let stepImpl: ((dir: 1 | -1) => boolean) | null = null;

// Where the activation line sits, measured from the pane's top edge. Far from the
// bottom it is a fixed BASE_LINE; within the last viewport of scroll it slides down
// to the pane's bottom edge, so at max scroll the last heading is always active.
function activationLine(pane: HTMLElement): number {
  const view = pane.clientHeight;
  const maxScroll = pane.scrollHeight - view;
  if (maxScroll <= 0) return BASE_LINE;
  const remaining = maxScroll - pane.scrollTop;
  const tail = Math.min(1, Math.max(0, 1 - remaining / view));
  return BASE_LINE + tail * (view - BASE_LINE);
}

// Returns the number of headings found, so the caller can hide an empty panel.
export function build(article: HTMLElement, list: HTMLElement, scrollPane: HTMLElement): number {
  spyCleanup?.();
  spyCleanup = null;
  stepImpl = null;

  heads = [...article.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4)[id]")];
  items = [];
  cursor = -1;
  list.replaceChildren();

  let current = -1;
  const setActive = (index: number) => {
    if (index === current) return;
    current = index;
    items.forEach((it, i) => it.classList.toggle("active", i === index));
    items[index]?.scrollIntoView({ block: "nearest" });
  };

  // A clicked entry stays highlighted while the smooth scroll runs and until the
  // user scrolls again on their own, so the spy never overrides the choice.
  let pinned = false;
  let settling = false;
  let settleTimer = 0;
  const armSettle = () => {
    clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => (settling = false), SETTLE_IDLE_MS);
  };
  const release = () => {
    clearTimeout(settleTimer);
    settling = false;
    pinned = false;
  };

  heads.forEach((h, i) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `toc-item lvl-${h.tagName[1]}`;
    item.textContent = h.textContent ?? "";
    item.title = h.textContent ?? "";
    item.addEventListener("click", () => {
      pinned = true;
      settling = true;
      armSettle();
      setActive(i);
      h.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    list.append(item);
    items.push(item);
  });

  if (heads.length > 0) {
    let raf = 0;
    const update = () => {
      raf = 0;
      const line = activationLine(scrollPane);
      const paneTop = scrollPane.getBoundingClientRect().top;
      let active = 0;
      for (let i = 0; i < heads.length; i++) {
        if (heads[i].getBoundingClientRect().top - paneTop > line) break;
        active = i;
      }
      setActive(active);
    };
    const onScroll = () => {
      if (pinned) {
        if (settling) {
          armSettle();
          return;
        }
        pinned = false;
      }
      if (!raf) raf = requestAnimationFrame(update);
    };
    // Wheel/touch input is unmistakably the user's: drop the pin right away.
    const onUserInput = () => {
      if (pinned) release();
    };
    scrollPane.addEventListener("scroll", onScroll, { passive: true });
    scrollPane.addEventListener("wheel", onUserInput, { passive: true });
    scrollPane.addEventListener("touchmove", onUserInput, { passive: true });
    spyCleanup = () => {
      scrollPane.removeEventListener("scroll", onScroll);
      scrollPane.removeEventListener("wheel", onUserInput);
      scrollPane.removeEventListener("touchmove", onUserInput);
      clearTimeout(settleTimer);
      if (raf) cancelAnimationFrame(raf);
    };
    update();

    // "." / ",": a click on the neighbouring outline entry. While a click or a
    // previous key still pins the highlight, the next entry is simply the
    // neighbour of the pinned one, so the keys keep stepping through the
    // headings near the end of the document, where none of them can reach
    // the top edge and the scroll position alone could not tell them apart.
    // After a manual scroll the start is read off the page: the first heading
    // below the top edge, or the last one above it. (32: past the 24px
    // scroll-margin a just-reached heading sits at.)
    stepImpl = (dir) => {
      let i: number;
      if (pinned) {
        i = current + dir;
      } else {
        const paneTop = scrollPane.getBoundingClientRect().top;
        const tops = heads.map((h) => h.getBoundingClientRect().top - paneTop);
        i = -1;
        if (dir === 1) i = tops.findIndex((t) => t > 32);
        else for (let k = tops.length - 1; k >= 0; k--) if (tops[k] < -4) { i = k; break; }
      }
      if (i < 0 || i >= items.length) return false;
      items[i].click();
      return true;
    };
  }

  return heads.length;
}

/* ---- filter box ---- */

// Hides the entries that don't contain `query` (case-insensitive) and puts
// the keyboard cursor on the first one left. Returns how many are visible.
export function setFilter(query: string): number {
  const q = query.trim().toLowerCase();
  let visible = 0;
  items.forEach((it) => {
    const show = !q || (it.textContent ?? "").toLowerCase().includes(q);
    it.hidden = !show;
    if (show) visible++;
  });
  setCursor(q ? firstVisible(0, 1) : -1);
  return visible;
}

const firstVisible = (from: number, dir: 1 | -1): number => {
  for (let i = from; i >= 0 && i < items.length; i += dir) if (!items[i].hidden) return i;
  return -1;
};

function setCursor(index: number): void {
  cursor = index;
  items.forEach((it, i) => it.classList.toggle("cursor", i === index));
  if (index >= 0) items[index].scrollIntoView({ block: "nearest" });
}

export function moveCursor(dir: 1 | -1): void {
  const start = cursor < 0 ? (dir === 1 ? 0 : items.length - 1) : cursor + dir;
  const next = firstVisible(start, dir);
  if (next >= 0) setCursor(next);
}

// Enter in the filter box: jump to the highlighted entry (or the first visible)
export function activateCursor(): boolean {
  const i = cursor >= 0 ? cursor : firstVisible(0, 1);
  if (i < 0) return false;
  items[i].click();
  return true;
}

/* ---- reading keys: previous / next heading ---- */

// Jumps to the heading after (dir 1) or before (dir -1) the one being read,
// highlighting it in the outline; false when there is none.
export function step(dir: 1 | -1): boolean {
  return stepImpl?.(dir) ?? false;
}
