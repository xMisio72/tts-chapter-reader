import { francAll } from 'franc-min';

/**
 * Which language a chapter is written in, so the plugin knows whether the
 * voice can read it as it is.
 *
 * Detection runs on this computer (letter-trigram statistics, no network).
 * It is reliable on a paragraph and useless on a two-word heading, so short
 * chapters take the language of the note around them.
 */

/** Below this many letters the guess is noise. */
const MIN_CHARS = 60;
/** When English scores this close to the winner, the text is treated as English: a
 *  wrong "translate" costs the user a download, a wrong "English" costs nothing. */
const ENGLISH_MARGIN = 0.08;

/** ISO 639-3 (what the detector returns) → ISO 639-1 (what the models use). */
const ISO_639_1: Record<string, string> = {
  eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', nld: 'nl', por: 'pt', rus: 'ru', pol: 'pl',
  swe: 'sv', dan: 'da', nob: 'no', nno: 'no', fin: 'fi', ces: 'cs', slk: 'sk', hun: 'hu', ron: 'ro',
  tur: 'tr', ell: 'el', ukr: 'uk', bul: 'bg', hrv: 'hr', srp: 'sr', slv: 'sl', lit: 'lt', lav: 'lv',
  est: 'et', ind: 'id', vie: 'vi', tha: 'th', jpn: 'ja', kor: 'ko', cmn: 'zh', arb: 'ar', heb: 'he',
  hin: 'hi', ben: 'bn', fas: 'fa', urd: 'ur', cat: 'ca', glg: 'gl', eus: 'eu', afr: 'af', swh: 'sw',
  tgl: 'tl', msa: 'ms', tam: 'ta', tel: 'te', mar: 'mr', guj: 'gu', kan: 'kn', mal: 'ml', pan: 'pa',
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian', nl: 'Dutch', pt: 'Portuguese',
  ru: 'Russian', pl: 'Polish', sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', cs: 'Czech',
  sk: 'Slovak', hu: 'Hungarian', ro: 'Romanian', tr: 'Turkish', el: 'Greek', uk: 'Ukrainian', bg: 'Bulgarian',
  hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian', et: 'Estonian',
  id: 'Indonesian', vi: 'Vietnamese', th: 'Thai', ja: 'Japanese', ko: 'Korean', zh: 'Chinese', ar: 'Arabic',
  he: 'Hebrew', hi: 'Hindi', bn: 'Bengali', fa: 'Persian', ur: 'Urdu', ca: 'Catalan', gl: 'Galician',
  eu: 'Basque', af: 'Afrikaans', sw: 'Swahili', tl: 'Tagalog', ms: 'Malay', ta: 'Tamil', te: 'Telugu',
  mr: 'Marathi', gu: 'Gujarati', kn: 'Kannada', ml: 'Malayalam', pa: 'Punjabi',
};

export function languageName(code: string): string {
  return LANGUAGE_NAMES[code] ?? code.toUpperCase();
}

/** The language of `text`, as ISO 639-1, or null when the text is too short to tell. */
export function detectLanguage(text: string): string | null {
  const letters = text.replace(/[^\p{L}]/gu, '');
  if (letters.length < MIN_CHARS) return null;
  const ranked = francAll(text, { minLength: MIN_CHARS });
  const best = ranked[0];
  if (!best || best[0] === 'und') return null;
  const english = ranked.find(([code]) => code === 'eng');
  if (best[0] !== 'eng' && english && english[1] >= best[1] - ENGLISH_MARGIN) return 'en';
  return ISO_639_1[best[0]] ?? null;
}

/**
 * Languages for a note's chapters: each long chapter speaks for itself, short
 * ones take the language of the whole note. Unknown stays unknown (treated as
 * readable, so nothing is ever translated by mistake).
 */
export function detectChapterLanguages(chapterTexts: string[]): (string | null)[] {
  const noteLanguage = detectLanguage(chapterTexts.join('\n\n'));
  return chapterTexts.map((text) => detectLanguage(text) ?? noteLanguage);
}
