import { BUILTIN_VOICES } from './builtin-voice';
import type { EngineId, PluginSettings } from './settings-data';

/**
 * The speakers a voice offers, in one shape, so the settings and the speaker
 * picker can list, star and sample them the same way.
 */

export interface VoiceOption {
  id: string;
  /** Shown in lists. */
  label: string;
}

export const GEMINI_VOICES = [
  'Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus',
  'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia',
  'Sadaltager', 'Sulafat',
];

/** One sentence that is the same for every speaker, so they can be compared. */
export const SAMPLE_TEXT = 'This is how your notes will sound. Every heading becomes a chapter you can jump to.';

export function voiceOptions(engine: EngineId): VoiceOption[] {
  switch (engine) {
    case 'builtin':
      return BUILTIN_VOICES.map((v) => ({ id: v.id, label: `${v.name} (${v.accent}, ${v.gender})` }));
    case 'gemini':
      return GEMINI_VOICES.map((v) => ({ id: v, label: v }));
    case 'system': {
      const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
      // A voice the operating system fetches from a service is marked, since the text leaves the computer then.
      return [
        { id: '', label: 'Default' },
        ...voices.map((v) => ({ id: v.voiceURI, label: `${v.name} (${v.lang})${v.localService ? '' : ', online'}` })),
      ];
    }
    default:
      return [];
  }
}

/** The chosen speaker of a voice, and how to change it. */
export function currentSpeaker(settings: PluginSettings, engine: EngineId): string {
  if (engine === 'builtin') return settings.builtinVoice;
  if (engine === 'gemini') return settings.gemini.voice;
  if (engine === 'system') return settings.systemVoice;
  if (engine === 'openai') return settings.openai.voice;
  return settings.kokoroServerVoice;
}

export function setSpeaker(settings: PluginSettings, engine: EngineId, id: string): void {
  if (engine === 'builtin') settings.builtinVoice = id;
  else if (engine === 'gemini') settings.gemini.voice = id;
  else if (engine === 'system') settings.systemVoice = id;
  else if (engine === 'openai') settings.openai.voice = id;
  else settings.kokoroServerVoice = id;
}

export function isFavorite(settings: PluginSettings, engine: EngineId, id: string): boolean {
  return settings.favoriteVoices[engine].includes(id);
}

export function toggleFavorite(settings: PluginSettings, engine: EngineId, id: string): void {
  const list = settings.favoriteVoices[engine];
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
  else list.push(id);
}

/** Starred speakers first (in the order they were starred), then the rest. */
export function favoritesFirst(options: VoiceOption[], favorites: string[]): VoiceOption[] {
  const starred = favorites.map((id) => options.find((o) => o.id === id)).filter((o): o is VoiceOption => !!o);
  return [...starred, ...options.filter((o) => !favorites.includes(o.id))];
}
