import {
  AudioMeta,
  SegmentMark,
  idbWriteMany,
  idbGet,
  idbGetAll,
  idbPut,
  STORE_AUDIO,
  STORE_AUDIO_META,
} from '../shared/idb';

/**
 * Saved recordings, keyed by a hash of (voice + text).
 *
 * Because the key is the content, there is nothing to invalidate: edit a
 * chapter and its hash changes, so it simply has no recording yet, while every
 * untouched chapter still finds its audio.
 */

export async function contentHash(voiceFingerprint: string, text: string): Promise<string> {
  const data = new TextEncoder().encode(`${voiceFingerprint}\n${text}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class AudioCache {
  constructor(private getLimitMb: () => number) {}

  async meta(hash: string): Promise<AudioMeta | undefined> {
    return idbGet<AudioMeta>(STORE_AUDIO_META, hash);
  }

  async get(hash: string): Promise<ArrayBuffer | undefined> {
    const audio = await idbGet<ArrayBuffer>(STORE_AUDIO, hash);
    if (!audio) return undefined;
    const meta = await this.meta(hash);
    if (meta) {
      meta.lastUsed = Date.now();
      // Not awaited: a failed timestamp update must not block playback.
      idbPut(STORE_AUDIO_META, hash, meta).catch(() => undefined);
    }
    return audio;
  }

  async put(hash: string, audio: ArrayBuffer, duration: number, label: string, marks?: SegmentMark[]): Promise<void> {
    const now = Date.now();
    const meta: AudioMeta = { hash, bytes: audio.byteLength, duration, created: now, lastUsed: now, label, marks };
    // One transaction: never audio without its record or a record without audio.
    await idbWriteMany([
      { store: STORE_AUDIO, key: hash, value: audio, op: 'put' },
      { store: STORE_AUDIO_META, key: hash, value: meta, op: 'put' },
    ]);
    await this.prune();
  }

  async delete(hash: string): Promise<void> {
    await idbWriteMany([
      { store: STORE_AUDIO, key: hash, op: 'delete' },
      { store: STORE_AUDIO_META, key: hash, op: 'delete' },
    ]);
  }

  async stats(): Promise<{ count: number; bytes: number }> {
    const all = await idbGetAll<AudioMeta>(STORE_AUDIO_META);
    return { count: all.length, bytes: all.reduce((n, m) => n + m.bytes, 0) };
  }

  async clear(): Promise<void> {
    await idbWriteMany([
      { store: STORE_AUDIO, op: 'clear' },
      { store: STORE_AUDIO_META, op: 'clear' },
    ]);
  }

  /** Over the limit: drop the recordings that were listened to longest ago. */
  private async prune(): Promise<void> {
    const limit = this.getLimitMb() * 1024 * 1024;
    const all = await idbGetAll<AudioMeta>(STORE_AUDIO_META);
    let total = all.reduce((n, m) => n + m.bytes, 0);
    if (total <= limit) return;
    all.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const meta of all) {
      if (total <= limit) break;
      await this.delete(meta.hash);
      total -= meta.bytes;
    }
  }
}
