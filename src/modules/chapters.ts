import { Notice } from 'obsidian';
import type { AudioCache } from './audio-cache';
import { contentHash } from './audio-cache';
import type { AudioPlaybackManager, ChapterProvider, ChapterSource } from './audio-playback';
import { splitIntoChapters } from './chapter-split';
import type { Engine } from './engines';
import { detectChapterLanguages } from './language';
import type { Recorder } from './recorder';
import type { ChapterFlags, PluginSettings, RecordAhead } from './settings-data';
import type { SegmentMark } from '../shared/idb';
import type { TextSegment } from '../shared/protocol';
import { CHAPTER_LEAD_MS, estimateSeconds, toSegments, withChapterLead } from './text-segments';
import { cachedTranslation, storeTranslation, translateText, type Translator } from './translators';
import { JobCancelled, type CancelToken } from './tts-worker-client';

function paragraphCount(text: string): number {
  return text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
}

/**
 * A note being listened to, as a list of chapters (one per heading).
 *
 * Each chapter's recording is saved under a hash of its text and the voice.
 * An edited chapter therefore shows up as "not recorded" on its own and is
 * recorded again, while every other chapter keeps its audio.
 */

export interface Chapter {
  i: number;
  title: string;
  /** Heading level 1-6; 0 for the text before the first heading. */
  level: number;
  /** Stable name for the favorite/hidden marks. */
  key: string;
  estSec: number;
  /** A saved recording exists for the current text and voice. */
  cached: boolean;
  duration: number | null;
  /** Nothing to read aloud. */
  empty: boolean;
  pinned: boolean;
  hidden: boolean;
  recording: boolean;
  /** Language of the text when it is not English (ISO 639-1), else null. */
  lang: string | null;
  /** The voice reads an English translation of this chapter. */
  translated: boolean;
  translating: boolean;
}

/** What the player and the plugin need from a note that is being read. */
export interface ChapterSession {
  chapters: Chapter[];
  currentIndex: number;
  /** Shown in the player: the note's name, or "Selection" and the like. */
  title: string;
  /** Vault path of the note being read; null for loose text. */
  notePath: string | null;
  /** Only favorite chapters play. */
  favoritesOnly: boolean;
  setFavoritesOnly(on: boolean): void;
  /** Everything the voice says for this note, chapter by chapter. */
  spokenText(): string;
  /** Note lines [from, to] being read at `time` seconds into chapter `i`; null when unknown. */
  positionLines(i: number, time: number): [number, number] | null;
  /** The chapter that contains note line `line`, and the time in it where that paragraph starts (null: unknown, start of chapter). */
  locate(line: number): { index: number; time: number | null } | null;
  /** Begin at chapter `index` (default: the first playable one), `time` seconds in when known. False when nothing may play. */
  start(index?: number, time?: number): boolean;
  /** Every language other than English in the note. */
  foreignLanguages(): string[];
  /** The note was renamed or moved while it is being read. */
  renamed?(path: string, title: string): void;
  /** Show the chapter list in the player. */
  showList: boolean;
  /** Favorite and hidden marks can be remembered (there is a note to attach them to). */
  canFlag: boolean;
  /** Recordings exist for this session (false for the system voice). */
  canRecord: boolean;
  /** The first language other than English found in the note, or null. */
  foreignLanguage(): string | null;
  play(i: number): void;
  togglePinned(i: number): void;
  toggleHidden(i: number): void;
  rerecord(i: number): void | Promise<void>;
  /** The note or the settings changed: bring the chapter list up to date. */
  refresh(): Promise<void>;
  destroy(): void;
}

