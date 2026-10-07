import { App, requestUrl } from 'obsidian';
import type { TextSegment } from '../shared/protocol';
import { ensureVoiceFile, isBuiltinVoice, isBuiltinVoiceInstalled, DEFAULT_BUILTIN_VOICE } from './builtin-voice';
import type { EngineId, PluginSettings } from './settings-data';
import { groupSegments } from './text-segments';
import { CancelToken, Device, JobCancelled, Mp3Sink, TtsWorkerClient } from './tts-worker-client';

/**
 * Voice engines that produce audio. Each one turns text segments into a single
 * MP3 stream. (The system voice is not here: the operating system speaks
 * directly and hands back no audio, so it cannot be recorded or cached.)
 */
export interface Engine {
  id: EngineId;
  /** Changes whenever the same text would sound different: part of the cache key. */
  fingerprint(): string;
  /** True when recording costs the user money or quota per character. */
  metered: boolean;
  record(segments: TextSegment[], sink: Mp3Sink, cancel: CancelToken): Promise<number>;
}

export class EngineError extends Error {}

function check(cancel: CancelToken): void {
  if (cancel.cancelled) throw new JobCancelled();
}

// ---------------------------------------------------------------- built-in voice

async function hasUsableGpu(): Promise<boolean> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter()) !== null;
  } catch {
    return false;
  }
}

/** CPU fallback: half the cores, at most eight, leaves the computer usable. */
export function cpuThreads(): number {
  if (typeof SharedArrayBuffer === 'undefined') return 1;
  return Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
}

export class BuiltinEngine implements Engine {
  readonly id = 'builtin' as const;
  readonly metered = false;
  /** Set after a graphics-card attempt failed, so it is not retried every time. */
  private gpuFailed = false;

  constructor(private worker: TtsWorkerClient, private getSettings: () => PluginSettings) {}

  private voice(): string {
    const voice = this.getSettings().builtinVoice;
    return isBuiltinVoice(voice) ? voice : DEFAULT_BUILTIN_VOICE;
  }

  fingerprint(): string {
    return `builtin:kokoro-v1.0:${this.voice()}`;
  }

  private async load(): Promise<void> {
    if (!(await isBuiltinVoiceInstalled())) {
      throw new EngineError('The natural voice is not downloaded yet. Open the plugin settings to download it.');
    }
    const preference = this.getSettings().builtinDevice;
    const wantGpu = preference === 'gpu' || (preference === 'auto' && !this.gpuFailed && (await hasUsableGpu()));
    let device: Device = wantGpu ? 'webgpu' : 'wasm';
    try {
      await this.worker.loadBuiltin(device, cpuThreads());
    } catch (e) {
      if (e instanceof JobCancelled || device === 'wasm' || preference === 'gpu') throw e;
      // The graphics card refused the model: carry on with the processor.
      this.gpuFailed = true;
      device = 'wasm';
      await this.worker.loadBuiltin(device, cpuThreads());
    }
  }

  async record(segments: TextSegment[], sink: Mp3Sink, cancel: CancelToken): Promise<number> {
    const voice = this.voice();
    await ensureVoiceFile(voice);
    check(cancel);
    await this.load();
    check(cancel);
    return this.worker.synth(segments, voice, sink, cancel);
  }
}

// ---------------------------------------------------------------- engines over HTTP

interface Pcm {
  samples: Int16Array;
  sampleRate: number;
}

/** Read a WAV file (16-bit PCM) into mono samples. */
export function decodeWav(data: ArrayBuffer): Pcm {
  const view = new DataView(data);
  const tag = (offset: number) =>
    String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
  if (data.byteLength < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') {
    throw new EngineError('The server did not return WAV audio.');
  }

  let format = 1;
  let channels = 1;
  let sampleRate = 24000;
  let bits = 16;
  let offset = 12;
  while (offset + 8 <= data.byteLength) {
    const id = tag(offset);
    // Streaming servers write 0 or 0xFFFFFFFF as the size: take what is there.
    let size = view.getUint32(offset + 4, true);
    const bodyStart = offset + 8;
    if (id === 'fmt ') {
      format = view.getUint16(bodyStart, true);
      channels = view.getUint16(bodyStart + 2, true);
      sampleRate = view.getUint32(bodyStart + 4, true);
      bits = view.getUint16(bodyStart + 14, true);
    } else if (id === 'data') {
      if (size === 0 || bodyStart + size > data.byteLength) size = data.byteLength - bodyStart;
      if (bits !== 16 || (format !== 1 && format !== 0xfffe)) {
        throw new EngineError(`Unsupported WAV format (${bits}-bit, type ${format}). The server must return 16-bit PCM.`);
      }
      const frames = Math.floor(size / (2 * channels));
      const samples = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += view.getInt16(bodyStart + (i * channels + c) * 2, true);
        samples[i] = Math.round(sum / channels);
      }
      return { samples, sampleRate };
    }
    offset = bodyStart + size + (size % 2);
  }
  throw new EngineError('The WAV audio from the server has no data.');
}

