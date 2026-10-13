/** Everything the plugin saves in data.json, and its defaults. */

export type EngineId = 'builtin' | 'system' | 'openai' | 'gemini' | 'kokoroServer';

/** How far ahead of the listener chapters are recorded. */
export type RecordAhead = 'auto' | 'all' | 'next' | 'off';

export interface ChapterFlags {
  pinned?: boolean;
  hidden?: boolean;
}

export interface TextFilterSettings {
  filterFrontmatter: boolean;
  filterMarkdownLinks: boolean;
  filterCodeBlocks: boolean;
  filterInlineCode: boolean;
  filterHtmlTags: boolean;
  filterTables: boolean;
  filterImages: boolean;
  filterFootnotes: boolean;
  filterComments: boolean;
  filterMathExpressions: boolean;
  filterHighlights: boolean;
  filterCallouts: boolean;
  replaceComparisonSymbols: boolean;
}

export interface SymbolReplacementSettings {
  enableCustomReplacements: boolean;
  language: string;
  customReplacements: {
    greaterThan: string;
    lessThan: string;
    greaterThanOrEqual: string;
    lessThanOrEqual: string;
  };
}

export interface ReadingPosition {
  /** Chapter key (see chapter-split) and seconds into it. */
  key: string;
  time: number;
  /** When it was saved (ms since epoch), to drop the oldest. */
  when: number;
}

/** How notes in other languages are turned into English before reading. */
export type TranslationMode = 'off' | 'local' | 'gemini' | 'openai';

export interface TranslationSettings {
  mode: TranslationMode;
  /** Which voices get translated text. The natural voice only speaks English. */
  voices: Record<EngineId, boolean>;
  /** Languages the user chose to hear as they are; the plugin stops asking about them. */
  readAsIs: string[];
  /** Text model for the Gemini option (the voice's key is reused). */
  geminiModel: string;
  /** Chat model and server for the OpenAI-compatible option. */
  openai: {
    baseUrl: string;
    model: string;
    /** Empty: reuse the OpenAI voice's key. */
    keyName: string;
  };
}

export interface PluginSettings {
  // --- Voice
  engine: EngineId;
  /** The first-run question (natural voice or system voice) was answered. */
  voiceChosen: boolean;

  builtinVoice: string;
  /** Where the built-in voice runs. */
  builtinDevice: 'auto' | 'gpu' | 'cpu';

  systemVoice: string;
  /** Starred speakers per voice, shown first wherever a speaker is picked. */
  favoriteVoices: Record<EngineId, string[]>;

  openai: {
    baseUrl: string;
    model: string;
    voice: string;
    /** Name of the secret in Obsidian's keychain; the key itself is never in data.json. */
    keyName: string;
  };

  gemini: {
    model: string;
    voice: string;
    keyName: string;
  };

  // --- Other languages
  translation: TranslationSettings;

  // --- Chapters
  readHeadings: boolean;
  recordAhead: RecordAhead;
  /** Upper limit for saved recordings, in megabytes. */
  cacheLimitMb: number;
  /** Favorite/hidden marks: note path → chapter key → flags. */
  chapterFlags: Record<string, Record<string, ChapterFlags>>;

  // --- Player
  playbackSpeed: number;
  /** 0 to 1; the plugin's own volume on top of the system volume. */
  volume: number;
  /** The last volume above zero, so unmuting goes back to it instead of to full. */
  lastVolume: number;
  /** A short silence before a chapter's first words, so the start is easier to catch at speed. */
  pauseAtChapterStart: boolean;
  /** The player folded to one row. */
  playerMini: boolean;
  /** Play only favorite chapters. */
  favoritesOnly: boolean;
  /** Mark the paragraph being read in the note and keep it in view. */
  followReading: boolean;
  /** Where listening stopped, per note path, so it can go on from there. */
  positions: Record<string, ReadingPosition>;
  /** Notes (vault paths) to read one after another when the current one ends. */
  queue: string[];
  showNotices: boolean;
  showStatusBarButton: boolean;
  showMenuItems: boolean;
  disablePlaybackControlPopover: boolean;
  enableReplayOption: boolean;
  floatingPlayerPosition: { x: number; y: number } | null;

  // --- What gets read
  textFiltering: TextFilterSettings;
  symbolReplacement: SymbolReplacementSettings;