interface LocalChapter extends Chapter {
  /** What the voice says (the translation, when there is one). */
  text: string;
  /** The chapter as written in the note. */
  source: string;
  hasTitle: boolean;
  hash: string;
  /** Written in another language and not translated yet. */
  needsTranslation: boolean;
  /** Note lines of the chapter and of each spoken paragraph (see chapter-split). */
  line: number;
  endLine: number;
  paragraphLines: [number, number][] | null;
  /** The pieces the voice speaks, in order; `paragraph` on each links back to the text. */
  segments: TextSegment[];
  /** Where each recorded piece ends; known for recordings made by this plugin version. */
  marks: SegmentMark[] | null;
}

export interface TranslationSetup {
  /** The voice in use wants English text. */
  wanted: boolean;
  /** How to translate; null when translation is off. */
  translator: Translator | null;
}

export interface LocalSessionDeps {
  getSettings: () => PluginSettings;
  /** The engine that records audio, or null when the system voice speaks. */
  getEngine: () => Engine | null;
  getTranslation: () => TranslationSetup;
  audioManager: AudioPlaybackManager;
  recorder: Recorder;
  cache: AudioCache;
  /** Markdown to spoken text (the plugin's text filters). */
  clean: (markdown: string) => string;
  saveFlags: (notePath: string, key: string, flags: ChapterFlags) => void;
  onChange: () => void;
}

export interface LocalSessionSource {
  /** Vault path of the note; null for a selection or other loose text. */
  notePath: string | null;
  title: string;
  getMarkdown: () => Promise<string>;
}

export class LocalChapterSession implements ChapterSession {
  chapters: LocalChapter[] = [];
  currentIndex = 0;
  showList = true;
  canFlag: boolean;
  canRecord = true;
  favoritesOnly: boolean;

  private destroyed = false;
  private started = false;
  /** A background recording failed; stop queueing more for this note. */
  private aheadBroken = false;
  private aheadRunning = false;
  private aheadAgain = false;
  private removeRecorderListener: () => void;
  /** Translations in flight, by chapter key + source text + translator, so a chapter is never translated twice at once. */
  private translating = new Map<string, Promise<boolean>>();
  private cancels = new Set<CancelToken>();
  /** Bumped per rebuild; an older rebuild that finishes late must not replace a newer list. */
  private rebuildGen = 0;

  constructor(private deps: LocalSessionDeps, private source: LocalSessionSource) {
    // Loose text (a selection) still gets chapters, but marks need a note to live in.
    this.canFlag = source.notePath !== null;
    this.favoritesOnly = this.canFlag && deps.getSettings().favoritesOnly;
    this.removeRecorderListener = deps.recorder.addListener({
      onChange: (hash, event, info) => this.onRecorderEvent(hash, event, info),
    });
  }

  /** Read the note and work out its chapters. False when there is nothing to read. */
  async load(): Promise<boolean> {
    await this.rebuild();
    return this.chapters.some((c) => !c.empty);
  }

