import workerSource from 'virtual:tts-worker';
import type { TextSegment, WorkerRequest, WorkerResponse } from '../shared/protocol';

/**
 * The plugin's side of the TTS worker: starts it on first use, loads the
 * built-in voice into it, and turns its message stream into callbacks.
 */

export interface Mp3Sink {
  /** A further piece of the MP3 stream; `seconds` is the audio length so far,
   *  `segment` the index of the first text segment this piece speaks. */
  onPiece(data: ArrayBuffer, seconds: number, segment: number): void;
}

export interface CancelToken {
  cancelled: boolean;
  /** Called once when the job is cancelled, to stop work in progress. */
  onCancel?: () => void;
}

export class JobCancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}

export type Device = 'webgpu' | 'wasm';

interface Pending {
  sink: Mp3Sink;
  resolve: (seconds: number) => void;
  reject: (error: Error) => void;
}

const MP3_KBPS = 64;
/** The built-in voice holds a lot of memory; let it go when nobody listens. */
const IDLE_UNLOAD_MS = 15 * 60 * 1000;

export class TtsWorkerClient {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private loaded: { device: Device; promise: Promise<void> } | null = null;
  private loadWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private idleTimer: number | null = null;
  private translations = new Map<number, { resolve: (paragraphs: string[]) => void; reject: (error: Error) => void }>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }));
    const worker = new Worker(this.workerUrl);
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
    worker.onerror = (ev) => {
      const error = new Error(ev.message || 'The speech worker stopped unexpectedly.');
      this.failEverything(error);
      this.dispose();
    };
    this.worker = worker;
    return worker;
  }

  private post(message: WorkerRequest, transfer: Transferable[] = []): void {
    this.ensureWorker().postMessage(message, transfer);
  }

  private onMessage(msg: WorkerResponse): void {
    switch (msg.t) {
      case 'loaded':
        this.loadWaiter?.resolve();
        this.loadWaiter = null;
        return;
      case 'load-error':
        this.loadWaiter?.reject(new Error(msg.message));
        this.loadWaiter = null;
        return;
      case 'mp3':
        this.pending.get(msg.id)?.sink.onPiece(msg.data, msg.seconds, msg.segment);
        return;
      case 'done': {
        const job = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        job?.resolve(msg.seconds);
        return;
      }
      case 'translated': {
        const job = this.translations.get(msg.id);
        this.translations.delete(msg.id);
        job?.resolve(msg.paragraphs);
        return;
      }
      case 'error': {
        const job = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        job?.reject(new Error(msg.message));
        const translation = this.translations.get(msg.id);
        this.translations.delete(msg.id);
        translation?.reject(new Error(msg.message));
        return;
      }
    }
  }

  private failEverything(error: Error): void {
    this.loadWaiter?.reject(error);
    this.loadWaiter = null;
    for (const job of this.pending.values()) job.reject(error);
    this.pending.clear();
    for (const job of this.translations.values()) job.reject(error);
    this.translations.clear();
  }

  private touch(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0 && this.translations.size === 0) this.dispose();
      else this.touch();
    }, IDLE_UNLOAD_MS);
  }

  /** Translate paragraphs into English with a downloaded model (`repo`). */
  translate(repo: string, paragraphs: string[], threads: number, cancel: CancelToken): Promise<string[]> {
    const id = this.nextId++;
    this.touch();
    return new Promise<string[]>((resolve, reject) => {
      this.translations.set(id, { resolve, reject });
      cancel.onCancel = () => {
        if (!this.translations.has(id)) return;
        this.translations.delete(id);
        this.worker?.postMessage({ t: 'cancel', id } satisfies WorkerRequest);
        reject(new JobCancelled());
      };
      if (cancel.cancelled) {
        cancel.onCancel();
        return;
      }
      this.post({ t: 'translate', id, repo, paragraphs, threads });
    });
  }

  /** Free the translation model (after its files were removed). */
  unloadTranslator(): void {
    this.worker?.postMessage({ t: 'translate-unload' } satisfies WorkerRequest);
  }

  /** Load the built-in voice (from the local database) onto `device`. */
  loadBuiltin(device: Device, threads: number): Promise<void> {
    if (this.loaded && this.loaded.device === device) return this.loaded.promise;
    if (this.loaded) {
      // Switching device: start from a clean worker.
      this.dispose();
    }
    const promise = new Promise<void>((resolve, reject) => {
      this.loadWaiter = { resolve, reject };
      this.post({ t: 'load', device, threads });
    });
    this.loaded = { device, promise };
    promise.catch(() => {
      if (this.loaded?.promise === promise) this.loaded = null;
    });
    return promise;
  }

  private track(id: number, sink: Mp3Sink, cancel: CancelToken): Promise<number> {
    this.touch();
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { sink, resolve, reject });
      cancel.onCancel = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.worker?.postMessage({ t: 'cancel', id } satisfies WorkerRequest);
        reject(new JobCancelled());
      };
      if (cancel.cancelled) cancel.onCancel();
    });
  }

  /** Speak segments with the built-in voice. Resolves with the length in seconds. */
  synth(segments: TextSegment[], voice: string, sink: Mp3Sink, cancel: CancelToken): Promise<number> {
    const id = this.nextId++;
    const done = this.track(id, sink, cancel);
    if (!cancel.cancelled) this.post({ t: 'synth', id, segments, voice, kbps: MP3_KBPS });
    return done;
  }

  /** Encode audio from another engine into one MP3 stream. */
  openEncoder(sampleRate: number, sink: Mp3Sink, cancel: CancelToken): Encoder {
    const id = this.nextId++;
    const done = this.track(id, sink, cancel);
    // The caller awaits `finish()`; until then a rejection has no listener.
    done.catch(() => undefined);
    if (!cancel.cancelled) this.post({ t: 'encode-begin', id, sampleRate, kbps: MP3_KBPS });
    return {
      write: (pcm, pauseMs, leadMs = 0, segment = 0) => {
        if (!cancel.cancelled) this.post({ t: 'encode-pcm', id, pcm, pauseMs, leadMs, segment }, [pcm.buffer]);
      },
      finish: () => {
        if (!cancel.cancelled) this.post({ t: 'encode-end', id });
        return done;
      },
      abort: () => {
        // The engine gave up mid-way: free the encoder on both sides.
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        this.worker?.postMessage({ t: 'cancel', id } satisfies WorkerRequest);
      },
    };
  }

  dispose(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.failEverything(new JobCancelled());
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
    this.loaded = null;
  }
}

export interface Encoder {
  /** `leadMs` of silence, the audio, then `pauseMs` of silence; `segment` names the first text segment spoken. */
  write(pcm: Int16Array, pauseMs: number, leadMs?: number, segment?: number): void;
  /** Resolves with the total length in seconds once everything is encoded. */
  finish(): Promise<number>;
  /** Drop a half-written stream (after an error); `finish()` then never resolves. */
  abort(): void;
}
