import SignalsmithStretch from 'signalsmith-stretch';

/**
 * Plays a finished recording through the plugin's own time-stretcher
 * (Signalsmith Stretch in an AudioWorklet): any speed keeps the natural
 * pitch, and the first sounds after a pause stay sharp, which the browser's
 * playbackRate stretcher softens.
 *
 * One audio context lives for the plugin's lifetime; every start gets a fresh
 * worklet node with its samples. The node keeps one (unconnected) input: with
 * none, its processor dies the first time it runs inactive (before the start
 * order, on pause, on stop; measured in Obsidian, 2026-10-13). It reports its
 * position a few times a second.
 */

interface StretchNode extends AudioWorkletNode {
  inputTime: number;
  schedule(change: { active?: boolean; input?: number; rate?: number; output?: number }): Promise<unknown>;
  addBuffers(buffers: Float32Array[]): Promise<number>;
  setUpdateInterval(seconds: number, callback: (inputTime: number) => void): Promise<unknown>;
}

/** Reported this close to the end counts as the end (the worklet reports every 50 ms). */
const END_SLACK = 0.08;
/** Changes are scheduled this far ahead of the audio clock, so the worklet never sees them as past. */
const LEAD = 0.03;

export class StretchPlayer {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private node: StretchNode | null = null;
  /** The decoded recording, mono, at the context's sample rate. */
  private samples: Float32Array | null = null;
  private active = false;
  private ended = false;
  private time = 0;
  private volume = 1;
  /** Length of the loaded recording in seconds. */
  duration = 0;
  /** Position moved (several times a second while playing, and on every seek). */
  onTime: (time: number) => void = () => undefined;
  /** The recording has been played to its end. */
  onEnded: () => void = () => undefined;
  /** The worklet died; the caller should fall back to the audio element. */
  onError: (error: Error) => void = () => undefined;

  static supported(): boolean {
    return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
  }

  private output(): { context: AudioContext; gain: GainNode } {
    if (!this.context || !this.gain) {
      const context = new AudioContext();
      const gain = context.createGain();
      gain.gain.value = this.volume;
      gain.connect(context.destination);
      this.context = context;
      this.gain = gain;
    }
    return { context: this.context, gain: this.gain };
  }

  /** When a scheduled change should take effect: just ahead of the audio clock. */
  private now(): number {
    return (this.context?.currentTime ?? 0) + LEAD;
  }

  private dropNode(): void {
    const old = this.node;
    this.node = null;
    if (!old) return;
    void old.schedule({ output: this.now(), active: false });
    try {
      old.disconnect();
    } catch {
      /* already gone */
    }
  }

  /** Decode an MP3 and keep it as the recording to play. Resolves to its length in seconds. */
  async load(mp3: ArrayBuffer): Promise<number> {
    const { context } = this.output();
    this.dropNode();
    // decodeAudioData takes ownership of its buffer, so it gets a copy.
    const decoded = await context.decodeAudioData(mp3.slice(0));
    const mono = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const channel = decoded.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / decoded.numberOfChannels;
    }
    this.samples = mono;
    this.duration = decoded.duration;
    this.time = 0;
    this.active = false;
    this.ended = false;
    return this.duration;
  }

  /** Start at `at` seconds with playback `rate`: a fresh node, its samples and the start order in one go. */
  async play(at: number, rate: number): Promise<void> {
    const samples = this.samples;
    if (!samples) return;
    const { context, gain } = this.output();
    if (context.state !== 'running') await context.resume();
    this.dropNode();
    const node = (await SignalsmithStretch(context, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })) as StretchNode;
    node.connect(gain);
    node.onprocessorerror = () => {
      if (this.node !== node) return;
      this.active = false;
      this.onError(new Error('The time-stretcher stopped working.'));
    };
    await node.setUpdateInterval(0.05, (t) => {
      if (this.node === node) this.tick(t);
    });
    this.node = node;
    this.time = Math.max(0, Math.min(at, this.duration));
    this.ended = false;
    this.active = true;
    await node.addBuffers([samples]);
    if (this.node !== node) return;
    await node.schedule({ output: this.now(), input: this.time, rate, active: true });
    this.onTime(this.time);
  }

  pause(): void {
    this.active = false;
    void this.node?.schedule({ output: this.now(), active: false });
  }

  resume(): void {
    if (!this.node || this.ended) return;
    this.active = true;
    void this.node.schedule({ output: this.now(), active: true });
  }

  seek(time: number): void {
    this.time = Math.max(0, Math.min(time, this.duration));
    this.ended = false;
    void this.node?.schedule({ output: this.now(), input: this.time });
    this.onTime(this.time);
  }

  setRate(rate: number): void {
    void this.node?.schedule({ output: this.now(), rate });
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.gain) this.gain.gain.value = volume;
  }

  currentTime(): number {
    return this.time;
  }

  /** Let go of the recording and its node; the audio context stays for the next one. */
  stop(): void {
    this.active = false;
    this.ended = false;
    this.time = 0;
    this.duration = 0;
    this.samples = null;
    this.dropNode();
  }

  destroy(): void {
    this.stop();
    void this.context?.close();
    this.context = null;
    this.gain = null;
  }

  private tick(inputTime: number): void {
    if (!this.active) return;
    this.time = Math.max(0, Math.min(inputTime, this.duration));
    this.onTime(this.time);
    if (!this.ended && this.duration > 0 && inputTime >= this.duration - END_SLACK) {
      this.ended = true;
      this.active = false;
      void this.node?.schedule({ output: this.now(), active: false });
      this.onEnded();
    }
  }
}
