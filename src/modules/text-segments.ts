import type { TextSegment } from '../shared/protocol';

/**
 * Cuts clean text into the pieces a voice engine speaks one at a time.
 *
 * Small pieces let playback start after the first sentence instead of after
 * the whole chapter, and keep each piece inside the built-in voice's input
 * limit. The pause after a piece depends on what ends there: a sentence, a
 * paragraph, or the chapter title.
 */

const PAUSE_SENTENCE_MS = 60;
const PAUSE_PARAGRAPH_MS = 350;
const PAUSE_TITLE_MS = 500;
/** The optional pause before a chapter's first words (setting "Pause at the start of each chapter"). */
export const CHAPTER_LEAD_MS = 700;

/** Give the first piece the pause before it; the chapter's first words are the ones swallowed at speed. */
export function withChapterLead(segments: TextSegment[], leadMs = CHAPTER_LEAD_MS): TextSegment[] {
  return segments.map((s, i) => (i === 0 ? { ...s, leadMs } : s));
}

/** The first piece stays short so the listener hears something quickly. */
const FIRST_MAX = 140;
const MAX = 300;

/**
 * Sentence ends: punctuation followed by a space, or a line break. A dot right
 * after a one- or two-digit number is an ordinal ("am 7. Oktober", "1. Punkt"),
 * not a sentence end.
 */
export const SENTENCE_END = /(?<!\b\d{1,2})[.!?…]+["')\]]*\s+|\n+/g;

function splitSentences(paragraph: string): string[] {
  const out: string[] = [];
  let start = 0;
  const re = new RegExp(SENTENCE_END.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    const end = m.index + m[0].length;
    const piece = paragraph.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** Break one overlong sentence at commas and the like, else at spaces. */
function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '), window.lastIndexOf(' – '), window.lastIndexOf(' - '));
    if (cut < max * 0.4) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max - 1;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface SegmentOptions {
  /** The text starts with the chapter title on its own line. */
  hasTitle?: boolean;
}

export function toSegments(text: string, options: SegmentOptions = {}): TextSegment[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const segments: TextSegment[] = [];
  paragraphs.forEach((paragraph, pIndex) => {
    const isTitle = !!options.hasTitle && pIndex === 0;
    const sentences = splitSentences(paragraph).flatMap((s) => splitLong(s, MAX));

    let current = '';
    const flush = (pauseMs: number) => {
      if (!current) return;
      segments.push({ text: current, pauseMs, paragraph: pIndex });
      current = '';
    };
    for (const sentence of sentences) {
      const limit = segments.length === 0 ? FIRST_MAX : MAX;
      if (current && current.length + 1 + sentence.length > limit) flush(PAUSE_SENTENCE_MS);
      current = current ? `${current} ${sentence}` : sentence;
      // The very first piece is always one sentence, however short.
      if (segments.length === 0) flush(PAUSE_SENTENCE_MS);
    }
    flush(PAUSE_SENTENCE_MS);
    if (segments.length > 0) {
      segments[segments.length - 1].pauseMs = isTitle ? PAUSE_TITLE_MS : PAUSE_PARAGRAPH_MS;
    }
  });
  return segments;
}

/**
 * Engines reached over the network take bigger bites: fewer requests, and the
 * voice keeps its flow across sentences. Pieces are joined up to `maxChars`;
 * the pause after a group is the pause of its last piece.
 */
export interface SegmentGroup extends TextSegment {
  /** Index of the first piece in the group, so playback positions can be mapped back. */
  segment: number;
}

export function groupSegments(segments: TextSegment[], maxChars: number): SegmentGroup[] {
  const groups: SegmentGroup[] = [];
  for (const [index, segment] of segments.entries()) {
    const last = groups[groups.length - 1];
    // Keep the first group small for a quick start, and never join across a
    // paragraph or title pause: the engine would swallow the silence.
    // A piece with its own pause in front stays separate, else the pause would vanish.
    const joinable =
      last !== undefined &&
      groups.length > 1 &&
      last.pauseMs <= PAUSE_SENTENCE_MS &&
      !segment.leadMs &&
      last.text.length + 1 + segment.text.length <= maxChars;
    if (joinable) {
      // The group keeps the pause before its first piece; the engine speaks
      // the joined sentences in one go.
      last.text = `${last.text} ${segment.text}`;
      last.pauseMs = segment.pauseMs;
    } else {
      groups.push({ ...segment, segment: index });
    }
  }
  return groups;
}

/** Rough listening time for text that has no recording yet. */
export function estimateSeconds(text: string): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0).length;
  return Math.max(1, Math.round((words / 165) * 60));
}