  private async rebuild(): Promise<void> {
    const gen = ++this.rebuildGen;
    const settings = this.deps.getSettings();
    const engine = this.deps.getEngine();
    this.canRecord = engine !== null;

    const markdown = await this.source.getMarkdown();
    const parts = splitIntoChapters(markdown, {
      noteTitle: this.source.title,
      readHeadings: settings.readHeadings,
      clean: this.deps.clean,
    });
    const flags = this.source.notePath ? settings.chapterFlags[this.source.notePath] ?? {} : {};
    const translation = this.deps.getTranslation();
    const languages = translation.wanted ? detectChapterLanguages(parts.map((p) => p.text)) : parts.map(() => null);

    const chapters: LocalChapter[] = [];
    for (const [i, part] of parts.entries()) {
      // Languages the user chose to hear as they are count as readable.
      const detected = languages[i];
      const lang = detected && detected !== 'en' && !settings.translation.readAsIs.includes(detected) ? detected : null;
      let text = part.text;
      let translated = false;
      let needsTranslation = false;
      if (lang && translation.translator && !part.empty) {
        const saved = await cachedTranslation(translation.translator.id(), part.text);
        if (saved !== undefined) {
          text = saved;
          translated = true;
        } else {
          needsTranslation = true;
        }
      }
      // The system voice keeps no recordings, so there is nothing to look up.
      // A chapter still waiting for its translation must not match a recording
      // of the untranslated text.
      const hash = engine ? await contentHash(this.fingerprint(engine), needsTranslation ? `untranslated\n${text}` : text) : '';
      const meta = engine && !part.empty ? await this.deps.cache.meta(hash) : undefined;
      chapters.push({
        i,
        title: part.title,
        level: part.level,
        key: part.key,
        text,
        source: part.text,
        hasTitle: part.hasTitle,
        hash,
        estSec: estimateSeconds(text),
        cached: engine ? meta !== undefined : true,
        duration: meta?.duration ?? null,
        empty: part.empty,
        pinned: flags[part.key]?.pinned ?? false,
        hidden: flags[part.key]?.hidden ?? false,
        recording: engine ? this.deps.recorder.stateOf(hash) === 'running' : false,
        lang,
        translated,
        needsTranslation,
        line: part.line,
        endLine: part.endLine,
        // A translation has its own paragraphs; they match the note's only when the count agrees.
        paragraphLines: translated && part.paragraphLines && part.paragraphLines.length !== paragraphCount(text) ? null : part.paragraphLines,
        segments: this.segmentsFor(text, part.hasTitle),
        marks: meta?.marks ?? null,
        translating: this.translating.has(this.translatingKey(part.key, part.text, translation.translator?.id() ?? '')),
      });
    }
    if (gen !== this.rebuildGen) return;
    this.chapters = chapters;
  }

  private translatingKey(key: string, source: string, translatorId: string): string {
    return `${key}\n${translatorId}\n${source}`;
  }

  /** Every language other than English in the note, in order of appearance. */
  foreignLanguages(): string[] {
    const out: string[] = [];
    for (const c of this.chapters) if (c.lang && !c.empty && !out.includes(c.lang)) out.push(c.lang);
    return out;
  }

  private segmentsFor(text: string, hasTitle: boolean): TextSegment[] {
    const segments = toSegments(text, { hasTitle });
    return this.deps.getSettings().pauseAtChapterStart ? withChapterLead(segments) : segments;
  }

  positionLines(i: number, time: number): [number, number] | null {
    const c = this.chapters[i];
    if (!c) return null;
    const whole: [number, number] = [c.line, c.endLine];
    if (!c.marks || !c.paragraphLines) return whole;
    const piece = c.marks.find((m) => time < m.end) ?? c.marks[c.marks.length - 1];
    const paragraph = piece ? c.segments[piece.segment]?.paragraph : undefined;
    return paragraph !== undefined && c.paragraphLines[paragraph] ? c.paragraphLines[paragraph] : whole;
  }

  locate(line: number): { index: number; time: number | null } | null {
    const c = this.chapters.find((ch) => line >= ch.line && line <= ch.endLine && !ch.empty);
    if (!c) return null;
    if (!c.marks || !c.paragraphLines) return { index: c.i, time: null };
    const paragraph = c.paragraphLines.findIndex(([from, to]) => line >= from && line <= to);
    if (paragraph < 0) return { index: c.i, time: null };
    const firstSegment = c.segments.findIndex((s) => s.paragraph === paragraph);
    const pieceIndex = c.marks.findIndex((m) => m.segment >= firstSegment);
    if (firstSegment < 0 || pieceIndex < 0) return { index: c.i, time: null };
    return { index: c.i, time: pieceIndex === 0 ? 0 : c.marks[pieceIndex - 1].end };
  }

  foreignLanguage(): string | null {
    return this.chapters.find((c) => c.lang && !c.empty)?.lang ?? null;
  }

  /** What a recording depends on besides the text: the voice, and whether the chapter starts with a pause. */
  private fingerprint(engine: Engine): string {
    return this.deps.getSettings().pauseAtChapterStart ? `${engine.fingerprint()}:start${CHAPTER_LEAD_MS}` : engine.fingerprint();
  }

