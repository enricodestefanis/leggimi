// A video or a sound playing in the document goes on playing while the
// document is rendered again: at each pause in typing in the editor, or
// when its file changes on disk. A render makes every element anew, and a
// <video> or <audio> made anew starts from the beginning. So, right after
// the new content goes in, each new one written exactly as one on show
// before gives way to it, the old element with its place in the playback.
// In the same task as the swap: the HTML spec pauses a media element taken
// out of the document only at the next stable state, and by then it is
// back in.

/** The video and audio on show before a render, by their markup: for restoreMedia. */
export interface MediaKeep {
  readonly byMarkup: Map<string, HTMLMediaElement[]>;
}

// Each element's markup as it went in, before the app's own marks (a jump's
// highlight class, an image viewer's attributes on fallback content) could
// change it: what the next render writes is compared with this.
const markupAtPlacing = new WeakMap<HTMLMediaElement, string>();

// What an element is written as. Not its source line, which moves whenever
// a line is added above it. Its URLs are the same at every render: the
// document's files resolve once (resolvedUrls in renderer.ts).
const markupOf = (el: HTMLMediaElement): string => el.outerHTML.replace(/\sdata-source-line="[^"]*"/g, "");

// the video and audio in root, not one inside another's fallback content
function mediaIn(root: ParentNode): HTMLMediaElement[] {
  return [...root.querySelectorAll<HTMLMediaElement>("video, audio")].filter(
    (m) => !m.parentElement?.closest("video, audio"),
  );
}

/** Before the old content leaves: the video and audio on show, a list for each markup (the same video twice, in order). */
export function collectMedia(root: ParentNode): MediaKeep {
  const byMarkup = new Map<string, HTMLMediaElement[]>();
  for (const m of mediaIn(root)) {
    const key = markupAtPlacing.get(m) ?? markupOf(m);
    const same = byMarkup.get(key);
    if (same) same.push(m);
    else byMarkup.set(key, [m]);
  }
  return { byMarkup };
}

/**
 * Right after the new content went in, in the same task: each new video or
 * audio written as one collected gives way to it, which takes the new one's
 * source line (the editor's scroll sync reads it).
 */
export function restoreMedia(keep: MediaKeep, root: ParentNode): void {
  for (const fresh of mediaIn(root)) {
    const key = markupOf(fresh);
    const old = keep.byMarkup.get(key)?.shift();
    if (!old) {
      markupAtPlacing.set(fresh, key);
      continue;
    }
    const line = fresh.getAttribute("data-source-line");
    if (line === null) old.removeAttribute("data-source-line");
    else old.setAttribute("data-source-line", line);
    fresh.replaceWith(old);
    markupAtPlacing.set(old, key);
    release(fresh);
  }
}

// The new copy, dropped, began fetching its file as soon as its URL was
// set: with no source left and loaded again, it lets the file go now rather
// than when it is collected (the way the HTML spec gives to free a media
// element's resources).
function release(m: HTMLMediaElement): void {
  m.removeAttribute("src");
  m.replaceChildren();
  m.load();
}
