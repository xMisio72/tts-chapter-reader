import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView } from '@codemirror/view';
import type { Editor } from 'obsidian';

/**
 * Marks the paragraph being read aloud in the editor and keeps it in view.
 *
 * One CodeMirror extension (registered once by the plugin) holds the marked
 * line range; the plugin sets or clears it as playback moves.
 */

interface LineRange {
  from: number;
  to: number;
}

const setRange = StateEffect.define<LineRange | null>();

const readingLine = Decoration.line({ class: 'tcr-reading-line' });

export const readingMarkerExtension = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    let next = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(setRange)) continue;
      if (!effect.value) {
        next = Decoration.none;
        continue;
      }
      const { doc } = tr.state;
      const from = Math.max(0, Math.min(effect.value.from, doc.lines - 1));
      const to = Math.max(from, Math.min(effect.value.to, doc.lines - 1));
      const ranges = [];
      for (let line = from; line <= to; line++) ranges.push(readingLine.range(doc.line(line + 1).from));
      next = Decoration.set(ranges);
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
  private current: { view: EditorView; from: number; to: number } | null = null;

  /** Mark note lines [from, to] (0-based) and scroll them into view if they are off screen. */
  show(view: EditorView, from: number, to: number): void {
    if (this.current && this.current.view === view && this.current.from === from && this.current.to === to) return;
    if (this.current && this.current.view !== view) this.clear();
    this.current = { view, from, to };
    const lines = view.state.doc.lines;
    const first = Math.min(from, lines - 1);
    view.dispatch({
      effects: [setRange.of({ from, to }), EditorView.scrollIntoView(view.state.doc.line(first + 1).from, { y: 'nearest', yMargin: 80 })],
    });
  }

  clear(): void {
    if (!this.current) return;
    const { view } = this.current;
    this.current = null;
    try {
      view.dispatch({ effects: setRange.of(null) });
    } catch {
      /* the editor is gone */
    }
  }
}