  private segments(chapter: LocalChapter) {
    chapter.segments = this.segmentsFor(chapter.text, chapter.hasTitle);
    return chapter.segments;
  }

  /**
   * Translate a chapter that still needs it, then point its hash at the
   * English text. Resolves false when the session ended meanwhile.
   */
  private prepare(chapter: LocalChapter): Promise<boolean> {
    if (!chapter.needsTranslation) return Promise.resolve(true);
    const { translator } = this.deps.getTranslation();
    const jobKey = this.translatingKey(chapter.key, chapter.source, translator?.id() ?? '');
    const running = this.translating.get(jobKey);
    if (running) return running;

    const job = (async () => {
      if (!translator || !chapter.lang) {
        chapter.needsTranslation = false;
        return !this.destroyed;
      }
      const cancel: CancelToken = { cancelled: false };
      this.cancels.add(cancel);
      chapter.translating = true;
      this.deps.onChange();
      // The note may be rebuilt while this runs (an edit elsewhere); the
      // result then belongs to the chapter object that is current by then.
      const targets = () => {
        const current = this.chapters.find((c) => c.key === chapter.key && c.source === chapter.source);
        return current && current !== chapter ? [chapter, current] : [chapter];
      };
      try {
        const text = await translateText(translator, chapter.source, chapter.lang, cancel);
        // A cancelled or ended session must not leave a half-trusted result behind.
        if (this.destroyed || cancel.cancelled) throw new JobCancelled();
        await storeTranslation(translator.id(), chapter.source, text);
        if (this.destroyed) return false;
        const engine = this.deps.getEngine();
        const hash = engine ? await contentHash(this.fingerprint(engine), text) : '';
        const meta = engine ? await this.deps.cache.meta(hash) : undefined;
        for (const c of targets()) {
          c.text = text;
          c.translated = true;
          c.needsTranslation = false;
          c.estSec = estimateSeconds(text);
          c.hash = hash;
          c.cached = engine ? meta !== undefined : true;
          c.duration = meta?.duration ?? null;
        }
        return true;
      } finally {
        this.cancels.delete(cancel);
        for (const c of targets()) c.translating = false;
        this.translating.delete(jobKey);
        this.deps.onChange();
      }
    })();
    this.translating.set(jobKey, job);
    return job;
  }

  async refresh(): Promise<void> {
    if (this.destroyed) return;
    const current = this.chapters[this.currentIndex];
    await this.rebuild();
    if (this.destroyed) return;
    // Headings may have been added or removed above the listener's position.
    if (current) {
      const moved = this.chapters.findIndex((c) => c.key === current.key);
      if (moved >= 0 && moved !== this.currentIndex) {
        this.currentIndex = moved;
        this.deps.audioManager.setChapterIndex(moved);
      }
    }
    this.deps.onChange();
    if (this.started) this.recordAhead();
  }

  private onRecorderEvent(hash: string, event: 'started' | 'saved' | 'failed' | 'dropped', info?: { seconds?: number; marks?: SegmentMark[]; error?: Error }): void {
    const chapter = this.chapters.find((c) => c.hash === hash);
    if (!chapter) return;
    if (event === 'started') chapter.recording = true;
    if (event === 'saved') {
      chapter.recording = false;
      chapter.cached = true;
      chapter.duration = info?.seconds ?? chapter.duration;
      chapter.marks = info?.marks ?? chapter.marks;
    }
    if (event === 'failed' || event === 'dropped') chapter.recording = false;
    if (event === 'failed') this.aheadBroken = true;
    this.deps.onChange();
  }

  get title(): string {
    return this.source.title;
  }

  get notePath(): string | null {
    return this.source.notePath;
  }

  renamed(path: string, title: string): void {
    this.source.notePath = path;
    this.source.title = title;
  }

