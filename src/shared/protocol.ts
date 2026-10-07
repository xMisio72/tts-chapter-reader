/**
 * Messages between the plugin and the TTS worker.
 *
 * The worker does the two CPU-heavy jobs so Obsidian never freezes:
 *  - running the built-in voice (Kokoro) on text
 *  - encoding audio to MP3 (for every engine)
 * Each job produces one continuous MP3 stream, sent back in pieces as it grows.
 */

/** One piece of text to speak, plus the silence to leave after it. */
export interface TextSegment {
  text: string;
  pauseMs: number;
  /** Silence to leave before it (the optional pause at a chapter's start). */
  leadMs?: number;
  /** Which paragraph of the chapter text it comes from (0-based). */
  paragraph?: number;
}

export type WorkerRequest =
  /** Load the built-in voice from the local database (no network). */
  | { t: 'load'; device: 'webgpu' | 'wasm'; threads: number }
  /** Free the built-in voice again. */
  | { t: 'unload' }
  /** Speak segments with the built-in voice. */
  | { t: 'synth'; id: number; segments: TextSegment[]; voice: string; kbps: number }
  /** Encode audio that another engine produced. */
  | { t: 'encode-begin'; id: number; sampleRate: number; kbps: number }
  | { t: 'encode-pcm'; id: number; pcm: Int16Array; pauseMs: number; leadMs: number; segment: number }
  | { t: 'encode-end'; id: number }
  | { t: 'cancel'; id: number }
  /** Translate paragraphs into English with a downloaded translation model. */
  | { t: 'translate'; id: number; repo: string; paragraphs: string[]; threads: number }
  /** Free the translation model again. */
  | { t: 'translate-unload' };

export type WorkerResponse =
  | { t: 'loaded' }
  | { t: 'load-error'; message: string }
  /** A piece of the job's MP3 stream. `seconds` is the audio length so far;
   *  `segment` the index of the first text segment the piece speaks. */
  | { t: 'mp3'; id: number; data: ArrayBuffer; seconds: number; segment: number }
  | { t: 'done'; id: number; seconds: number }
  | { t: 'translated'; id: number; paragraphs: string[] }
  | { t: 'error'; id: number; message: string };

/** Where the worker's sandboxed fetch finds the engine files in the database. */
export const KOKORO_REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const KOKORO_URL_PREFIX = `https://huggingface.co/${KOKORO_REPO}/resolve/main/`;
export const KOKORO_KEY_PREFIX = 'kokoro/';
export const ORT_WASM_KEY = 'runtime/ort.wasm';
/** Translation models: `https://huggingface.co/<repo>/resolve/main/<file>` → `models/<repo>/<file>` */
export const HF_URL_PREFIX = 'https://huggingface.co/';
export const MODEL_KEY_PREFIX = 'models/';
export function modelFileKey(repo: string, path: string): string {
  return `${MODEL_KEY_PREFIX}${repo}/${path}`;
}
