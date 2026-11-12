// Fuzzy matching for the command palette (palette.ts). What is typed is
// matched against a label without accents or case: "attivita" finds
// "Attività", "strasse" finds "Straße", and the full-width letters a Chinese
// or Japanese IME may type find the plain ones (NFKD rather than NFD, so
// those fold too). Every word of the query must be found, as one piece
// first, else letter by letter in order ("sapdf" finds "Save as PDF"). The
// score is fzf's scheme, kept small: points for each letter, more for word
// starts (after a space, a dash or a slash, a camelCase hump, every CJK
// character, the start of the label) and for letters in a row, a cost for
// the letters skipped. Pure and deterministic: no DOM, tested with Node.

export interface Prepared {
  /** the label as given */
  readonly text: string;
  /** what queries are matched against: no accents, lower case, ß as ss */
  readonly folded: string;
  /** for each folded character, the index in `text` of the character it came from */
  readonly from: Int32Array;
  /** for each folded character, what a match there earns on top (word starts) */
  readonly bonus: Uint8Array;
}

export interface Match {
  score: number;
  /** the matched characters, as indices into the original text, in order */
  hits: number[];
}

/** A label to match, and optionally the label with more words that find it. */
export interface Target {
  readonly label: Prepared;
  readonly all: Prepared | null;
}

// the score, as in fzf: a matched letter is worth MATCH; a gap costs
// GAP_START for its first skipped letter and GAP_EXT for each further one
const MATCH = 16;
const GAP_START = 3;
const GAP_EXT = 1;
// a letter right after the previous match earns at least this much
const CONSECUTIVE = 4;
// the query's first letter counts its bonus twice: where a word begins matters most
const FIRST_MULT = 2;
// where a match starts: the label's start, after a space, after punctuation,
// a CJK character (each one is a word), a camelCase hump or a digit run
const B_START = 12;
const B_WHITE = 10;
const B_DELIM = 9;
const B_BOUNDARY = 8;
const B_CAMEL = 7;
// words found only among the extra ones (keywords, a folder) count for less
// than the same words in the label itself
const EXTRA_FACTOR = 0.8;
// beyond these, a word is matched letter by letter the greedy way, without
// looking for the best spread (the work grows with their product)
const MAX_WORD = 32;
const MAX_TEXT = 512;

// what a character is, for the word starts
const SPACE = 0;
const PUNCT = 1;
const LOWER = 2;
const UPPER = 3;
const DIGIT = 4;
const LETTER = 5; // letters without case (Arabic, Thai…)
const CJK = 6;
const MARK = 7; // combining marks: part of the letter before them

const ASCII_RE = /^[\x00-\x7f]*$/;
const KIND_RE =
  /^(?:(\s)|([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])|([\p{Lu}\p{Lt}])|(\p{Ll})|(\p{L})|(\p{N})|(\p{M}))/u;
const MARKS_RE = /\p{M}+/gu;
const MARK_RE = /^\p{M}$/u;
// letters NFKD leaves whole, folded as people type them without the key
const LETTERS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
  ς: "σ",
  "’": "'",
  "‘": "'",
};
const LETTERS_RE = /[ßæœøłđðþıς‘’]/gu;
const ASCII_LOWER = Array.from({ length: 128 }, (_, c) => String.fromCharCode(c >= 65 && c <= 90 ? c + 32 : c));

// non-ASCII characters seen before, folded (for one locale at a time) and
// classified once
const folds = new Map<number, string>();
let foldsLocale: string | undefined;
const kinds = new Map<number, number>();

function asciiKind(c: number): number {
  if (c >= 97 && c <= 122) return LOWER;
  if (c >= 65 && c <= 90) return UPPER;
  if (c >= 48 && c <= 57) return DIGIT;
  if (c === 32 || (c >= 9 && c <= 13)) return SPACE;
  return PUNCT;
}