  isPlayable(i: number): boolean {
    const c = this.chapters[i];
    if (!c || c.empty || c.hidden) return false;
    // "Favorites only" is remembered across notes; a note without favorites plays as usual.
    return !this.favoritesOnly || c.pinned || !this.chapters.some((ch) => ch.pinned);
  }

  setFavoritesOnly(on: boolean): void {
    this.favoritesOnly = on;
    this.deps.onChange();
    if (this.started) this.recordAhead();
  }

  spokenText(): string {
    return this.chapters
      .filter((c) => !c.empty)
      .map((c) => c.text)
      .join('\n\n');
  }

  private provider(): ChapterProvider {
    // The player keeps this object for the whole session, so every member
    // reads the current chapter list rather than a copy.
    const count = () => this.chapters.length;
    return {
      get count() {
        return count();
      },
      isPlayable: (i) => this.isPlayable(i),
      open: (i) => this.open(i),
      onIndexChange: (i) => {
        this.currentIndex = i;
        this.deps.onChange();
        this.recordAhead();
      },
    };
  }

  private async open(i: number): Promise<ChapterSource> {
    const chapter = this.chapters[i];
    if (!chapter) throw new Error('This chapter no longer exists.');
    if (chapter.needsTranslation) {
      this.deps.audioManager.showStatus('Translating…');
      if (!(await this.prepare(chapter))) throw new JobCancelled();
    }
    const engine = this.deps.getEngine();
    if (!engine) return { kind: 'speech', text: chapter.text, hasTitle: chapter.hasTitle };

    const saved = await this.deps.cache.get(chapter.hash);
    // Stopped while the lookup ran: no new recording for a note nobody listens to.
    if (this.destroyed) throw new JobCancelled();
    if (saved) return { kind: 'audio', data: saved };
    chapter.cached = false;
    const recording = this.request(chapter, engine, 'now');
    // Pieces arrive while it plays: keep their boundaries so the note can follow along.
    chapter.marks = [];
    const marks = chapter.marks;
    const unsubscribe = recording.subscribe((_piece, seconds, segment) => {
      if (chapter.marks === marks) marks.push({ end: seconds, segment });
    });
    recording.done.then(unsubscribe, unsubscribe);
    return { kind: 'stream', recording, estSeconds: chapter.estSec };
  }

  private request(chapter: LocalChapter, engine: Engine, urgency: 'now' | 'soon' | 'ahead') {
    return this.deps.recorder.request(
      {
        hash: chapter.hash,
        label: `${this.source.title} / ${chapter.title}`,
        segments: this.segments(chapter),
        engine,
        owner: this,
      },
      urgency,
    );
  }

  /** False when no chapter may play (all hidden, or favorites only with none). */
  start(index?: number, time?: number): boolean {
    const startAt = index ?? this.chapters.findIndex((_, i) => this.isPlayable(i));
    if (startAt < 0) return false;
    this.started = true;
    this.currentIndex = startAt;
    this.deps.audioManager.startChapterPlayback(this.provider(), startAt, time);
    return true;
  }

  play(i: number): void {
    this.deps.audioManager.jumpToChapter(i);
  }

  private recordAheadMode(engine: Engine): Exclude<RecordAhead, 'auto'> {
    const mode = this.deps.getSettings().recordAhead;
    if (mode !== 'auto') return mode;
    // Free voices record the whole note; a billed voice or a billed translator
    // only the chapter that plays next, so nothing is paid for unheard.
    const translator = this.deps.getTranslation().translator;
    return engine.metered || (translator?.metered ?? false) ? 'next' : 'all';
  }

