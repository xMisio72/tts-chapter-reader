import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';
import { locateSentence } from './text-locate';

/**
 * Marks the paragraph being read aloud in the editor, the words being spoken
 * inside it, and keeps them in view.
 *
 * One CodeMirror extension (registered once by the plugin) holds the marked
 * range; the plugin sets or clears it as playback moves.
 */

interface Marked {
  /** Note lines, 0-based, inclusive. */
  from: number;
  to: number;
  /** Document offsets of the words being spoken, when they were found. */
  words: { from: number; to: number } | null;
}

const setMarked = StateEffect.define<Marked | null>();

const readingLine = Decoration.line({ class: 'tcr-reading-line' });
const readingWords = Decoration.mark({ class: 'tcr-reading-words' });

export const readingMarkerExtension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setMarked)) continue;
      if (!effect.value) {
        next = Decoration.none;
        continue;
      }
      const { doc } = tr.state;
      const from = Math.max(0, Math.min(effect.value.from, doc.lines - 1));
      const to = Math.max(from, Math.min(effect.value.to, doc.lines - 1));
      const ranges = [];
      for (let line = from; line <= to; line++) ranges.push(readingLine.range(doc.line(line + 1).from));
      const words = effect.value.words;
      if (words && words.from < words.to && words.to <= doc.length) ranges.push(readingWords.range(words.from, words.to));
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** The CodeMirror view behind an Obsidian editor (live preview and source mode). */
export function editorView(editor: Editor): EditorView | null {
  return (editor as unknown as { cm?: EditorView }).cm ?? null;
}

export class ReadingMarker {
  private current: { view: EditorView; from: number; to: number; sentence: string | null } | null = null;

  /**
   * Mark note lines [from, to] (0-based), the spoken `sentence` inside them when it
   * can be found, and scroll into view if they are off screen.
   */
  show(view: EditorView, from: number, to: number, sentence: string | null = null): void {
    const c = this.current;
    if (c && c.view === view && c.from === from && c.to === to && c.sentence === sentence) return;
    if (c && c.view !== view) this.clear();
    this.current = { view, from, to, sentence };
    const { doc } = view.state;
    const first = doc.line(Math.min(from, doc.lines - 1) + 1);
    const last = doc.line(Math.min(Math.max(to, from), doc.lines - 1) + 1);
    let words: Marked['words'] = null;
    if (sentence) {
      const found = locateSentence(doc.sliceString(first.from, last.to), sentence);
      if (found) words = { from: first.from + found[0], to: first.from + found[1] };
    }
    view.dispatch({
      effects: [setMarked.of({ from, to, words }), EditorView.scrollIntoView(words?.from ?? first.from, { y: 'nearest', yMargin: 80 })],
    });
  }

  clear(): void {
    if (!this.current) return;
    const { view } = this.current;
    this.current = null;
    try {
      view.dispatch({ effects: setMarked.of(null) });
    } catch {
      /* the editor is gone */
    }
  }
}