function isWav(data: ArrayBuffer): boolean {
  if (data.byteLength < 12) return false;
  const bytes = new Uint8Array(data, 0, 12);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  return tag(0) === 'RIFF' && tag(8) === 'WAVE';
}

/** Raw 16-bit little-endian mono samples without a header ("audio/L16"). */
function decodePcm16(data: ArrayBuffer, sampleRate: number): Pcm {
  const even = data.byteLength - (data.byteLength % 2);
  return { samples: new Int16Array(data.slice(0, even)), sampleRate };
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** Pull a readable reason out of an API error response. */
function describeFailure(status: number, body: string): string {
  let detail = '';
  try {
    const json = JSON.parse(body) as { error?: { message?: string } | string; detail?: unknown; message?: string };
    if (typeof json.error === 'string') detail = json.error;
    else if (json.error?.message) detail = json.error.message;
    else if (typeof json.detail === 'string') detail = json.detail;
    else if (json.message) detail = json.message;
  } catch {
    detail = body.slice(0, 200);
  }
  const hint =
    status === 401 || status === 403
      ? ' Check the API key.'
      : status === 404
        ? ' Check the server address and the model name.'
        : status === 429
          ? ' The rate limit or quota is used up.'
          : '';
  return `The voice server answered ${status}${detail ? `: ${detail}` : ''}.${hint}`;
}

abstract class HttpEngine implements Engine {
  abstract id: EngineId;
  abstract metered: boolean;
  abstract fingerprint(): string;
  /** Characters per request. */
  protected maxChars = 900;

  constructor(protected worker: TtsWorkerClient) {}

  protected abstract speak(text: string): Promise<Pcm>;

  async record(segments: TextSegment[], sink: Mp3Sink, cancel: CancelToken): Promise<number> {
    const groups = groupSegments(segments, this.maxChars);
    let encoder: ReturnType<TtsWorkerClient['openEncoder']> | null = null;
    let rate = 0;
    try {
      for (const group of groups) {
        check(cancel);
        const pcm = await this.speak(group.text);
        check(cancel);
        if (!encoder) {
          rate = pcm.sampleRate;
          encoder = this.worker.openEncoder(rate, sink, cancel);
        } else if (pcm.sampleRate !== rate) {
          throw new EngineError('The voice server changed its audio format in the middle of a recording.');
        }
        encoder.write(pcm.samples, group.pauseMs, group.leadMs ?? 0, group.segment);
      }
    } catch (e) {
      // A request failed after encoding began: do not leave the encoder waiting forever.
      encoder?.abort();
      throw e;
    }
    if (!encoder) throw new EngineError('There was nothing to read.');
    return encoder.finish();
  }
}

function readSecret(app: App, name: string): string {
  if (!name) return '';
  try {
    return app.secretStorage.getSecret(name) ?? '';
  } catch {
    return '';
  }
}

/** Any server that speaks OpenAI's /audio/speech API: OpenAI itself, Kokoro-FastAPI, and others. */
export class OpenAiCompatibleEngine extends HttpEngine {
  readonly id = 'openai' as const;

  constructor(worker: TtsWorkerClient, private app: App, private getSettings: () => PluginSettings) {
    super(worker);
  }

  private baseUrl(): string {
    return this.getSettings().openai.baseUrl.trim().replace(/\/+$/, '');
  }

  /** A server on this computer or network is free to use; an internet API is not. */
  get metered(): boolean {
    return !/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(this.baseUrl());
  }

  fingerprint(): string {
    const s = this.getSettings().openai;
    return `openai:${this.baseUrl()}:${s.model}:${s.voice}`;
  }

  protected async speak(text: string): Promise<Pcm> {
    const s = this.getSettings().openai;
    const base = this.baseUrl();
    if (!base) throw new EngineError('Enter the server address in the plugin settings first.');
    const key = readSecret(this.app, s.keyName);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;

    let res;
    try {
      res = await requestUrl({
        url: `${base}/audio/speech`,
        method: 'POST',
        headers,
        body: JSON.stringify({ model: s.model, input: text, voice: s.voice, response_format: 'wav' }),
        throw: false,
      });
    } catch {
      throw new EngineError(`Could not reach the voice server at ${base}. Is it running?`);
    }
    if (res.status < 200 || res.status >= 300) throw new EngineError(describeFailure(res.status, res.text));
    return decodeWav(res.arrayBuffer);
  }
}

/** Google Gemini text-to-speech with the user's own API key. */
export class GeminiEngine extends HttpEngine {
  readonly id = 'gemini' as const;
  readonly metered = true;

  constructor(worker: TtsWorkerClient, private app: App, private getSettings: () => PluginSettings) {
    super(worker);
  }

  fingerprint(): string {
    const s = this.getSettings().gemini;
    return `gemini:${s.model}:${s.voice}`;
  }

  protected async speak(text: string): Promise<Pcm> {
    const s = this.getSettings().gemini;
    const key = readSecret(this.app, s.keyName);
    if (!key) throw new EngineError('Add your Gemini API key in the plugin settings first.');

    let res;
    try {
      res = await requestUrl({
        url: 'https://generativelanguage.googleapis.com/v1beta/interactions',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          model: s.model,
          input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: s.voice }] },
        }),
        throw: false,
      });
    } catch {
      throw new EngineError('Could not reach Google Gemini. Check your internet connection.');
    }
    if (res.status < 200 || res.status >= 300) throw new EngineError(describeFailure(res.status, res.text));

    interface Part { type?: string; data?: string; mime_type?: string; sample_rate?: number }
    interface Step { type?: string; content?: Part[] }
    const steps = ((res.json as { steps?: Step[] }).steps ?? []).filter((step) => step.type === 'model_output');
    const audio = steps.flatMap((step) => step.content ?? []).filter((part) => part.type === 'audio' && part.data);
    const last = audio[audio.length - 1];
    if (!last?.data) throw new EngineError('Google Gemini returned no audio for this text.');
    const bytes = base64ToArrayBuffer(last.data);
    if (isWav(bytes)) return decodeWav(bytes);
    // Gemini answers requests from Obsidian's main process with headerless PCM
    // ("audio/L16;codec=pcm;rate=24000" and a sample_rate field), a browser fetch gets WAV.
    const rate = last.sample_rate ?? Number(/rate=(\d+)/.exec(last.mime_type ?? '')?.[1] ?? 0);
    return decodePcm16(bytes, rate || 24000);
  }
}

/** A Kokoro server with the document-reader protocol (POST /api/tts → WAV). Personal option. */
export class KokoroServerEngine extends HttpEngine {
  readonly id = 'kokoroServer' as const;
  readonly metered = false;

  constructor(worker: TtsWorkerClient, private getSettings: () => PluginSettings) {
    super(worker);
  }

  fingerprint(): string {
    const s = this.getSettings();
    return `kokoroServer:${s.kokoroServerUrl}:${s.kokoroServerVoice}`;
  }

  protected async speak(text: string): Promise<Pcm> {
    const s = this.getSettings();
    const base = s.kokoroServerUrl.trim().replace(/\/+$/, '');
    let res;
    try {
      res = await requestUrl({
        url: `${base}/api/tts`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Always 1.0: speed is applied at playback, where it keeps the pitch.
        body: JSON.stringify({ text, voice: s.kokoroServerVoice, speed: 1.0 }),
        throw: false,
      });
    } catch {
      throw new EngineError(`Could not reach the Kokoro server at ${base}. Is it running?`);
    }
    if (res.status < 200 || res.status >= 300) throw new EngineError(describeFailure(res.status, res.text));
    return decodeWav(res.arrayBuffer);
  }
}
