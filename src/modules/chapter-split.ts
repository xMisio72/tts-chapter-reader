/**
 * Splits a note into chapters: one per heading.
 *
 * Pure text in, plain data out, so it can be tested without Obsidian. The
 * caller passes `clean`, which turns Markdown into the text that is spoken.
 */

export interface ChapterText {
  /** Shown in the chapter list. */
  title: string;
  /** Stable name for favorite/hidden flags: the lowercased title, with "~n"
   *  appended when the same title appears more than once in the note. */
  key: string;
  /** Heading level 1-6; 0 for text that comes before the first heading. */
  level: number;
  /** What the voice says, title included when titles are read aloud. */
  text: string;
  /** The spoken text starts with the title on its own line. */
  hasTitle: boolean;
  /** Nothing to say (for example a section that holds only images). */
  empty: boolean;
  /** Line of the heading in the note (0-based); 0 for the opening text. */
  line: number;
  /** Last line of the chapter in the note (0-based, inclusive). */
  endLine: number;
  /**
   * Note lines [first, last] of each spoken paragraph, in the order of the
   * paragraphs in `text`. Null when the spoken paragraphs could not be
   * matched to the note (the whole chapter is then the best guess).
   */
  paragraphLines: [number, number][] | null;
}

export interface SplitOptions {
  /** Used as the title of the text before the first heading. */
  noteTitle: string;
  /** Say each heading before its text. */
  readHeadings: boolean;
  /** Markdown to spoken text. */
  clean: (markdown: string) => string;
}

const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;
const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
/** A fence opens with three or more backticks or tildes and closes with at least as many of the same. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Tracks what a line is inside of while scanning a note: a code fence, an
 * Obsidian `%% %%` comment or an HTML comment. A heading inside any of these
 * is not a chapter; a comment that spans headings must stay in one piece so
 * the text filter can remove it whole.
 */
class LineScanner {
  private fence: string | null = null;
  private obsidianComment = false;
  private htmlComment = false;

  /** True when `line` may start a chapter (called before `advance`). */
  canHead(line: string): boolean {
    return this.fence === null && !this.obsidianComment && !this.htmlComment && !FENCE.test(line);
  }

  /** Whether the line itself is inside a fence or comment, before it is consumed. */
  get hidden(): boolean {
    return this.fence !== null || this.obsidianComment || this.htmlComment;
  }

  advance(line: string): void {
    if (!this.obsidianComment && !this.htmlComment) {
      const m = FENCE.exec(line);
      if (m) {
        if (this.fence === null) this.fence = m[1];
        else if (m[1][0] === this.fence[0] && m[1].length >= this.fence.length) this.fence = null;
      }
    }
    if (this.fence !== null) return;
    // Comment markers toggle; a pair on one line opens and closes again.
    const obsidian = (line.match(/%%/g) ?? []).length;
    if (obsidian % 2 === 1) this.obsidianComment = !this.obsidianComment;
    const opens = (line.match(/<!--/g) ?? []).length;
    const closes = (line.match(/-->/g) ?? []).length;
    if (opens > closes) this.htmlComment = true;
    else if (closes > opens) this.htmlComment = false;
  }
}

function assignKeys(titles: string[]): string[] {
  const seen = new Map<string, number>();
  return titles.map((title, i) => {
    const base = (title || `§${i}`).trim().toLowerCase();
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}~${n}`;
  });
}

/** A title ends in punctuation when spoken, so the voice drops and pauses. */
function spokenTitle(title: string): string {
  return /[.!?…:]$/.test(title) ? title : `${title}.`;
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Which note lines each spoken paragraph comes from. The body is cut into
 * blocks at blank lines (fences kept whole), each block is cleaned on its
 * own, and its spoken paragraphs point back at the block's lines. If that
 * does not add up to the chapter's spoken paragraphs, the match is unknown.
 */
function mapParagraphs(bodyLines: string[], firstLine: number, clean: (markdown: string) => string, spokenParagraphs: number): [number, number][] | null {
  const result: [number, number][] = [];
  let start = -1;
  const scanner = new LineScanner();
  const flush = (end: number) => {
    if (start < 0) return;
    const block = bodyLines.slice(start, end + 1).join('\n');
    const count = paragraphsOf(clean(block)).length;
    for (let k = 0; k < count; k++) result.push([firstLine + start, firstLine + end]);
    start = -1;
  };
  bodyLines.forEach((line, i) => {
    // A blank line inside a fence or comment does not end the block.
    const blank = !scanner.hidden && line.trim().length === 0;
    scanner.advance(line);
    if (blank) flush(i - 1);
    else if (start < 0) start = i;
  });
  flush(bodyLines.length - 1);
  return result.length === spokenParagraphs ? result : null;
}

export function splitIntoChapters(markdown: string, options: SplitOptions): ChapterText[] {
  const frontmatter = FRONTMATTER.exec(markdown);
  const skippedLines = frontmatter ? frontmatter[0].split('\n').length - 1 : 0;
  const lines = (frontmatter ? markdown.slice(frontmatter[0].length) : markdown).split(/\r?\n/);

  interface Raw { title: string; level: number; line: number; body: string[] }
  const raws: Raw[] = [{ title: '', level: 0, line: 0, body: [] }];
  const scanner = new LineScanner();

  lines.forEach((line, index) => {
    const heading = scanner.canHead(line) ? HEADING.exec(line) : null;
    scanner.advance(line);
    if (heading) {
      raws.push({ title: heading[2], level: heading[1].length, line: index + skippedLines, body: [] });
    } else {
      raws[raws.length - 1].body.push(line);
    }
  });

  const hasHeadings = raws.length > 1;
  const chapters = raws
    .map((raw, r) => {
      const body = options.clean(raw.body.join('\n')).trim();
      // The body's first note line: right after the heading (or the frontmatter).
      const bodyLine = raw.level === 0 ? skippedLines : raw.line + 1;
      const next = raws[r + 1];
      const endLine = next ? next.line - 1 : skippedLines + lines.length - 1;
      const bodyMap = (spoken: string, titleLine: number | null) => {
        const n = paragraphsOf(spoken).length - (titleLine === null ? 0 : 1);
        const mapped = mapParagraphs(raw.body, bodyLine, options.clean, n);
        if (!mapped) return null;
        return titleLine === null ? mapped : [[titleLine, titleLine] as [number, number], ...mapped];
      };
      if (raw.level === 0) {
        // Text before the first heading. Its title is the note itself, which
        // is only announced when the note goes on to have real chapters.
        const say = hasHeadings && options.readHeadings && body.length > 0;
        const text = say ? `${spokenTitle(options.noteTitle)}\n\n${body}` : body;
        return {
          title: options.noteTitle,
          level: 0,
          line: 0,
          endLine,
          hasTitle: say,
          text,
          empty: body.length === 0,
          paragraphLines: bodyMap(text, say ? bodyLine : null),
        };
      }
      const title = options.clean(raw.title).replace(/\s+/g, ' ').trim() || raw.title.trim();
      const say = options.readHeadings && title.length > 0;
      const text = say ? (body ? `${spokenTitle(title)}\n\n${body}` : spokenTitle(title)) : body;
      return {
        title,
        level: raw.level,
        line: raw.line,
        endLine,
        hasTitle: say,
        text,
        empty: text.length === 0,
        paragraphLines: bodyMap(text, say ? raw.line : null),
      };
    })
    // The opening text only counts as a chapter when it says something.
    .filter((c, i) => !(i === 0 && c.empty && hasHeadings));

  const keys = assignKeys(chapters.map((c) => c.title));
  return chapters.map((c, i) => ({ ...c, key: keys[i] }));
}
