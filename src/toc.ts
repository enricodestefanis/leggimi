let spyCleanup: (() => void) | null = null;

// Returns the number of headings found, so the caller can hide an empty panel.
export function build(article: HTMLElement, list: HTMLElement, scrollPane: HTMLElement): number {
  spyCleanup?.();
  spyCleanup = null;

  const heads = [...article.querySelectorAll<HTMLElement>(":is(h1,h2,h3,h4)[id]")];
  const items: HTMLButtonElement[] = [];
  list.replaceChildren();

  for (const h of heads) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `toc-item lvl-${h.tagName[1]}`;
    item.textContent = h.textContent ?? "";
    item.title = h.textContent ?? "";
    item.addEventListener("click", () => h.scrollIntoView({ behavior: "smooth", block: "start" }));
    list.append(item);
    items.push(item);
  }

  if (heads.length > 0) {
    let raf = 0;
    const update = () => {
      raf = 0;
      const paneTop = scrollPane.getBoundingClientRect().top;
      let active = 0;
      heads.forEach((h, i) => {
        if (h.getBoundingClientRect().top - paneTop <= 90) active = i;
      });
      items.forEach((it, i) => it.classList.toggle("active", i === active));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    scrollPane.addEventListener("scroll", onScroll, { passive: true });
    spyCleanup = () => {
      scrollPane.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    update();
  }

  return heads.length;
}
