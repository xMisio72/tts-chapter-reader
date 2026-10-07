import { getLanguage } from 'obsidian';
import type { SymbolReplacementSettings, TextFilterSettings } from './modules/settings-data';
import { COMPARISON_SYMBOL_TRANSLATIONS } from './lib/translations';

/**
 * Markdown in, spoken text out.
 *
 * Two passes: a line walk that knows which block it is in (properties, code
 * fence, comment, math, table, callout, list, quote) and drops or unwraps
 * whole blocks, then an inline pass over what is left (links, emphasis,
 * code spans, symbols, tags). The settings decide what is skipped and what is
 * read as plain words; without settings the plugin's defaults apply.
 */

interface FilterSettings {
  textFiltering?: TextFilterSettings;
  symbolReplacement?: SymbolReplacementSettings;
}

interface ComparisonWords {
  greaterThan: string;
  lessThan: string;
  greaterThanOrEqual: string;
  lessThanOrEqual: string;
}

type LanguageCode = keyof typeof COMPARISON_SYMBOL_TRANSLATIONS;

const KNOWN_LANGUAGES: ReadonlySet<string> = new Set(Object.keys(COMPARISON_SYMBOL_TRANSLATIONS));

/** Obsidian's interface language when it is one we have words for, else the system's, else English. */
export function detectUserLanguage(): string {
  const candidates: string[] = [];
  try {
    candidates.push(getLanguage());
  } catch {
    /* no getLanguage() in this Obsidian */
  }
  if (typeof navigator !== 'undefined') candidates.push(navigator.language);
  for (const candidate of candidates) {
    const code = (candidate ?? '').split('-')[0].toLowerCase();
    if (KNOWN_LANGUAGES.has(code)) return code;
  }
  return 'en';
}

export function getComparisonTranslations(settings: FilterSettings): ComparisonWords {
  const symbols = settings.symbolReplacement;
  if (!symbols) return COMPARISON_SYMBOL_TRANSLATIONS.en;
  if (symbols.enableCustomReplacements) return symbols.customReplacements;
  const code = symbols.language === 'auto' ? detectUserLanguage() : symbols.language;
  return COMPARISON_SYMBOL_TRANSLATIONS[code as LanguageCode] ?? COMPARISON_SYMBOL_TRANSLATIONS.en;
}

/**
 * Lines where < and > are markup or addresses, not comparisons. Inside
 * filterMarkdown the quote marker and bare addresses are already gone; the
 * two checks stay for callers that pass raw text.
 */
function hasAngleMarkup(line: string): boolean {
  return /^\s*>/.test(line) || /<[^>]*>/.test(line) || /https?:\/\//.test(line) || /\S+@\S+\.\S+/.test(line);
}

/**
 * "a > b" becomes "a greater than b" (and the other three), as many times as
 * a line needs it. Callers that filter many lines pass the resolved words once.
 */
export function replaceComparisonSymbols(text: string, settings?: FilterSettings, words?: ComparisonWords): string {
  if (!settings?.textFiltering?.replaceComparisonSymbols) {
    // Off: the single Unicode signs, which voices pronounce on their own.
    return text.replace(/>=/g, '≥').replace(/<=/g, '≤');
  }
  const w = words ?? getComparisonTranslations(settings);
  // The patterns eat the spaces around the sign, so the word brings its own (also a custom "greater than").
  const pad = (word: string) => ` ${word.trim()} `;
  const spoken: [RegExp, string][] = [
    [/(\w)\s*>=\s*(?=\w)/g, `$1${pad(w.greaterThanOrEqual)}`],
    [/(\w)\s*<=\s*(?=\w)/g, `$1${pad(w.lessThanOrEqual)}`],
    [/(\w)\s*>\s*(?=\w)/g, `$1${pad(w.greaterThan)}`],
    [/(\w)\s*<\s*(?=\w)/g, `$1${pad(w.lessThan)}`],
  ];
  return text
    .split('\n')
    .map((line) => (hasAngleMarkup(line) ? line : spoken.reduce((acc, [pattern, word]) => acc.replace(pattern, word), line)))
    .join('\n');
}

/** Filters that are on when the caller passes no settings (the plugin's defaults). */
const DEFAULT_ON: ReadonlySet<keyof TextFilterSettings> = new Set(['filterFrontmatter', 'filterCodeBlocks', 'filterInlineCode', 'filterHtmlTags']);