function kindOf(cp: number, ch: string): number {
  if (cp < 128) return asciiKind(cp);
  let k = kinds.get(cp);
  if (k === undefined) {
    const m = KIND_RE.exec(ch);
    k = !m ? PUNCT : m[1] ? SPACE : m[2] ? CJK : m[3] ? UPPER : m[4] ? LOWER : m[5] ? LETTER : m[6] ? DIGIT : MARK;
    if (kinds.size > 8192) kinds.clear();
    kinds.set(cp, k);
  }
  return k;
}

// One character as it is matched: compatibility forms undone (full-width
// letters, ligatures), accents dropped, lower case, then the letters with no
// decomposition. A lone combining mark folds to nothing.
function foldChar(cp: number, ch: string, locale: string | undefined): string {
  if (locale !== foldsLocale) {
    folds.clear();
    foldsLocale = locale;
  }
  let f = folds.get(cp);
  if (f === undefined) {
    f = ch.normalize("NFKD").replace(MARKS_RE, "");
    f = locale ? f.toLocaleLowerCase(locale) : f.toLowerCase();
    f = f.replace(LETTERS_RE, (c) => LETTERS[c] ?? c);
    if (folds.size > 8192) folds.clear();
    folds.set(cp, f);
  }
  return f;
}

// what a match on a character of kind `cur` earns, after one of kind `prev`
// (-1: none, the start of the label)
function bonusOf(prev: number, cur: number): number {
  if (cur === SPACE || cur === PUNCT || cur === MARK) return 0;
  if (prev < 0) return B_START;
  if (prev === SPACE) return B_WHITE;
  if (prev === PUNCT) return B_DELIM;
  if (cur === CJK || prev === CJK) return B_BOUNDARY;
  if (cur === UPPER && prev === LOWER) return B_CAMEL;
  if ((cur === DIGIT) !== (prev === DIGIT)) return B_CAMEL;
  return 0;
}

function prepareAscii(text: string): Prepared {
  const n = text.length;
  const from = new Int32Array(n);
  const bonus = new Uint8Array(n);
  let prev = -1;
  for (let i = 0; i < n; i++) {
    const k = asciiKind(text.charCodeAt(i));
    bonus[i] = bonusOf(prev, k);
    from[i] = i;
    prev = k;
  }
  return { text, folded: text.toLowerCase(), from, bonus };
}

/** Folds `text` for matching, keeping where each folded character came from. */
export function prepare(text: string, locale?: string): Prepared {
  // most labels and file names: one character each, no lookups
  if (ASCII_RE.test(text)) return prepareAscii(text);
  let folded = "";
  const from: number[] = [];
  const bonus: number[] = [];
  let prev = -1;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = cp > 0xffff ? text.slice(i, i + 2) : text[i];
    const k = kindOf(cp, ch);
    const f = cp < 128 ? ASCII_LOWER[cp] : foldChar(cp, ch, locale);
    const b = bonusOf(prev, k);
    // "ß" becomes two letters: the first takes its place as a word start
    for (let j = 0; j < f.length; j++) {
      from.push(i);
      bonus.push(j === 0 ? b : 0);
    }
    folded += f;
    // a combining mark belongs to its letter: the next one follows that letter
    if (k !== MARK) prev = k;
    i += ch.length;
  }
  return { text, folded, from: Int32Array.from(from), bonus: Uint8Array.from(bonus) };
}

/** The words of a query, folded as labels are; none for a blank one. */
export function words(query: string, locale?: string): string[] {
  return [...new Set(prepare(query, locale).folded.split(/\s+/).filter(Boolean))];
}

/** A label to match, with `extra` words (keywords, a folder) that find it too. */
export function target(label: string, extra?: string | null, locale?: string): Target {
  return { label: prepare(label, locale), all: extra ? prepare(`${label}\n${extra}`, locale) : null };
}

// a run of `len` letters from `at`, all in a row: letters after the first
// keep the bonus their run started with, unless a better word start comes
function runScore(b: Uint8Array, at: number, len: number): number {
  let chunk = b[at];
  let s = MATCH + chunk * FIRST_MULT;
  for (let k = 1; k < len; k++) {
    const bk = b[at + k];
    if (bk >= B_BOUNDARY && bk > chunk) chunk = bk;
    s += MATCH + Math.max(bk, chunk, CONSECUTIVE);
  }
  return s;
}

