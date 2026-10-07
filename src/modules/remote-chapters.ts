import { Notice, requestUrl } from 'obsidian';
import type { AudioPlaybackManager } from './audio-playback';
import type { Chapter, ChapterSession } from './chapters';
import type { PluginSettings } from './settings-data';

/**
 * Chapters served by an external chapter server (personal option).
 *
 * The server (vault_api.py) derives the sections from the note's headings,
 * records each one and caches it under a content hash. Favorites and hidden
 * marks live in Knowledge Tracker's chapter store under the same title-derived
 * key, so this player and KT's Daily Priming player show the same marks. If KT
 * is unreachable the chapter list still works; the marks are just not saved.
 */

interface MetaSection {
  i: number; title: string; words: number; est_sec: number;
  cached: boolean; duration: number | null; german: boolean;
  sec_hash: string; empty?: boolean;
}

interface RemoteChapter extends Chapter {
  secHash: string;
}

/** MUST stay in sync with chapterKey() in KT's DailyPrimingView.tsx. */
function deriveKeys(sections: MetaSection[]): string[] {
  const titleAt = (j: number) => (sections[j]?.title || `§${j}`).trim().toLowerCase();
  return sections.map((_, i) => {
    const title = titleAt(i);
    let n = 0;
    for (let j = 0; j < i; j++) if (titleAt(j) === title) n++;
    return n === 0 ? title : `${title}~${n}`;
  });
}

export class RemoteChapterSession implements ChapterSession {
  chapters: RemoteChapter[] = [];
  currentIndex = 0;
  showList = true;
  canFlag = true;
  canRecord = true;
  favoritesOnly = false;

  /** The chapter server translates on its own. */
  foreignLanguage(): string | null {
    return null;
  }

  foreignLanguages(): string[] {
    return [];
  }

  get title(): string {
    return this.vaultPath.split('/').pop()?.replace(/\.md$/i, '') ?? this.vaultPath;
  }

  get notePath(): string {
    return this.vaultPath;
  }

  setFavoritesOnly(on: boolean): void {
    this.favoritesOnly = on;
    this.onChange();
  }

  /** The server keeps the spoken text; only the chapter titles are known here. */
  spokenText(): string {
    return this.chapters.map((c) => c.title).join('\n\n');
  }

  /** The server's chapters carry no note lines. */
  positionLines(): [number, number] | null {
    return null;
  }

  locate(): null {
    return null;
  }
  private cancelled = false;
  private ktWarned = false;
  private audioCache = new Map<string, ArrayBuffer>();

  constructor(
    private getSettings: () => PluginSettings,
    private vaultPath: string,
    private audioManager: AudioPlaybackManager,
    private onChange: () => void,
  ) {}

  private get api(): string {
    return this.getSettings().externalChapters.vaultApiUrl.replace(/\/+$/, '');
  }

  private get kt(): string {
    return this.getSettings().externalChapters.ktApiUrl.replace(/\/+$/, '');
  }

  private async fetchMeta(): Promise<MetaSection[]> {
    const meta = await requestUrl({
      url: `${this.api}/priming-audio-meta?path=${encodeURIComponent(this.vaultPath)}`,
      method: 'GET',
    });
    return (meta.json as { sections?: MetaSection[] })?.sections || [];
  }

  /** Fetch sections + shared pin/hide flags. Returns false when the note has
   *  no readable sections (caller falls back to the plugin's own chapters). */
  async load(): Promise<boolean> {
    const sections = await this.fetchMeta();
    if (sections.length === 0 || sections.every((s) => s.empty)) return false;

    let flags: Record<string, { pinned: boolean; hidden: boolean }> = {};
    if (this.kt) {
      try {
        const kt = await requestUrl({
          url: `${this.kt}/api/vault/priming/chapters?vault_path=${encodeURIComponent(this.vaultPath)}`,
          method: 'GET',
        });
        flags = (kt.json as { chapters?: typeof flags })?.chapters || {};
      } catch {
        /* KT unreachable: chapters still work, flags are inert */
      }
    }

    const keys = deriveKeys(sections);
    this.chapters = sections.map((s, i) => ({
      i: s.i,
      title: s.title,
      level: 1,
      key: keys[i],
      estSec: s.est_sec,
      cached: s.cached,
      duration: s.duration,
      lang: null,
      translated: false,
      translating: false,
      empty: !!s.empty,
      secHash: s.sec_hash,
      pinned: flags[keys[i]]?.pinned ?? false,
      hidden: flags[keys[i]]?.hidden ?? false,
      recording: false,
    }));
    return true;
  }

