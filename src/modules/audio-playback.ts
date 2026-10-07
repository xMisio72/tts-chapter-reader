import { Notice } from 'obsidian';
import type { TextSegment } from '../shared/protocol';
import { EngineError } from './engines';
import type { Recording } from './recorder';
import type { PluginSettings } from './settings-data';
import { toSegments } from './text-segments';
import { JobCancelled } from './tts-worker-client';

/**
 * Plays a note chapter by chapter.
 *
 * A chapter arrives in one of three forms:
 *  - 'audio':  a finished recording (plays at once, full seeking)
 *  - 'stream': a recording still being made; playback starts after the first
 *              sentence and the rest is appended as it is produced
 *  - 'speech': text for the system voice, which speaks directly and gives no
 *              audio back (no seeking, nothing to save)
 *
 * Speed is always the audio element's playbackRate, which keeps the pitch
 * natural; recordings themselves are made at normal speed.
 */

export type ChapterSource =
  | { kind: 'audio'; data: ArrayBuffer }
  | { kind: 'stream'; recording: Recording; estSeconds: number }
  | { kind: 'speech'; text: string; hasTitle: boolean };

export interface ChapterProvider {
  readonly count: number;
  /** Hidden and empty chapters are skipped by auto-advance and prev/next. */
  isPlayable: (i: number) => boolean;
  open: (i: number) => Promise<ChapterSource>;
  onIndexChange?: (i: number) => void;
}

export interface PlaybackState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  isLoading: boolean;
  currentPart?: number;
  totalParts?: number;
  /** Short line shown while waiting, e.g. "Getting the voice ready…". */
  status?: string;
  /** False for the system voice: no timeline to show. */
  hasTimeline?: boolean;
}

/** An MP3 that is still growing, fed to the audio element piece by piece. */
class GrowingMp3 {
  readonly url: string;
  onFirstData: (() => void) | null = null;
  /** The browser refused the stream for good (not a full buffer). */
  onError: ((error: Error) => void) | null = null;
  /** Seconds already heard, so old audio can make room when the buffer is full. */
  played: () => number = () => 0;
  private mediaSource = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private queue: ArrayBuffer[] = [];
  private inputEnded = false;
  private gotData = false;
  private retryTimer: number | null = null;
  private destroyed = false;

  static supported(): boolean {
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mpeg');
  }

  constructor() {
    this.url = URL.createObjectURL(this.mediaSource);
    this.mediaSource.addEventListener('sourceopen', () => {
      if (this.buffer || this.destroyed) return;
      this.buffer = this.mediaSource.addSourceBuffer('audio/mpeg');
      this.buffer.addEventListener('updateend', () => {
        if (!this.gotData) {
          this.gotData = true;
          this.onFirstData?.();
        }
        this.pump();
      });
      this.buffer.addEventListener('error', () => this.onError?.(new Error('The browser could not decode the recording stream.')));
      this.pump();
    });
  }

  push(piece: ArrayBuffer): void {
    this.queue.push(piece);
    this.pump();
  }

  /** No more pieces will come. */
  end(): void {
    this.inputEnded = true;
    this.pump();
  }

  get complete(): boolean {
    return this.inputEnded && this.queue.length === 0;
  }

  get bufferedEnd(): number {
    const ranges = this.buffer?.buffered;
    return ranges && ranges.length > 0 ? ranges.end(ranges.length - 1) : 0;
  }