  /** Record later chapters in the background so they start without a wait. */
  private recordAhead(): void {
    if (this.aheadRunning) {
      // The chapter list changed under a running pass: go over it once more after.
      this.aheadAgain = true;
      return;
    }
    this.aheadRunning = true;
    this.recordAheadNow()
      .catch((e: unknown) => {
        // A failed translation stops the background work, like a failed recording.
        if (!(e instanceof JobCancelled)) {
          this.aheadBroken = true;
          if (this.deps.getSettings().showNotices) new Notice(e instanceof Error ? e.message : String(e), 10000);
        }
      })
      .finally(() => {
        this.aheadRunning = false;
        if (this.aheadAgain && !this.destroyed) {
          this.aheadAgain = false;
          this.recordAhead();
        }
      });
  }

  private async recordAheadNow(): Promise<void> {
    const engine = this.deps.getEngine();
    if (!engine || this.destroyed || this.aheadBroken) return;
    const mode = this.recordAheadMode(engine);
    if (mode === 'off') return;

    const after = this.chapters.slice(this.currentIndex + 1);
    const before = mode === 'all' ? this.chapters.slice(0, this.currentIndex) : [];
    let queued = 0;
    for (const chapter of [...after, ...before]) {
      if (!this.isPlayable(chapter.i)) continue;
      // Translations run one after another in the worker; wait for each so
      // the chapters are recorded in listening order.
      if (chapter.needsTranslation && !(await this.prepare(chapter))) return;
      if (this.destroyed || this.aheadBroken) return;
      if (!chapter.cached && this.deps.recorder.stateOf(chapter.hash) === null) {
        this.request(chapter, engine, 'ahead');
      }
      queued++;
      if (mode === 'next' && queued >= 1) break;
    }
  }

  /**
   * The finished audio of every playable chapter, in order, recording what is
   * missing first. For exporting the note. `onProgress` gets (done, total).
   */
  async recordAll(onProgress: (done: number, total: number) => void): Promise<ArrayBuffer[]> {
    const engine = this.deps.getEngine();
    if (!engine) throw new Error('The system voice makes no recordings, so there is nothing to export. Pick another voice first.');
    const wanted = this.chapters.filter((c) => this.isPlayable(c.i));
    const out: ArrayBuffer[] = [];
    onProgress(0, wanted.length);
    for (const chapter of wanted) {
      if (this.destroyed) throw new JobCancelled();
      if (chapter.needsTranslation && !(await this.prepare(chapter))) throw new JobCancelled();
      const saved = await this.deps.cache.get(chapter.hash);
      out.push(saved ?? (await this.request(chapter, engine, 'soon').done).audio);
      onProgress(out.length, wanted.length);
    }
    return out;
  }

  rerecord(i: number): void {
    const chapter = this.chapters[i];
    const engine = this.deps.getEngine();
    if (!chapter || chapter.empty || !engine || chapter.needsTranslation) return;
    if (this.deps.recorder.stateOf(chapter.hash) !== null) return;
    void this.deps.cache.delete(chapter.hash).then(() => {
      if (this.destroyed) return;
      chapter.cached = false;
      chapter.duration = null;
      this.deps.onChange();
      this.request(chapter, engine, 'soon').done.then(
        () => {
          if (this.deps.getSettings().showNotices) new Notice(`Recorded again: ${chapter.title}`);
        },
        () => undefined,
      );
    });
  }

  private toggle(i: number, flag: 'pinned' | 'hidden'): void {
    const chapter = this.chapters[i];
    if (!chapter) return;
    chapter[flag] = !chapter[flag];
    if (this.source.notePath) {
      this.deps.saveFlags(this.source.notePath, chapter.key, { pinned: chapter.pinned, hidden: chapter.hidden });
    }
    this.deps.onChange();
  }

  togglePinned(i: number): void {
    this.toggle(i, 'pinned');
  }

  toggleHidden(i: number): void {
    this.toggle(i, 'hidden');
  }

  destroy(): void {
    this.destroyed = true;
    this.removeRecorderListener();
    this.deps.recorder.dropOwner(this);
    for (const cancel of this.cancels) {
      cancel.cancelled = true;
      cancel.onCancel?.();
    }
    this.cancels.clear();
  }
}
