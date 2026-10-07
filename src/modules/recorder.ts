import type { SegmentMark } from '../shared/idb';
import type { TextSegment } from '../shared/protocol';
import type { AudioCache } from './audio-cache';
import type { Engine } from './engines';
import { CancelToken, JobCancelled } from './tts-worker-client';

/**
 * Records chapters one at a time and saves each finished recording.
 *
 * Three urgencies:
 *  - 'now':   the listener is waiting for this chapter. It jumps the queue and
 *             interrupts whatever else is being recorded.
 *  - 'soon':  asked for by hand (re-record). Next in line.
 *  - 'ahead': recorded in the background so later chapters start instantly.
 *
 * An interrupted recording is not lost work to worry about: it goes back in
 * the queue and starts over when its turn comes.
 */

export type Urgency = 'now' | 'soon' | 'ahead';

export interface RecordingRequest {
  hash: string;
  label: string;
  segments: TextSegment[];
  engine: Engine;
  /** Who asked, so a closing note can withdraw its background requests. */
  owner: object;
}

export interface Recording {
  hash: string;
  /** Receive every piece of the MP3 stream, those already made included. */
  subscribe(listener: (piece: ArrayBuffer, seconds: number, segment: number) => void): () => void;
  /** The finished recording. */
  done: Promise<{ audio: ArrayBuffer; seconds: number; marks: SegmentMark[] }>;
}

interface Job extends RecordingRequest {
  urgency: Urgency;
  /** 'saving' = recorded, being written to the cache; it cannot be interrupted any more. */
  state: 'queued' | 'running' | 'saving';
  pieces: ArrayBuffer[];
  marks: SegmentMark[];
  seconds: number;
  listeners: Set<(piece: ArrayBuffer, seconds: number, segment: number) => void>;
  cancel: CancelToken;
  /** Bumped on every restart so subscribers can drop what they had. */
  attempt: number;
  resolve: (result: { audio: ArrayBuffer; seconds: number; marks: SegmentMark[] }) => void;
  reject: (error: Error) => void;
  handle: Recording;
}

const RANK: Record<Urgency, number> = { now: 0, soon: 1, ahead: 2 };

function concat(pieces: ArrayBuffer[]): ArrayBuffer {
  const total = pieces.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    out.set(new Uint8Array(piece), offset);
    offset += piece.byteLength;
  }
  return out.buffer;
}

export interface RecorderEvents {
  /** A recording started, finished, failed or was withdrawn. */
  onChange(hash: string, event: 'started' | 'saved' | 'failed' | 'dropped', info?: { seconds?: number; marks?: SegmentMark[]; error?: Error }): void;
}

export class Recorder {
  private jobs = new Map<string, Job>();
  private running: Job | null = null;
  private listeners = new Set<RecorderEvents>();

  constructor(private cache: AudioCache) {}

  addListener(listener: RecorderEvents): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(hash: string, event: Parameters<RecorderEvents['onChange']>[1], info?: Parameters<RecorderEvents['onChange']>[2]): void {
    for (const listener of this.listeners) listener.onChange(hash, event, info);
  }

  /** 'running', 'queued', or null when this text is not being recorded. */
  stateOf(hash: string): 'running' | 'queued' | null {
    const state = this.jobs.get(hash)?.state;
    return state === 'saving' ? 'running' : (state ?? null);
  }

  request(request: RecordingRequest, urgency: Urgency): Recording {
    const existing = this.jobs.get(request.hash);
    if (existing) {
      if (RANK[urgency] < RANK[existing.urgency]) existing.urgency = urgency;
      if (urgency === 'now') existing.owner = request.owner;
      this.schedule();
      return existing.handle;
    }

    let resolve!: Job['resolve'];
    let reject!: Job['reject'];
    const done = new Promise<{ audio: ArrayBuffer; seconds: number; marks: SegmentMark[] }>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // A background recording has nobody awaiting it; failures are reported
    // through the events instead.
    done.catch(() => undefined);

    const job: Job = {
      ...request,
      urgency,
      state: 'queued',
      pieces: [],
      marks: [],
      seconds: 0,
      listeners: new Set(),
      cancel: { cancelled: false },
      attempt: 0,
      resolve,
      reject,
      handle: {
        hash: request.hash,
        done,
        subscribe: (listener) => {
          job.pieces.forEach((piece, i) => listener(piece, job.marks[i]?.end ?? job.seconds, job.marks[i]?.segment ?? 0));
          job.listeners.add(listener);
          return () => job.listeners.delete(listener);
        },
      },
    };
    this.jobs.set(request.hash, job);
    this.schedule();
    return job.handle;
  }

