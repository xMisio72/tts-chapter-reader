/**
 * TTS worker: runs the built-in voice and encodes MP3, off the main thread.
 *
 * It never touches the network. The plugin downloads the engine files (with
 * the user's consent) into IndexedDB; the worker's fetch is replaced by one
 * that only reads from there.
 */

import { KokoroTTS } from 'kokoro-js';
import { env, pipeline } from '@huggingface/transformers';
import type { TranslationPipeline } from '@huggingface/transformers';
import { Mp3Encoder } from '@breezystack/lamejs';
import ortLoaderSource from 'virtual:ort-loader';
import { idbGet, STORE_FILES } from '../shared/idb';
import {
  HF_URL_PREFIX,
  KOKORO_KEY_PREFIX,
  KOKORO_REPO,
  KOKORO_URL_PREFIX,
  MODEL_KEY_PREFIX,
  ORT_WASM_KEY,
  TextSegment,
  WorkerRequest,
  WorkerResponse,
} from '../shared/protocol';

interface WorkerScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  fetch: typeof fetch;
  setTimeout(handler: () => void, ms: number): number;
}
const scope = self as unknown as WorkerScope;

// ---------------------------------------------------------------- sandboxed fetch

const nativeFetch: typeof fetch = scope.fetch.bind(self);

scope.fetch = async (input: RequestInfo | URL): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // In-memory files this worker created itself (the runtime binary).
  if (url.startsWith('blob:')) return nativeFetch(input);
  let key: string | null = null;
  if (url.startsWith(KOKORO_URL_PREFIX)) {
    key = KOKORO_KEY_PREFIX + url.slice(KOKORO_URL_PREFIX.length);
  } else if (url.startsWith(HF_URL_PREFIX)) {
    // https://huggingface.co/<owner>/<repo>/resolve/main/<file>
    const rest = url.slice(HF_URL_PREFIX.length);
    const m = /^([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(rest);
    if (m) key = `${MODEL_KEY_PREFIX}${m[1]}/${m[2]}`;
  }
  if (key) {
    const data = await idbGet<ArrayBuffer>(STORE_FILES, key);
    if (data) {
      return new Response(data, {
        status: 200,
        headers: { 'content-length': String(data.byteLength) },
      });
    }
  }
  return new Response(null, { status: 404, statusText: 'Not available offline' });
};

// ---------------------------------------------------------------- runtime

let runtimeReady = false;

/** Point the model library at the runtime binary from the database, once. */
async function prepareRuntime(threads: number): Promise<void> {
  const onnxWasm = env.backends.onnx.wasm;
  if (!onnxWasm) throw new Error('The speech runtime is not available.');
  if (!runtimeReady) {
    const wasm = await idbGet<ArrayBuffer>(STORE_FILES, ORT_WASM_KEY);
    if (!wasm) throw new Error('The built-in voice is not downloaded yet.');

    env.allowLocalModels = false;
    env.useBrowserCache = false;
    // The library points the runtime at a CDN by default. Give it the loader
    // bundled into this worker and the binary from the database instead.
    onnxWasm.wasmPaths = {
      mjs: URL.createObjectURL(new Blob([ortLoaderSource], { type: 'text/javascript' })),
      wasm: URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' })),
    };
    onnxWasm.proxy = false;
    runtimeReady = true;
  }
  onnxWasm.numThreads = threads;
}

// ---------------------------------------------------------------- built-in voice

let tts: KokoroTTS | null = null;
let loading: Promise<void> | null = null;

async function loadVoiceEngine(device: 'webgpu' | 'wasm', threads: number): Promise<void> {
  if (tts) return;
  if (!loading) {
    loading = (async () => {
      await prepareRuntime(threads);
      // Full precision: the only variant that is both correct on a graphics
      // card and faster than real time on a processor.
      tts = await KokoroTTS.from_pretrained(KOKORO_REPO, { dtype: 'fp32', device });
    })();
    loading.catch(() => {
      loading = null;
    });
  }
  await loading;
}

// ---------------------------------------------------------------- MP3 stream

const BLOCK = 1152 * 8;

class Mp3Stream {
  private encoder: Mp3Encoder;
  private samples = 0;
  private pending: Uint8Array[] = [];

  constructor(private id: number, private sampleRate: number, kbps: number) {
    this.encoder = new Mp3Encoder(1, sampleRate, kbps);
  }

  get seconds(): number {
    return this.samples / this.sampleRate;
  }

  write(pcm: Int16Array): void {
    for (let i = 0; i < pcm.length; i += BLOCK) {
      const out = this.encoder.encodeBuffer(pcm.subarray(i, i + BLOCK));
      if (out.length > 0) this.pending.push(new Uint8Array(out));
    }
    this.samples += pcm.length;
  }

  silence(ms: number): void {
    if (ms > 0) this.write(new Int16Array(Math.round((this.sampleRate * ms) / 1000)));
  }

  private lastSegment = 0;

  /** Send what has been encoded so far, as the piece for text segment `segment`. */
  emit(segment = this.lastSegment): void {
    this.lastSegment = segment;
    const total = this.pending.reduce((n, p) => n + p.length, 0);
    if (total === 0) return;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const p of this.pending) {
      merged.set(p, offset);
      offset += p.length;
    }
    this.pending = [];
    scope.postMessage({ t: 'mp3', id: this.id, data: merged.buffer, seconds: this.seconds, segment }, [merged.buffer]);
  }

  finish(): void {
    const tail = this.encoder.flush();
    if (tail.length > 0) this.pending.push(new Uint8Array(tail));
    this.emit();
    scope.postMessage({ t: 'done', id: this.id, seconds: this.seconds });
  }
}

function floatToPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

// ---------------------------------------------------------------- jobs

const cancelled = new Set<number>();
let synthQueue: Promise<void> = Promise.resolve();
const encodeJobs = new Map<number, Mp3Stream>();

/** Let queued messages (a cancel, mostly) through between two heavy steps. */
function breathe(): Promise<void> {
  return new Promise((resolve) => scope.setTimeout(resolve, 0));
}

async function synth(id: number, segments: TextSegment[], voice: string, kbps: number): Promise<void> {
  if (!tts) throw new Error('The built-in voice is not loaded.');

  let stream: Mp3Stream | null = null;
  for (const [index, segment] of segments.entries()) {
    await breathe();
    if (cancelled.has(id)) return;
    const audio = await tts.generate(segment.text, { voice: voice as never });
    if (cancelled.has(id)) return;
    if (!stream) stream = new Mp3Stream(id, audio.sampling_rate, kbps);
    stream.silence(segment.leadMs ?? 0);
    stream.write(floatToPcm(audio.audio));
    stream.silence(segment.pauseMs);
    stream.emit(index);
  }
  if (!stream) throw new Error('There was nothing to read.');
  stream.finish();
}

function fail(id: number, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  scope.postMessage({ t: 'error', id, message });
}

// ---------------------------------------------------------------- translation

let translator: { repo: string; pipe: TranslationPipeline } | null = null;
let translateQueue: Promise<void> = Promise.resolve();

/** Free the loaded translation model's sessions (the library keeps them until told). */
async function disposeTranslator(): Promise<void> {
  const old = translator;
  translator = null;
  if (!old) return;
  try {
    await (old.pipe as unknown as { dispose?: () => Promise<void> }).dispose?.();
  } catch {
    /* already gone */
  }
}

async function loadTranslator(repo: string, threads: number): Promise<TranslationPipeline> {
  if (translator?.repo === repo) return translator.pipe;
  await disposeTranslator();
  await prepareRuntime(threads);
  // The translation models are small; the processor is fast enough and the
  // same on every machine.
  // The library's overloads are too many for the type checker; the call is plain.
  const load = pipeline as unknown as (task: string, model: string, options: object) => Promise<TranslationPipeline>;
  const pipe = await load('translation', repo, { dtype: 'q8', device: 'wasm' });
  translator = { repo, pipe };
  return pipe;
}

/**
 * Marian models translate a sentence at a time well; whole paragraphs badly.
 * Same sentence rule as the voice (an ordinal's dot is not an end): cutting
 * "Am 7." off its month once produced "==References==" from the model.
 */
