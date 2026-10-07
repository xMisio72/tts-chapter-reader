import { App, requestUrl } from 'obsidian';
import { idbClear, idbGet, idbPut, STORE_TRANSLATIONS } from '../shared/idb';
import { contentHash } from './audio-cache';
import { EngineError } from './engines';
import type { PluginSettings } from './settings-data';
import { isModelInstalled, modelForLanguage } from './translation-store';
import { isRuntimeInstalled } from './builtin-voice';
import { JobCancelled, type CancelToken, type TtsWorkerClient } from './tts-worker-client';

/**
 * Turning a chapter written in another language into English before the
 * voice reads it.
 *
 * Three ways, picked in the settings: a model downloaded to this computer
 * (free, offline), Google Gemini, or an OpenAI-compatible chat API. Every
 * translation is kept, keyed by translator and source text, so a chapter is
 * translated once and recorded from the same English text ever after.
 */

export interface Translator {
  /** Part of the cache key; changes when the output would change. */
  id(): string;
  /** Costs money or leaves the computer: then only the next chapter is prepared ahead. */
  readonly metered: boolean;
  /** English for each paragraph, same length as the input. */
  translate(paragraphs: string[], lang: string, cancel: CancelToken): Promise<string[]>;
  /** False when something must happen first (a model download). */
  ready(lang: string): Promise<boolean>;
}

export async function translationKey(translatorId: string, text: string): Promise<string> {
  return contentHash(`translate:${translatorId}`, text);
}

export async function cachedTranslation(translatorId: string, text: string): Promise<string | undefined> {
  return idbGet<string>(STORE_TRANSLATIONS, await translationKey(translatorId, text));
}

export async function storeTranslation(translatorId: string, text: string, translated: string): Promise<void> {
  await idbPut(STORE_TRANSLATIONS, await translationKey(translatorId, text), translated);
}

/** Forget every saved translation (the settings' "Delete saved translations"). */
export function clearTranslations(): Promise<void> {
  return idbClear(STORE_TRANSLATIONS);
}

function paragraphsOf(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Translate a chapter's text, paragraph structure kept. */
export async function translateText(translator: Translator, text: string, lang: string, cancel: CancelToken): Promise<string> {
  const paragraphs = paragraphsOf(text);
  if (paragraphs.length === 0) return text;
  const out = await translator.translate(paragraphs, lang, cancel);
  return out.join('\n\n');
}

// ---------------------------------------------------------------- local model

export class LocalTranslator implements Translator {
  readonly metered = false;

  constructor(private worker: TtsWorkerClient, private threads: () => number) {}

  id(): string {
    // Bumped when the local pipeline changes so saved translations are redone.
    return 'local:2';
  }

  /** The language's model, and the shared runtime (which the voice download normally brings). */
  async ready(lang: string): Promise<boolean> {
    return (await isModelInstalled(modelForLanguage(lang))) && (await isRuntimeInstalled());
  }

  translate(paragraphs: string[], lang: string, cancel: CancelToken): Promise<string[]> {
    return this.worker.translate(modelForLanguage(lang).repo, paragraphs, this.threads(), cancel);
  }
}

// ---------------------------------------------------------------- cloud models

const PROMPT =
  'Translate the text below into English. Keep every paragraph break exactly as it is (one blank line between paragraphs), keep headings as they are, and output only the translation.';

function readSecret(app: App, name: string): string {
  if (!name) return '';
  try {
    return app.secretStorage.getSecret(name) ?? '';
  } catch {
    return '';
  }
}

/** Put the answer back into the paragraph shape it was sent in. */
function toParagraphs(answer: string, expected: number): string[] {
  const out = paragraphsOf(answer);
  if (out.length === expected) return out;
  // The model merged or split paragraphs; keep its text as one piece per slot.
  return [out.join('\n\n'), ...new Array<string>(Math.max(0, expected - 1)).fill('')];
}

function describeFailure(status: number, body: string): string {
  if (status === 401 || status === 403) return 'The translation service rejected the API key.';
  if (status === 429) return 'The translation service is rate-limiting requests. Try again in a moment.';
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 160);
  return `The translation service answered with an error (${status})${detail ? `: ${detail}` : '.'}`;
}

export class GeminiTranslator implements Translator {
  readonly metered = true;

  constructor(private app: App, private getSettings: () => PluginSettings) {}

  id(): string {
    return `gemini:${this.getSettings().translation.geminiModel}`;
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async translate(paragraphs: string[], _lang: string, cancel: CancelToken): Promise<string[]> {
    const s = this.getSettings();
    const key = readSecret(this.app, s.gemini.keyName);
    if (!key) throw new EngineError('Add your Gemini API key in the plugin settings to translate with Gemini.');
    if (cancel.cancelled) throw new JobCancelled();
    let res;
    try {
      res = await requestUrl({
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          model: s.translation.geminiModel,
          input: [{ type: 'user_input', content: [{ type: 'text', text: `${PROMPT}\n\n${paragraphs.join('\n\n')}` }] }],
        }),
        throw: false,
      });
    } catch {
      throw new EngineError('Could not reach Google Gemini. Check your internet connection.');
    }
    if (cancel.cancelled) throw new JobCancelled();
    if (res.status < 200 || res.status >= 300) throw new EngineError(describeFailure(res.status, res.text));
    interface Step { type?: string; content?: { type?: string; text?: string }[] }
    const steps = ((res.json as { steps?: Step[] }).steps ?? []).filter((step) => step.type === 'model_output');
    const text = steps
      .flatMap((step) => step.content ?? [])
      .filter((part) => part.type === 'text' && part.text)
      .map((part) => part.text)
      .join('\n');
    if (!text.trim()) throw new EngineError('Google Gemini returned no translation.');
    return toParagraphs(text, paragraphs.length);
  }
}

export class OpenAiTranslator implements Translator {
  constructor(private app: App, private getSettings: () => PluginSettings) {}

  private baseUrl(): string {
    return this.getSettings().translation.openai.baseUrl.trim().replace(/\/+$/, '');
  }

  /** A server on this computer or network is free; an internet API is billed. */
  get metered(): boolean {
    return !/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(this.baseUrl());
  }

  id(): string {
    return `openai:${this.baseUrl()}:${this.getSettings().translation.openai.model}`;
  }

  ready(): Promise<boolean> {
    return Promise.resolve(true);
  }

  async translate(paragraphs: string[], _lang: string, cancel: CancelToken): Promise<string[]> {
    const s = this.getSettings();
    const base = this.baseUrl();
    if (!base) throw new EngineError('Enter the translation server address in the plugin settings first.');
    const key = readSecret(this.app, s.translation.openai.keyName || s.openai.keyName);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    if (cancel.cancelled) throw new JobCancelled();
    let res;
    try {
      res = await requestUrl({
        url: `${base}/chat/completions`,
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: s.translation.openai.model,
          messages: [
            { role: 'system', content: PROMPT },
            { role: 'user', content: paragraphs.join('\n\n') },
          ],
        }),
        throw: false,
      });
    } catch {
      throw new EngineError(`Could not reach the translation server at ${base}. Is it running?`);
    }
    if (cancel.cancelled) throw new JobCancelled();
    if (res.status < 200 || res.status >= 300) throw new EngineError(describeFailure(res.status, res.text));
    const body = res.json as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content ?? '';
    if (!text.trim()) throw new EngineError('The translation server returned no translation.');
    return toParagraphs(text, paragraphs.length);
  }
}