  /** Withdraw the background requests of a note that was closed. */
  dropOwner(owner: object): void {
    for (const job of [...this.jobs.values()]) {
      if (job.owner !== owner) continue;
      this.drop(job);
    }
    this.schedule();
  }

  /** Stop recording this text, whoever asked for it. */
  dropHash(hash: string): void {
    const job = this.jobs.get(hash);
    if (job) this.drop(job);
    this.schedule();
  }

  dropAll(): void {
    for (const job of [...this.jobs.values()]) this.drop(job);
  }

  private drop(job: Job): void {
    this.jobs.delete(job.hash);
    this.interrupt(job);
    if (this.running === job) this.running = null;
    job.reject(new JobCancelled());
    this.emit(job.hash, 'dropped');
  }

  private interrupt(job: Job): void {
    job.cancel.cancelled = true;
    job.cancel.onCancel?.();
  }

  private next(): Job | null {
    let best: Job | null = null;
    for (const job of this.jobs.values()) {
      if (job.state !== 'queued') continue;
      if (!best || RANK[job.urgency] < RANK[best.urgency]) best = job;
    }
    return best;
  }

  private schedule(): void {
    const next = this.next();
    if (!next) return;

    if (this.running) {
      // A finished recording that is being saved is left alone; schedule() runs again right after.
      if (this.running.state === 'saving') return;
      // Only a chapter the listener is waiting for may interrupt, and only
      // something less urgent than itself.
      const preempt = next.urgency === 'now' && this.running.urgency !== 'now';
      const supersede = next.urgency === 'now' && this.running.urgency === 'now' && next !== this.running;
      if (!preempt && !supersede) return;
      const interrupted = this.running;
      this.running = null;
      this.interrupt(interrupted);
      // Back in the queue as background work; it starts over later.
      interrupted.state = 'queued';
      interrupted.urgency = 'ahead';
      interrupted.pieces = [];
      interrupted.marks = [];
      interrupted.seconds = 0;
      interrupted.cancel = { cancelled: false };
      interrupted.attempt++;
    }

    void this.run(next);
  }

  private async run(job: Job): Promise<void> {
    this.running = job;
    job.state = 'running';
    const attempt = job.attempt;
    const cancel = job.cancel;
    this.emit(job.hash, 'started');

    try {
      const seconds = await job.engine.record(
        job.segments,
        {
          onPiece: (piece, soFar, segment) => {
            if (job.attempt !== attempt || cancel.cancelled) return;
            job.pieces.push(piece);
            job.marks.push({ end: soFar, segment });
            job.seconds = soFar;
            for (const listener of job.listeners) listener(piece, soFar, segment);
          },
        },
        cancel,
      );
      if (job.attempt !== attempt || cancel.cancelled) return;

      const audio = concat(job.pieces);
      const marks = job.marks;
      // The job stays registered while it is saved, so nobody records the same text again meanwhile.
      job.state = 'saving';
      let saved = true;
      try {
        await this.cache.put(job.hash, audio, seconds, job.label, marks);
      } catch (e) {
        // Could not save (disk full, for example): the listener still gets
        // the audio, it just is not kept, and the chapter stays "not recorded".
        saved = false;
        console.error('TTS Chapter Reader: could not save a recording.', e);
      }
      if (this.jobs.get(job.hash) === job) this.jobs.delete(job.hash);
      if (this.running === job) this.running = null;
      job.resolve({ audio, seconds, marks });
      if (saved) this.emit(job.hash, 'saved', { seconds, marks });
      else this.emit(job.hash, 'dropped');
    } catch (e) {
      // Interrupted or withdrawn by this recorder: not a failure.
      if (job.attempt !== attempt || cancel.cancelled) return;
      const error = e instanceof Error ? e : new Error(String(e));
      if (this.jobs.get(job.hash) === job) this.jobs.delete(job.hash);
      if (this.running === job) this.running = null;
      job.reject(error);
      this.emit(job.hash, 'failed', { error });
    } finally {
      this.schedule();
    }
  }
}