/** The score of the letters of a word matched at `at` (folded indices, rising). */
function alignScore(b: Uint8Array, at: readonly number[]): number {
  let s = 0;
  let chunk = 0;
  for (let i = 0; i < at.length; i++) {
    const j = at[i];
    const bj = b[j];
    if (i === 0) {
      s += MATCH + bj * FIRST_MULT;
      chunk = bj;
      continue;
    }
    const gap = j - at[i - 1] - 1;
    if (gap === 0) {
      if (bj >= B_BOUNDARY && bj > chunk) chunk = bj;
      s += MATCH + Math.max(bj, chunk, CONSECUTIVE);
    } else {
      s += MATCH + bj - GAP_START - (gap - 1) * GAP_EXT;
      chunk = bj;
    }
  }
  return s;
}

// the matrix of the letter-by-letter match, kept between calls
let cells = new Float64Array(0);
let back = new Int32Array(0);
let chunks = new Uint8Array(0);

// The best spread of `w`'s letters over the label, in order: for each letter
// of the word and each place it can take, the best score of the word so far
// ending there, either right after the previous letter (keeping its run) or
// after a gap (costing it). Each letter only looks at the places between its
// earliest and latest possible ones.
function subsequence(w: string, p: Prepared): { score: number; at: number[] } | null {
  const f = p.folded;
  const b = p.bonus;
  const n = f.length;
  const m = w.length;
  if (m === 0 || m > n) return null;
  const first = new Int32Array(m);
  const last = new Int32Array(m);
  for (let i = 0, j = 0; i < m; i++, j++) {
    j = f.indexOf(w[i], j);
    if (j < 0) return null;
    first[i] = j;
  }
  for (let i = m - 1, j = n - 1; i >= 0; i--, j--) {
    j = f.lastIndexOf(w[i], j);
    last[i] = j;
  }
  if (m > MAX_WORD || n > MAX_TEXT) {
    const at = [...first];
    return { score: alignScore(b, at), at };
  }

  const size = m * n;
  if (cells.length < size) {
    cells = new Float64Array(size);
    back = new Int32Array(size);
    chunks = new Uint8Array(size);
  }
  cells.fill(-Infinity, 0, size);
  const c0 = w.charCodeAt(0);
  for (let j = first[0]; j <= last[0]; j++) {
    if (f.charCodeAt(j) !== c0) continue;
    cells[j] = MATCH + b[j] * FIRST_MULT;
    chunks[j] = b[j];
    back[j] = -1;
  }
  for (let i = 1; i < m; i++) {
    const row = i * n;
    const prow = row - n;
    const c = w.charCodeAt(i);
    const lo = first[i];
    const hi = last[i];
    const from0 = first[i - 1];
    // the best predecessor two or more places back, with its gap paid
    let gap = -Infinity;
    let gapFrom = -1;
    for (let k = from0; k <= lo - 2; k++) {
      const s = cells[prow + k] - GAP_START - (lo - 2 - k) * GAP_EXT;
      if (s > gap) {
        gap = s;
        gapFrom = k;
      }
    }
    for (let j = lo; j <= hi; j++) {
      if (j > lo) {
        // one place further: every gap grows by one, and j - 2 joins them
        gap -= GAP_EXT;
        const k = j - 2;
        if (k >= from0) {
          const s = cells[prow + k] - GAP_START;
          if (s > gap) {
            gap = s;
            gapFrom = k;
          }
        }
      }
      if (f.charCodeAt(j) !== c) continue;
      const bj = b[j];
      let best = -Infinity;
      let from = -1;
      let chunk = bj;
      const diag = cells[prow + j - 1];
      if (diag > -Infinity) {
        let run = chunks[prow + j - 1];
        if (bj >= B_BOUNDARY && bj > run) run = bj;
        best = diag + MATCH + Math.max(bj, run, CONSECUTIVE);
        from = j - 1;
        chunk = run;
      }
      if (gap > -Infinity && gap + MATCH + bj > best) {
        best = gap + MATCH + bj;
        from = gapFrom;
        chunk = bj;
      }
      if (best > -Infinity) {
        cells[row + j] = best;
        back[row + j] = from;
        chunks[row + j] = chunk;
      }
    }
  }
  // the best end (the earliest of equals), then back to the first letter
  const row = (m - 1) * n;
  let end = -1;
  let top = -Infinity;
  for (let j = first[m - 1]; j <= last[m - 1]; j++) {
    if (cells[row + j] > top) {
      top = cells[row + j];
      end = j;
    }
  }
  if (end < 0) return null;
  const at = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    at[i] = j;
    j = back[i * n + j];
  }
  return { score: top, at };
}

