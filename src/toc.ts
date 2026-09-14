let spyCleanup: (() => void) | null = null;

// Headings whose top edge is within this band below the pane's top edge count
// as "reached". Near the end of the document the band grows progressively (see
// activationLine) so short trailing sections can still become active.
const BASE_LINE = 90;
// While a click's smooth scroll is running, every scroll event re-arms this idle
// timer; when it fires the programmatic scroll is over. (scrollend is not used:
// one left over from a previous user scroll can arrive right after the click.)
const SETTLE_IDLE_MS = 250;

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

  const heads = [...article.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4)[id]")];
  const items: HTMLButtonElement[] = [];
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
  }

  return heads.length;
}