  // --- Own-infrastructure options. Hidden unless `personalOptions` is set to
  // true in data.json by hand; they talk to servers a normal install lacks.
  personalOptions: boolean;
  kokoroServerUrl: string;
  kokoroServerVoice: string;
  externalChapters: {
    enabled: boolean;
    vaultApiUrl: string;
    ktApiUrl: string;
  };
}

export const DEFAULT_SETTINGS: PluginSettings = {
  engine: 'builtin',
  voiceChosen: false,

  builtinVoice: 'af_heart',
  builtinDevice: 'auto',

  systemVoice: '',
  favoriteVoices: { builtin: [], system: [], openai: [], gemini: [], kokoroServer: [] },

  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-tts',
    voice: 'alloy',
    keyName: '',
  },

  gemini: {
    model: 'gemini-3.8-flash-tts',
    voice: 'Kore',
    keyName: '',
  },

  translation: {
    mode: 'off',
    voices: { builtin: true, system: false, openai: false, gemini: false, kokoroServer: false },
    readAsIs: [],
    geminiModel: 'gemini-3.8-flash',
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.4-mini', keyName: '' },
  },

  readHeadings: true,
  recordAhead: 'auto',
  cacheLimitMb: 1000,
  chapterFlags: {},

  playbackSpeed: 1.0,
  volume: 1,
  lastVolume: 1,
  pauseAtChapterStart: true,
  playerMini: false,
  favoritesOnly: false,
  followReading: true,
  positions: {},
  queue: [],
  showNotices: true,
  showStatusBarButton: true,
  showMenuItems: true,
  disablePlaybackControlPopover: false,
  enableReplayOption: true,
  floatingPlayerPosition: null,

  textFiltering: {
    filterFrontmatter: true,
    filterMarkdownLinks: false,
    filterCodeBlocks: true,
    filterInlineCode: true,
    filterHtmlTags: true,
    filterTables: true,
    filterImages: true,
    filterFootnotes: true,
    filterComments: true,
    filterMathExpressions: false,
    filterHighlights: true,
    filterCallouts: false,
    replaceComparisonSymbols: true,
  },

  symbolReplacement: {
    enableCustomReplacements: false,
    language: 'auto',
    customReplacements: {
      greaterThan: ' greater than ',
      lessThan: ' less than ',
      greaterThanOrEqual: ' greater than or equal to ',
      lessThanOrEqual: ' less than or equal to ',
    },
  },

  personalOptions: false,
  kokoroServerUrl: 'http://localhost:8765',
  kokoroServerVoice: 'af_heart',
  externalChapters: {
    enabled: false,
    vaultApiUrl: 'http://localhost:5124',
    ktApiUrl: '',
  },
};

/** Merge saved data over the defaults, one level deep for the nested groups. */
export function mergeSettings(saved: Partial<PluginSettings> | null | undefined): PluginSettings {
  const s = saved ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    openai: { ...DEFAULT_SETTINGS.openai, ...(s.openai ?? {}) },
    gemini: { ...DEFAULT_SETTINGS.gemini, ...(s.gemini ?? {}) },
    favoriteVoices: Object.fromEntries(
      (Object.keys(DEFAULT_SETTINGS.favoriteVoices) as EngineId[]).map((id) => [id, [...(s.favoriteVoices?.[id] ?? [])]]),
    ) as Record<EngineId, string[]>,
    translation: {
      ...DEFAULT_SETTINGS.translation,
      ...(s.translation ?? {}),
      voices: { ...DEFAULT_SETTINGS.translation.voices, ...(s.translation?.voices ?? {}) },
      readAsIs: [...(s.translation?.readAsIs ?? [])],
      openai: { ...DEFAULT_SETTINGS.translation.openai, ...(s.translation?.openai ?? {}) },
    },
    textFiltering: { ...DEFAULT_SETTINGS.textFiltering, ...(s.textFiltering ?? {}) },
    symbolReplacement: {
      ...DEFAULT_SETTINGS.symbolReplacement,
      ...(s.symbolReplacement ?? {}),
      customReplacements: {
        ...DEFAULT_SETTINGS.symbolReplacement.customReplacements,
        ...(s.symbolReplacement?.customReplacements ?? {}),
      },
    },
    externalChapters: { ...DEFAULT_SETTINGS.externalChapters, ...(s.externalChapters ?? {}) },
    chapterFlags: { ...(s.chapterFlags ?? {}) },
    positions: { ...(s.positions ?? {}) },
    queue: [...(s.queue ?? [])],
  };
}