  private pump(): void {
    if (this.destroyed || !this.buffer || this.buffer.updating || this.mediaSource.readyState !== 'open') return;
    const next = this.queue[0];
    if (next) {
      try {
        this.buffer.appendBuffer(next);
        this.queue.shift();
      } catch (e) {
        if (!(e instanceof DOMException) || e.name !== 'QuotaExceededError') {
          // Anything but a full buffer is permanent: tell the player instead of retrying forever.
          this.onError?.(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        // The browser holds only so much audio ahead of the listener. Let go
        // of what was heard long ago and try again shortly.
        const heard = this.played();
        if (heard > 60 && !this.buffer.updating) {
          try {
            this.buffer.remove(0, heard - 30);
          } catch {
            /* nothing to remove */
          }
        }
        if (this.retryTimer === null) {
          this.retryTimer = window.setTimeout(() => {
            this.retryTimer = null;
            this.pump();
          }, 2000);
        }
      }
    } else if (this.inputEnded) {
      try {
        this.mediaSource.endOfStream();
      } catch {
        /* already closed */
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.queue = [];
    URL.revokeObjectURL(this.url);
  }
}

export class AudioPlaybackManager {
  private audio: HTMLAudioElement;
  private settings: PluginSettings;
  /** Bumped whenever playback changes course; stale async work checks it and stops. */
  private playbackId = 0;

  private blobUrl: string | null = null;
  private stream: GrowingMp3 | null = null;
  private streamEstimate = 0;
  private unsubscribeStream: (() => void) | null = null;

  private speaking = false;
  private speechPaused = false;

  private provider: ChapterProvider | null = null;
  private chapterIndex = 0;

  private loading = false;
  private status = '';
  private paused = false;

  private updateStatusBarCallback: (withControls: boolean) => void;
  private showPlayer: (data: PlaybackState) => void = () => undefined;
  private hidePlayer: () => void = () => undefined;
  private updatePlayer: (data: PlaybackState) => void = () => undefined;
  /** Called whenever reading stops for good (not between chapters). */
  onStopped: () => void = () => undefined;
  /** Playback moved: chapter index and seconds into it (several times a second while playing). */
  onProgress: (chapterIndex: number, time: number) => void = () => undefined;
  /** The last chapter ended. Returns true when something else starts now (the next note in the reading list). */
  onFinished: () => boolean = () => false;
  /** Speed for this session; a note can override the setting. */
  speed: number;
  /** System speaker for this session (a sample from the picker); null = the setting. */
  systemVoiceOverride: string | null = null;
  private pendingSeek: number | null = null;

  constructor(settings: PluginSettings, updateStatusBarCallback: (withControls: boolean) => void) {
    this.settings = settings;
    this.speed = settings.playbackSpeed;
    this.updateStatusBarCallback = updateStatusBarCallback;
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.volume = settings.volume;
    this.setupAudioEvents();
  }

  setFloatingPlayerCallbacks(
    showCb: (data: PlaybackState) => void,
    hideCb: () => void,
    updateCb: (data: PlaybackState) => void,
  ): void {
    this.showPlayer = (data) => {
      if (!this.settings.disablePlaybackControlPopover) showCb(data);
    };
    this.hidePlayer = () => {
      if (!this.settings.disablePlaybackControlPopover) hideCb();
    };
    this.updatePlayer = (data) => {
      if (!this.settings.disablePlaybackControlPopover) updateCb(data);
    };
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }

  // ------------------------------------------------------------ state

  private state(): PlaybackState {
    let duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
    if (this.stream && !this.stream.complete) {
      // Still recording: show the expected length until the real one is known.
      duration = Math.max(this.stream.bufferedEnd, this.streamEstimate);
    }
    return {
      currentTime: this.speaking ? 0 : this.audio.currentTime,
      duration: this.speaking ? 0 : duration,
      isPlaying: this.speaking ? !this.speechPaused : !this.audio.paused && !this.audio.ended && !this.loading,
      isLoading: this.loading,
      currentPart: this.provider ? this.chapterIndex + 1 : undefined,
      totalParts: this.provider ? this.provider.count : undefined,
      status: this.status || undefined,
      hasTimeline: !this.speaking,
    };
  }

  private push(): void {
    this.updatePlayer(this.state());
    if (this.provider && !this.speaking && !this.loading) this.onProgress(this.chapterIndex, this.audio.currentTime);
  }

  private notice(message: string, timeout?: number): void {
    if (this.settings.showNotices) new Notice(message, timeout);
  }

  /** A line under the controls while something happens before audio can play (e.g. translating). */
  showStatus(text: string): void {
    this.status = text;
    this.push();
  }

  private setupAudioEvents(): void {
    this.audio.onloadedmetadata = () => this.push();
    this.audio.ontimeupdate = () => this.push();
    this.audio.ondurationchange = () => this.push();

    this.audio.onplay = () => {
      this.paused = false;
      this.updateStatusBarCallback(true);
      this.push();
    };
    this.audio.onpause = () => {
      if (this.audio.ended) return;
      this.paused = true;
      this.updateStatusBarCallback(true);
      this.push();
    };

    // Playback caught up with a recording that is still being made.
    this.audio.onwaiting = () => {
      if (this.stream && !this.stream.complete) {
        this.status = 'Recording…';
        this.push();
      }
    };
    this.audio.onplaying = () => {
      if (this.status) {
        this.status = '';
        this.push();
      }
    };

    this.audio.onended = () => this.onChapterEnded();
    this.audio.onerror = () => {
      if (!this.provider || this.speaking) return;
      this.fail(new Error(this.audio.error?.message || 'The recording could not be played.'), this.playbackId);
    };
  }

  private onChapterEnded(spoken = false): void {
    const next = this.nextPlayableChapter(this.chapterIndex, 1);
    if (next >= 0) {
      void this.playChapterAt(next);
      return;
    }
    if (this.onFinished()) return;
    this.notice('Finished reading.');
    if (this.settings.enableReplayOption && !this.settings.disablePlaybackControlPopover && !spoken) {
      // Stay open at the end so the last chapter can be replayed.
      this.paused = true;
      this.updateStatusBarCallback(false);
      this.push();
    } else {
      this.stopPlayback();
    }
  }

  // ------------------------------------------------------------ chapters

  /** Start reading at `startIndex`, `startTime` seconds in when the chapter is recorded. Replaces whatever was playing. */
  startChapterPlayback(provider: ChapterProvider, startIndex: number, startTime?: number): void {
    this.teardownSource();
    this.provider = provider;
    this.chapterIndex = startIndex;
    this.loading = true;
    this.paused = false;
    this.showPlayer(this.state());
    void this.playChapterAt(startIndex, startTime);
  }

  /** The user picked this chapter: plays even a hidden one. */
  jumpToChapter(i: number, time?: number): void {
    if (!this.provider || i < 0 || i >= this.provider.count) return;
    void this.playChapterAt(i, time);
  }

  /** The chapter list changed under the listener; the audio keeps playing. */
  setChapterIndex(i: number): void {
    this.chapterIndex = i;
    this.push();
  }

  nextPart(): void {
    const next = this.nextPlayableChapter(this.chapterIndex, 1);
    if (next >= 0) void this.playChapterAt(next);
  }

  previousPart(): void {
    const prev = this.nextPlayableChapter(this.chapterIndex, -1);
    if (prev >= 0) void this.playChapterAt(prev);
  }

  isActive(): boolean {
    return this.provider !== null;
  }

  private nextPlayableChapter(from: number, dir: 1 | -1): number {
    if (!this.provider) return -1;
    for (let i = from + dir; i >= 0 && i < this.provider.count; i += dir) {
      if (this.provider.isPlayable(i)) return i;
    }
    return -1;
  }

  private async playChapterAt(i: number, startTime?: number): Promise<void> {
    const provider = this.provider;
    if (!provider) return;
    this.teardownSource();
    const id = this.playbackId;

    this.chapterIndex = i;
    this.loading = true;
    this.paused = false;
    this.status = '';
    provider.onIndexChange?.(i);
    this.updateStatusBarCallback(true);
    this.push();

    try {
      const source = await provider.open(i);
      if (id !== this.playbackId) return;
      // Only a finished recording can start in the middle; a stream begins where it begins.
      this.pendingSeek = source.kind === 'audio' && startTime && startTime > 0 ? startTime : null;
      if (source.kind === 'audio') await this.playRecording(source.data, id);
      else if (source.kind === 'stream') await this.playStream(source.recording, source.estSeconds, id);
      else this.playSpeech(source.text, source.hasTitle, id);
    } catch (e) {
      this.fail(e, id);
    }
  }

  private fail(error: unknown, id: number): void {
    if (id !== this.playbackId || error instanceof JobCancelled) return;
    // An engine's own message (wrong key, server down) is written for the
    // user and shown even with notices off: otherwise nothing would happen
    // and nobody would know why. Anything else is a bug worth a log entry.
    if (!(error instanceof EngineError)) console.error('TTS Chapter Reader: playback failed.', error);
    new Notice(error instanceof Error ? error.message : String(error), 10000);
    this.stopPlayback();
  }

  /** Begin playing whatever `audio.src` now points at. */
  private async startElement(id: number): Promise<void> {
    // Start at 1.0x: Chromium clips the first samples when a higher rate is
    // set before the decoder is ready. The chosen speed follows right after.
    this.audio.playbackRate = 1.0;
    await this.audio.play();
    if (id !== this.playbackId) return;
    if (this.pendingSeek !== null) {
      // The length is known once playback has begun; jump then.
      const seek = this.pendingSeek;
      this.pendingSeek = null;
      if (Number.isFinite(this.audio.duration) && seek < this.audio.duration - 1) this.audio.currentTime = seek;
    }
    this.audio.playbackRate = this.speed;
    this.loading = false;
    this.status = '';
    this.push();
  }

  private async playRecording(data: ArrayBuffer, id: number): Promise<void> {
    this.blobUrl = URL.createObjectURL(new Blob([data], { type: 'audio/mpeg' }));
    this.audio.src = this.blobUrl;
    this.audio.load();
    await this.startElement(id);
  }

  private async playStream(recording: Recording, estSeconds: number, id: number): Promise<void> {
    this.status = 'Getting the voice ready…';
    this.push();

    if (!GrowingMp3.supported()) {
      // No streaming here: wait for the whole chapter, then play it.
      const { audio } = await recording.done;
      if (id !== this.playbackId) return;
      await this.playRecording(audio, id);
      return;
    }

    const stream = new GrowingMp3();
    this.stream = stream;
    this.streamEstimate = estSeconds;
    this.audio.src = stream.url;
    stream.played = () => this.audio.currentTime;
    stream.onError = (e) => this.fail(e, id);
    stream.onFirstData = () => {
      if (id !== this.playbackId) return;
      this.startElement(id).catch((e: unknown) => this.fail(e, id));
    };
    this.unsubscribeStream = recording.subscribe((piece) => stream.push(piece));
    recording.done.then(
      () => {
        if (id === this.playbackId) stream.end();
      },
      (e: unknown) => this.fail(e, id),
    );
  }

  // ------------------------------------------------------------ system voice

  private playSpeech(text: string, hasTitle: boolean, id: number): void {
    const synth = window.speechSynthesis;
    if (!synth) {
      this.fail(new Error('This device has no system voice. Pick another voice in the plugin settings.'), id);
      return;
    }
    const segments = toSegments(text, { hasTitle });
    if (segments.length === 0) {
      this.onChapterEnded(true);
      return;
    }
    const wanted = this.systemVoiceOverride ?? this.settings.systemVoice;
    const voice = synth.getVoices().find((v) => v.voiceURI === wanted);

    this.speaking = true;
    this.speechPaused = false;
    this.loading = false;
    this.push();

    // One sentence at a time, so a speed or volume change applies from the next one.
    this.speechSegments = segments;
    this.speechIndex = 0;
    this.speechVoice = voice ?? null;
    this.speakCurrent(id);
  }

  private speechSegments: TextSegment[] = [];
  private speechIndex = 0;
  private speechVoice: SpeechSynthesisVoice | null = null;

  private speakCurrent(id: number): void {
    const synth = window.speechSynthesis;
    const segment = this.speechSegments[this.speechIndex];
    if (!synth || !segment) return;
    const utterance = new SpeechSynthesisUtterance(segment.text);
    if (this.speechVoice) utterance.voice = this.speechVoice;
    utterance.rate = this.speed;
    utterance.volume = this.audio.volume;
    utterance.onend = () => {
      if (id !== this.playbackId || !this.speaking) return;
      this.speechIndex++;
      if (this.speechIndex < this.speechSegments.length) {
        this.speakCurrent(id);
        return;
      }
      this.speaking = false;
      this.onChapterEnded(true);
    };
    utterance.onerror = (event) => {
      if (id !== this.playbackId) return;
      if (event.error === 'canceled' || event.error === 'interrupted') return;
      this.speaking = false;
      this.fail(new Error(`The system voice failed (${event.error}).`), id);
    };
    synth.speak(utterance);
  }

  /** Speed or volume changed mid-sentence: say the sentence again with the new values. */
  private restartSpeech(): void {
    if (!this.speaking || this.speechPaused) return;
    window.speechSynthesis.cancel();
    this.speakCurrent(this.playbackId);
  }

  // ------------------------------------------------------------ controls

  pausePlayback(): void {
    if (this.speaking) {
      window.speechSynthesis.pause();
      this.speechPaused = true;
      this.paused = true;
      this.updateStatusBarCallback(true);
      this.push();
    } else if (!this.audio.paused) {
      this.audio.pause();
    }
  }

  resumePlayback(): void {
    if (this.speaking) {
      window.speechSynthesis.resume();
      this.speechPaused = false;
      this.paused = false;
      this.updateStatusBarCallback(true);
      this.push();
    } else if (this.audio.paused && this.audio.src) {
      this.audio.play().catch((e: unknown) => console.error('TTS Chapter Reader: could not resume.', e));
    }
  }

  isPlaybackPaused(): boolean {
    return this.paused;
  }

  stopPlayback(): void {
    this.teardownSource();
    this.provider = null;
    this.chapterIndex = 0;
    this.loading = false;
    this.paused = false;
    this.status = '';
    this.hidePlayer();
    this.updateStatusBarCallback(false);
    this.onStopped();
  }

  /** Let go of the current chapter's audio, whatever form it has. */
  private teardownSource(): void {
    this.playbackId++;

    if (this.speaking) {
      this.speaking = false;
      this.speechPaused = false;
      window.speechSynthesis.cancel();
    }

    this.unsubscribeStream?.();
    this.unsubscribeStream = null;

    this.audio.pause();
    if (this.audio.src) {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.stream?.destroy();
    this.stream = null;
    this.streamEstimate = 0;
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  }

  replayPlayback(): void {
    if (this.provider) {
      void this.playChapterAt(this.chapterIndex);
    }
  }

  /** How far the listener may seek: the whole recording, or what exists of it so far. */
  private seekLimit(): number {
    if (this.stream && !this.stream.complete) return Math.max(0, this.stream.bufferedEnd - 0.25);
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  seekPlayback(time: number): void {
    if (this.speaking) return;
    const limit = this.seekLimit();
    if (limit <= 0) return;
    this.audio.currentTime = Math.max(0, Math.min(time, limit));
  }

  jumpForward(seconds = 10): void {
    this.seekPlayback(this.audio.currentTime + seconds);
  }

  jumpBackward(seconds = 10): void {
    this.seekPlayback(this.audio.currentTime - seconds);
  }

  setPlaybackSpeed(speed: number): void {
    this.speed = speed;
    this.audio.playbackRate = speed;
    this.restartSpeech();
  }

  /** 0 to 1. Takes effect at once; the system voice says its current sentence again at the new volume. */
  setVolume(volume: number): void {
    this.audio.volume = Math.max(0, Math.min(1, volume));
    this.restartSpeech();
  }
}
