// The keys of the app's menus of buttons (the Share menu, the format bar's
// dropdowns, the preview's copy menu, the right-click menu), as in Windows:
// Up and Down move and wrap, Home and End jump to the ends, Escape and Tab
// close the menu. Enter and Space click the focused button natively.

const ITEMS = ".menu-item:not([disabled]):not([hidden])";

/** The items a key can reach: enabled, and not hidden by themselves or a parent. */
export function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>(ITEMS)].filter((el) => el.getClientRects().length > 0);
}

/**
 * Handles a keydown inside `menu`. `close` runs for Escape and Tab: it hides
 * the menu and gives the focus back to whatever opened it. Returns true when
 * the key was the menu's (its default is then prevented and it goes no
 * further, so a dialog or the document never sees it).
 */
export function handleMenuKey(e: KeyboardEvent, menu: HTMLElement, close: () => void): boolean {
  const items = menuItems(menu);
  const i = items.indexOf(document.activeElement as HTMLElement);
  let next = -1;
  switch (e.key) {
    case "ArrowDown":
      next = i < 0 ? 0 : (i + 1) % items.length;
      break;
    case "ArrowUp":
      next = i < 0 ? items.length - 1 : (i - 1 + items.length) % items.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = items.length - 1;
      break;
    case "Escape":
    case "Tab":
      close();
      break;
    default:
      return false;
  }
  e.preventDefault();
  e.stopPropagation();
  if (next >= 0) items[next]?.focus({ preventScroll: true });
  return true;
}