  /** Re-fetch section meta only (durations/cached state after generation);
   *  keeps local pin/hide/recording state. */
  async refresh(): Promise<void> {
    try {
      for (const s of await this.fetchMeta()) {
        const c = this.chapters[s.i];
        if (c && c.secHash === s.sec_hash) {
          c.cached = s.cached;
          c.duration = s.duration;
        }
      }
      this.onChange();
    } catch { /* next full load picks it up */ }
  }

  isPlayable(i: number): boolean {
    const c = this.chapters[i];
    if (!c || c.empty || c.hidden) return false;
    return !this.favoritesOnly || c.pinned || !this.chapters.some((ch) => ch.pinned);
  }

  private async fetchAudio(i: number, force = false): Promise<ArrayBuffer> {
    const c = this.chapters[i];
    if (!force) {
      const hit = this.audioCache.get(c.secHash);
      if (hit) return hit;
    }
    const res = await requestUrl({
      url: `${this.api}/priming-audio?path=${encodeURIComponent(this.vaultPath)}&section=${i}${force ? '&force=1' : ''}`,
      method: 'GET',
    });
    this.audioCache.set(c.secHash, res.arrayBuffer);
    if (!c.cached || force) void this.refresh();
    return res.arrayBuffer;
  }

  start(index?: number, time?: number): boolean {
    const startAt = index ?? this.chapters.findIndex((_, i) => this.isPlayable(i));
    if (startAt < 0) return false;
    const count = () => this.chapters.length;
    this.audioManager.startChapterPlayback(
      {
        get count() {
          return count();
        },
        isPlayable: (i) => this.isPlayable(i),
        open: async (i) => ({ kind: 'audio', data: await this.fetchAudio(i) }),
        onIndexChange: (i) => { this.currentIndex = i; this.onChange(); },
      },
      startAt,
      time,
    );
    void this.recordStale();
    return true;
  }

  play(i: number): void {
    this.audioManager.jumpToChapter(i);
  }

  /** Background pass: pre-record every stale/unrecorded chapter, one at a
   *  time (the server locks per section anyway). */
  private async recordStale(): Promise<void> {
    if (this.getSettings().recordAhead === 'off') return;
    for (const c of this.chapters) {
      if (this.cancelled) return;
      if (c.empty || c.cached || c.recording) continue;
      c.recording = true;
      this.onChange();
      try {
        await this.fetchAudio(c.i);
      } catch { /* generation failure is visible as still-unrecorded */ }
      c.recording = false;
      this.onChange();
    }
  }

  async rerecord(i: number): Promise<void> {
    const c = this.chapters[i];
    if (!c || c.empty || c.recording) return;
    c.recording = true;
    this.onChange();
    try {
      this.audioCache.delete(c.secHash);
      await this.fetchAudio(i, true);
      if (this.getSettings().showNotices) new Notice(`Recorded again: ${c.title}`);
    } catch (e) {
      if (this.getSettings().showNotices) new Notice(`Recording failed: ${(e as Error).message}`);
    }
    c.recording = false;
    this.onChange();
  }

  togglePinned(i: number): void {
    const c = this.chapters[i];
    if (!c) return;
    c.pinned = !c.pinned;
    this.onChange();
    this.postFlag(c, { pinned: c.pinned });
  }

  toggleHidden(i: number): void {
    const c = this.chapters[i];
    if (!c) return;
    c.hidden = !c.hidden;
    this.onChange();
    this.postFlag(c, { hidden: c.hidden });
  }

  private postFlag(c: RemoteChapter, patch: { pinned?: boolean; hidden?: boolean }): void {
    if (!this.kt) return;
    requestUrl({
      url: `${this.kt}/api/vault/priming/chapters`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vault_path: this.vaultPath, chapter_key: c.key, ...patch }),
    }).catch(() => {
      if (!this.ktWarned) {
        this.ktWarned = true;
        if (this.getSettings().showNotices) {
          new Notice('Knowledge Tracker is unreachable: favorite/hide not saved (works again when it is up).');
        }
      }
    });
  }

  destroy(): void {
    this.cancelled = true;
  }
}