function splitForTranslation(paragraph: string): string[] {
  const out: string[] = [];
  const re = /(?<!\b\d{1,2})[.!?…]+["')\]]*\s+|\n+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(paragraph)) !== null) {
    const piece = paragraph.slice(start, m.index + m[0].length).trim();
    if (piece) out.push(piece);
    start = m.index + m[0].length;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/** The models learned from Wikipedia and sometimes emit its markup; nobody wants to hear "equals equals". */
function cleanTranslation(text: string): string {
  return text
    .replace(/={2,}\s*[^=\n]*?\s*={2,}/g, ' ')
    .replace(/\[\[|\]\]|'{2,}/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

async function translate(id: number, repo: string, paragraphs: string[], threads: number): Promise<void> {
  const pipe = await loadTranslator(repo, threads);
  const result: string[] = [];
  for (const paragraph of paragraphs) {
    const sentences = splitForTranslation(paragraph);
    const translated: string[] = [];
    for (const sentence of sentences) {
      await breathe();
      if (cancelled.has(id)) return;
      const run = pipe as unknown as (text: string, options: object) => Promise<unknown>;
      const out = await run(sentence, { max_length: 512 });
      const first = (Array.isArray(out) ? out[0] : out) as { translation_text?: string };
      translated.push(cleanTranslation(first?.translation_text ?? ''));
    }
    result.push(translated.filter((s) => s.length > 0).join(' '));
  }
  scope.postMessage({ t: 'translated', id, paragraphs: result });
}

scope.onmessage = (ev) => {
  const msg = ev.data;
  switch (msg.t) {
    case 'load':
      loadVoiceEngine(msg.device, msg.threads).then(
        () => scope.postMessage({ t: 'loaded' }),
        (e: unknown) => scope.postMessage({ t: 'load-error', message: e instanceof Error ? e.message : String(e) }),
      );
      break;
    case 'unload':
      tts = null;
      loading = null;
      break;
    case 'synth':
      // One at a time: an interrupted job finishes its current sentence
      // before the next job touches the voice model.
      synthQueue = synthQueue
        .then(() => (cancelled.has(msg.id) ? undefined : synth(msg.id, msg.segments, msg.voice, msg.kbps)))
        .catch((e: unknown) => {
          if (!cancelled.has(msg.id)) fail(msg.id, e);
        })
        .finally(() => cancelled.delete(msg.id));
      break;
    case 'translate':
      translateQueue = translateQueue
        .then(() => (cancelled.has(msg.id) ? undefined : translate(msg.id, msg.repo, msg.paragraphs, msg.threads)))
        .catch((e: unknown) => {
          if (!cancelled.has(msg.id)) fail(msg.id, e);
        })
        .finally(() => cancelled.delete(msg.id));
      break;
    case 'translate-unload':
      // After any running translation, so a job never loses its model mid-way.
      translateQueue = translateQueue.then(() => disposeTranslator());
      break;
    case 'encode-begin':
      encodeJobs.set(msg.id, new Mp3Stream(msg.id, msg.sampleRate, msg.kbps));
      break;
    case 'encode-pcm': {
      const job = encodeJobs.get(msg.id);
      if (!job) break;
      try {
        job.silence(msg.leadMs);
        job.write(msg.pcm);
        job.silence(msg.pauseMs);
        job.emit(msg.segment);
      } catch (e) {
        encodeJobs.delete(msg.id);
        fail(msg.id, e);
      }
      break;
    }
    case 'encode-end': {
      const job = encodeJobs.get(msg.id);
      if (!job) break;
      encodeJobs.delete(msg.id);
      try {
        job.finish();
      } catch (e) {
        fail(msg.id, e);
      }
      break;
    }
    case 'cancel':
      if (encodeJobs.delete(msg.id)) break;
      cancelled.add(msg.id);
      // Forget the mark once BOTH queues have passed this job (it may have
      // finished before the cancel arrived, or sit in the translation queue).
      void Promise.allSettled([synthQueue, translateQueue]).then(() => cancelled.delete(msg.id));
      break;
  }
};
