// Motion that follows Windows' "Animation effects" setting (the
// prefers-reduced-motion media query): with it off, smooth scrolls become
// jumps and the landing highlight is a short static tint instead of a fade.
// CSS animations are already quieted by the reduce rule in base.css; scrolls
// started from code are not, hence this module.

const query = window.matchMedia("(prefers-reduced-motion: reduce)");

export const reduced = (): boolean => query.matches;

/** The behavior for scrollTo / scrollIntoView. */
export const behavior = (): ScrollBehavior => (reduced() ? "auto" : "smooth");

const STATIC_MS = 1200;
// a smooth scroll in Chromium stays put for its first frames: this long
// without moving means there was nothing to scroll
const START_GRACE_MS = 200;
// the longest the highlight waits for a scroll (one that never settles):
// Chromium's smooth scrolls from code last up to ~1.5 s (from ~6000 px on)
const SCROLL_WAIT_MS = 2000;
// frames the pane must hold still, once it has moved, to have arrived
const STILL_FRAMES = 3;

/**
 * Briefly highlights the element the reader just landed on (a heading reached
 * from the outline or a link). With `pane`, the scroll container that is
 * moving there, the highlight waits for the scroll to arrive, so it is not
 * spent before the element is on screen.
 */
export function flash(el: HTMLElement, pane?: HTMLElement): void {
  const start = (): void => {
    el.classList.remove("landing", "landing-static");
    void el.offsetWidth; // restart the animation when it is still running
    if (reduced()) {
      el.classList.add("landing-static");
      window.setTimeout(() => el.classList.remove("landing-static"), STATIC_MS);
    } else {
      el.classList.add("landing");
      // its own end (drawn on ::after): not that of an animated element inside it
      const end = (e: AnimationEvent): void => {
        if (e.target !== el || e.animationName !== "landing") return;
        el.removeEventListener("animationend", end);
        el.classList.remove("landing");
      };
      el.addEventListener("animationend", end);
    }
  };
  if (!pane || reduced()) {
    start();
    return;
  }
  // The pane is watched frame by frame rather than through scrollend, which
  // can be left over from an earlier scroll: the highlight starts once the
  // pane, having moved, holds still for a few frames.
  const t0 = performance.now();
  let last = pane.scrollTop;
  let moved = false;
  let still = 0;
  const tick = (): void => {
    const y = pane.scrollTop;
    if (y !== last) {
      moved = true;
      still = 0;
    } else still++;
    last = y;
    const elapsed = performance.now() - t0;
    if ((moved && still >= STILL_FRAMES) || (!moved && elapsed > START_GRACE_MS) || elapsed > SCROLL_WAIT_MS) start();
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