const FENCE_OPEN = /^[ \t]*(`{3,}|~{3,})/;
const HEADING = /^#{1,6}[ \t]+/;
const BULLET = /^[ \t]*[-+*][ \t]+/;
const NUMBERED = /^[ \t]*\d+[.)][ \t]+/;
const QUOTE = /^[ \t]*>[ \t]?/;
const CALLOUT = /^[ \t]*>[ \t]*\[![^\]]*\][+-]?[ \t]*/;
const RULE = /^[ \t]*(?:-[ \t]*){3,}$|^[ \t]*(?:\*[ \t]*){3,}$|^[ \t]*(?:_[ \t]*){3,}$/;
const TABLE_ROW = /^[ \t]*\|.*\|[ \t]*$/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:/;
const BLOCK_ID = /[ \t]+\^[A-Za-z0-9-]+[ \t]*$/;

/**
 * The block pass: returns the lines worth speaking, with block markup gone.
 * Each bullet becomes its own paragraph, which gives the voice a pause.
 */
function blockPass(markdown: string, on: (key: keyof TextFilterSettings) => boolean): string[] {
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  let i = 0;

  // Properties: a `---` block at the very top.
  if (on('filterFrontmatter') && lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, k) => k > 0 && l.trim() === '---');
    if (end > 0) i = end + 1;
  }

  let fence: { char: string; length: number } | null = null;
  let inHtmlComment = false;
  let inObsidianComment = false;
  let inMath = false;
  let inCallout = false;

  for (; i < lines.length; i++) {
    let line = lines[i];

    // Inside a fence: swallow or keep the code until the matching close; the fence lines themselves are never spoken.
    if (fence) {
      const close = FENCE_OPEN.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length && line.trim() === close[1]) {
        fence = null;
        continue;
      }
      if (!on('filterCodeBlocks')) out.push(line);
      continue;
    }
    const open = FENCE_OPEN.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      continue;
    }

    // Comments and display math span lines; their inner lines are not spoken.
    // Words after a closing marker are spoken (the closing line goes on below).
    if (on('filterComments')) {
      if (inHtmlComment) {
        const at = line.indexOf('-->');
        if (at === -1) continue;
        inHtmlComment = false;
        line = line.slice(at + 3).trimStart();
        if (line === '') continue;
      }
      if (inObsidianComment) {
        const at = line.indexOf('%%');
        if (at === -1) continue;
        inObsidianComment = false;
        line = line.slice(at + 2).trimStart();
        if (line === '') continue;
      }
      if (line.includes('<!--') && !line.includes('-->')) {
        inHtmlComment = true;
        out.push(line.slice(0, line.indexOf('<!--')));
        continue;
      }
      const marks = (line.match(/%%/g) ?? []).length;
      if (marks % 2 === 1) {
        inObsidianComment = true;
        out.push(line.slice(0, line.lastIndexOf('%%')));
        continue;
      }
    }
    if (on('filterMathExpressions')) {
      const fences = (line.match(/\$\$/g) ?? []).length;
      if (inMath) {
        if (fences % 2 === 1) inMath = false;
        continue;
      }
      if (fences % 2 === 1) {
        inMath = true;
        continue;
      }
    }

    if (on('filterTables') && TABLE_ROW.test(line)) continue;
    if (on('filterFootnotes') && FOOTNOTE_DEFINITION.test(line)) continue;
    if (RULE.test(line)) continue;

    let text = line;
    if (on('filterCallouts') && CALLOUT.test(text)) {
      // "> [!note] Title" starts a callout: the type marker goes, the text stays.
      text = text.replace(CALLOUT, '');
      inCallout = true;
    } else if (inCallout && QUOTE.test(text)) {
      text = text.replace(QUOTE, '');
    } else {
      if (text.trim() !== '') inCallout = false;
      text = text.replace(QUOTE, '');
    }

    text = text.replace(HEADING, '').replace(BLOCK_ID, '');
    if (BULLET.test(text)) {
      // A bullet is a paragraph of its own; a numbered step reads on.
      out.push('');
      text = text.replace(BULLET, '');
    } else if (NUMBERED.test(text)) {
      text = text.replace(NUMBERED, '');
    }
    out.push(text);
  }
  return out;
}

/** The inline pass over one line: links, marks and spans become words. */
function inlinePass(line: string, on: (key: keyof TextFilterSettings) => boolean, settings: FilterSettings, words?: ComparisonWords): string {
  let s = line;
  if (on('filterComments')) s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/%%[^%]*%%/g, '');
  if (on('filterMathExpressions')) s = s.replace(/\$\$[^$]*\$\$/g, '').replace(/\$[^$\n]+\$/g, '');
  if (on('filterImages')) s = s.replace(/!\[\[[^\]]*\]\]/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  // Links of both kinds: the words stay, the address goes (or the whole link, if asked).
  const skipLinks = on('filterMarkdownLinks');
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, skipLinks ? '' : '$1');
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, skipLinks ? '' : '$2').replace(/\[\[([^\]]*)\]\]/g, skipLinks ? '' : '$1');
  s = s.replace(/https?:\/\/\S+/g, '');
  if (on('filterFootnotes')) s = s.replace(/\[\^[^\]]+\]/g, '');
  s = s.replace(/\[[ xX]\][ \t]*/g, '');
  // Emphasis marks go, words stay; underscores inside identifiers are left alone.
  s = s.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/\*([^*\n]+)\*/g, '$1');
  s = s.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, '$1$2');
  if (on('filterInlineCode')) s = s.replace(/`([^`\n]*)`/g, '$1');
  if (on('filterHighlights')) s = s.replace(/==([^=\n]+)==/g, '$1');
  s = s.replace(/~~([^~\n]+)~~/g, '$1');
  // Comparisons before tags: a line with a tag keeps its signs, so "a <b and c> d" is not eaten as a tag.
  s = replaceComparisonSymbols(s, settings, words);
  if (on('filterHtmlTags')) s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
  return s;
}

/** Turn Markdown into the plain text a voice should say. */
export function filterMarkdown(text: string, textFiltering?: TextFilterSettings, symbolReplacement?: SymbolReplacementSettings): string {
  const on = (key: keyof TextFilterSettings): boolean => (textFiltering ? textFiltering[key] : DEFAULT_ON.has(key));
  const settings: FilterSettings = { textFiltering, symbolReplacement };
  const words = textFiltering?.replaceComparisonSymbols ? getComparisonTranslations(settings) : undefined;
  const spoken = blockPass(text, on).map((line) => inlinePass(line, on, settings, words));
  return spoken
    .join('\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
