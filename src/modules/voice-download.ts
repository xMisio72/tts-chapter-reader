import { DownloadCancelled, downloadBuiltinVoice, downloadBytes } from './builtin-voice';

const MEGABYTE = 1024 * 1024;

/**
 * The one download of the natural voice, shared by every place that shows it
 * (the first-run dialog and the settings page). Closing either one does not
 * stop the download; it carries on and both pick the progress up again.
 */
export class VoiceDownload {
  running = false;
  received = 0;
  total = downloadBytes();
  error: string | null = null;

  private controller: AbortController | null = null;
  private current: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolves true once the voice is installed, false if cancelled or failed. */
  start(voiceId: string): Promise<boolean> {
    if (this.current) return this.current;
    this.running = true;
    this.received = 0;
    this.error = null;
    this.controller = new AbortController();
    this.emit();

    this.current = downloadBuiltinVoice(
      voiceId,
      (received, total) => {
        const before = Math.floor(this.received / MEGABYTE);
        this.received = received;
        this.total = total;
        // Progress arrives many times a second; redraw once per megabyte.
        if (Math.floor(received / MEGABYTE) !== before || received === total) this.emit();
      },
      this.controller.signal,
    ).then(
      () => true,
      (e: unknown) => {
        if (!(e instanceof DownloadCancelled)) {
          console.error('TTS Chapter Reader: voice download failed.', e);
          this.error = e instanceof Error ? e.message : String(e);
        }
        return false;
      },
    ).then((ok) => {
      this.running = false;
      this.controller = null;
      this.current = null;
      this.emit();
      return ok;
    });
    return this.current;
  }

  cancel(): void {
    this.controller?.abort();
  }

  get percent(): number {
    return this.total > 0 ? Math.round((this.received / this.total) * 100) : 0;
  }
}
