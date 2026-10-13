/**
 * Find spoken words inside note markdown.
 *
 * The voice gets cleaned text ("See the docs for more."), the editor holds the
 * markdown ("See [the docs](https://…) for more."). Comparing only letters and
 * digits makes the two agree; the start is found by the sentence's first words
 * and the end by its last words, so link addresses and markup in between do
 * not matter.
 */

/** Start with four words; a link address inside them hides the match, so fewer are tried next (never a single word of several). */
const HEAD_TRIES = [4, 3, 2];
const TAIL_WORDS = 3;

interface Normalized {
  text: string;
  /** For each character of `text`, its offset in the original string. */
  offsets: number[];
}

function normalize(s: string): Normalized {
  const chars: string[] = [];
  const offsets: number[] = [];
  for (const [i, ch] of [...s].entries()) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      chars.push(ch.toLowerCase());
      offsets.push(i);
    }
  }
  return { text: chars.join(''), offsets };
}

/** Offsets [from, to) in `raw` where `sentence` is written, or null when it cannot be found. */
export function locateSentence(raw: string, sentence: string): [number, number] | null {
  const words = sentence.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return null;
  const n = normalize(raw);
  let head = '';
  let headAt = -1;
  let headWords = 0;
  for (const k of words.length === 1 ? [1] : HEAD_TRIES.filter((k) => k <= words.length)) {
    head = normalize(words.slice(0, k).join('')).text;
    headAt = head ? n.text.indexOf(head) : -1;
    headWords = k;
    if (headAt >= 0) break;
  }
  if (headAt < 0) return null;
  let endAt = headAt + head.length;
  if (words.length > headWords) {
    const tail = normalize(words.slice(-TAIL_WORDS).join('')).text;
    const tailAt = n.text.indexOf(tail, endAt);
    if (tailAt >= 0) endAt = tailAt + tail.length;
  }
  // `raw` offsets count code units; string spread counts code points, so map back through the original.
  const points = [...raw];
  const unit = (point: number) => points.slice(0, point).join('').length;
  return [unit(n.offsets[headAt]), unit(n.offsets[endAt - 1]) + points[n.offsets[endAt - 1]].length];
}
