// Where a document asked for inside a window opens, as in a browser: a click
// opens it in the tab in front; Ctrl or the middle button in a tab behind it
// (Ctrl+Shift: in front); Shift in a new window. Enter in a list picked with
// the keyboard (the command palette) reads the same keys.
export type Where = "here" | "tab" | "tab-front" | "window";

export function whereFrom(e: MouseEvent): Where {
  if (e.button === 1 || e.ctrlKey) return e.shiftKey ? "tab-front" : "tab";
  if (e.shiftKey) return "window";
  return "here";
}

export function whereFromKeys(e: KeyboardEvent): Where {
  if (e.ctrlKey) return e.shiftKey ? "tab-front" : "tab";
  if (e.shiftKey) return "window";
  return "here";
}
