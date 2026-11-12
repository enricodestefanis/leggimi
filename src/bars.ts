// The two bars that float at the top of the document pane (ui.css): the find
// bar at its right edge, the notice in its middle. Open together they need
// room to stand side by side: about 1150px of pane for an ordinary notice,
// more for a long one. Where there is less, the notice would lie over the find
// bar's box and hide what is typed there. Then it goes under the find bar
// instead, and comes back beside it as soon as there is room.
//
// Where each one is from left to right does not depend on that (only the
// notice's top changes), so the measure cannot feed itself.

/** the least room between the two for them to count as side by side */
const GAP = 8;

export function init(pane: HTMLElement, find: HTMLElement, notice: HTMLElement): void {
  const place = (): void => {
    // both on screen: neither hidden, nor put away with the pane (a narrow
    // window while editing shows the notice alone, layout.css)
    const both = find.offsetWidth > 0 && notice.offsetWidth > 0;
    const under = both && notice.offsetLeft + notice.offsetWidth + GAP > find.offsetLeft;
    // the height it goes under (ui.css)
    if (under) notice.style.setProperty("--find-bar-h", `${find.offsetHeight}px`);
    if (under === notice.classList.contains("under-find")) return;
    // at once: the glide of the bars' top (ui.css) is for the section line
    // coming and going, and waits 0.3s before it goes back up
    notice.style.transition = "none";
    notice.classList.toggle("under-find", under);
    void notice.offsetTop;
    notice.style.transition = "";
  };
  // either bar shown, hidden or resized (another message), the pane resized:
  // measured after the layout, placed before the frame is painted
  const watch = new ResizeObserver(place);
  for (const el of [pane, find, notice]) watch.observe(el);
}