// One word: its best place as one piece (the earliest of equals), else, unless
// only whole pieces count, its best spread letter by letter.
function matchWord(w: string, p: Prepared, contiguous: boolean): { score: number; at: number[] } | null {
  const f = p.folded;
  let best = -Infinity;
  let start = -1;
  for (let i = f.indexOf(w); i >= 0; i = f.indexOf(w, i + 1)) {
    const s = runScore(p.bonus, i, w.length);
    if (s > best) {
      best = s;
      start = i;
    }
  }
  if (start >= 0) {
    const at = new Array<number>(w.length);
    for (let k = 0; k < w.length; k++) at[k] = start + k;
    return { score: best, at };
  }
  if (contiguous) return null;
  // letters strewn all over a long label ("readme" in "Chercher dans le
  // document") are no match: each must earn its own points despite the gaps
  const spread = subsequence(w, p);
  return spread && spread.score >= MATCH * w.length ? spread : null;
}

/**
 * Matches every word of `query` (a string, or words() of one) in `p`; null
 * when one is missing. `contiguous`: each word only as one piece.
 */
export function match(query: string | readonly string[], p: Prepared, opts: { contiguous?: boolean } = {}): Match | null {
  const ws = typeof query === "string" ? words(query) : query;
  let score = 0;
  const hits = new Set<number>();
  for (const w of ws) {
    const m = matchWord(w, p, opts.contiguous === true);
    if (!m) return null;
    score += m.score;
    for (const j of m.at) hits.add(p.from[j]);
  }
  return { score, hits: [...hits].sort((a, b) => a - b) };
}

/**
 * Matches `query` against a target: its label, letter by letter if need be,
 * or the label with its extra words, each word as one piece and the score
 * discounted ("print" finds "Stampa" through its English keyword; "docs
 * readme" finds README.md in the docs folder). The hits are always in the
 * label: there, every word it holds as one piece, whichever of the two
 * matches ranked it ("in" bold in "Windows", found by its section
 * "Installazione"); none for the words only among the extra ones, nor
 * letters strewn about.
 */
export function score(query: readonly string[], t: Target): Match | null {
  const own = match(query, t.label);
  if (!t.all) return own;
  const wide = match(query, t.all, { contiguous: true });
  if (!wide) return own;
  const discounted = wide.score * EXTRA_FACTOR;
  if (own && own.score >= discounted) return own;
  const hits = new Set<number>();
  for (const w of query) {
    const m = matchWord(w, t.label, true);
    if (m) for (const j of m.at) hits.add(t.label.from[j]);
  }
  return { score: discounted, hits: [...hits].sort((a, b) => a - b) };
}

/**
 * Splits `text` into runs of matched and unmatched characters, for drawing
 * the hits in bold. A combining mark goes with its letter.
 */
export function runs(text: string, hits: readonly number[]): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const set = new Set(hits);
  let cur = "";
  let curHit = false;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const ch = cp > 0xffff ? text.slice(i, i + 2) : text[i];
    const hit: boolean = set.has(i) || (curHit && cur !== "" && cp >= 0x300 && MARK_RE.test(ch));
    if (hit !== curHit && cur) {
      out.push({ text: cur, hit: curHit });
      cur = "";
    }
    curHit = hit;
    cur += ch;
    i += ch.length;
  }
  if (cur) out.push({ text: cur, hit: curHit });
  return out;
}
