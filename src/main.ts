import { Editor, MarkdownFileInfo, MarkdownView, Notice, Plugin, TFile, TFolder, debounce, normalizePath } from 'obsidian';
import { AudioCache } from './modules/audio-cache';
import { AudioPlaybackManager } from './modules/audio-playback';
import { isBuiltinVoiceInstalled } from './modules/builtin-voice';
import { ChapterSession, LocalChapterSession, TranslationSetup } from './modules/chapters';
import { BuiltinEngine, Engine, GeminiEngine, KokoroServerEngine, OpenAiCompatibleEngine, cpuThreads } from './modules/engines';
import { ModelDownload } from './modules/translation-store';
import { ReadingMarker, editorView, readingMarkerExtension } from './modules/reading-marker';
import { isBuiltinVoice } from './modules/builtin-voice';
import { SAMPLE_TEXT } from './modules/voices';
import type { EngineId } from './modules/settings-data';
import { GeminiTranslator, LocalTranslator, OpenAiTranslator, Translator } from './modules/translators';
import { TranslationModal } from './ui/TranslationModal';
import { FloatingUIManager, UpNext } from './modules/FloatingUIManager';
import type { HelpItem } from './ui/FloatingPlayerUI';
import { JobCancelled } from './modules/tts-worker-client';
import { Recorder } from './modules/recorder';
import { RemoteChapterSession } from './modules/remote-chapters';
import { TtsChapterReaderSettingTab } from './modules/settings';
import { ChapterFlags, PluginSettings, mergeSettings } from './modules/settings-data';
import { TtsWorkerClient } from './modules/tts-worker-client';
import { UIManager } from './modules/ui-components';
import { VoiceDownload } from './modules/voice-download';
import { VoiceSetupModal } from './ui/VoiceSetupModal';
import { filterMarkdown } from './utils';

function formatChapterTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default class TtsChapterReaderPlugin extends Plugin {
  declare settings: PluginSettings;
  audioManager: AudioPlaybackManager;
  uiManager: UIManager;
  floatingUIManager: FloatingUIManager;
  cache: AudioCache;
  voiceDownload = new VoiceDownload();
  modelDownload = new ModelDownload();
  readingMarker = new ReadingMarker();

  private worker = new TtsWorkerClient();
  /** What the session being read overrides: a note's `tts-voice`/`tts-speed`, or the speaker of a sample. */
  private noteOverrides: { builtinVoice?: string; geminiVoice?: string; systemVoice?: string; speed?: number } = {};
  private lastPositionSave = 0;
  /** The note was read to the end and the player is only open for a replay. */
  private readingDone = false;
  /** Bumped by every read request and every stop; a read that finds itself outdated after an await gives up. */
  private readGen = 0;
  /** False once the plugin unloads, so late dialog callbacks do nothing. */
  alive = true;
  private recorder: Recorder;
  private engines: Record<'builtin' | 'openai' | 'gemini' | 'kokoroServer', Engine>;
  private translators: Record<'local' | 'gemini' | 'openai', Translator>;
  private session: ChapterSession | null = null;
  private sessionFile: TFile | null = null;

  async onload() {
    this.settings = mergeSettings((await this.loadData()) as Partial<PluginSettings> | null);

    this.cache = new AudioCache(() => this.settings.cacheLimitMb);
    this.recorder = new Recorder(this.cache);
    const getSettings = () => this.effectiveSettings();
    this.engines = {
      builtin: new BuiltinEngine(this.worker, getSettings),
      openai: new OpenAiCompatibleEngine(this.worker, this.app, getSettings),
      gemini: new GeminiEngine(this.worker, this.app, getSettings),
      kokoroServer: new KokoroServerEngine(this.worker, getSettings),
    };
    this.translators = {
      local: new LocalTranslator(this.worker, cpuThreads),
      gemini: new GeminiTranslator(this.app, getSettings),
      openai: new OpenAiTranslator(this.app, getSettings),
    };

    this.audioManager = new AudioPlaybackManager(this.settings, (withControls) => this.uiManager?.updateStatusBar(withControls));
    this.floatingUIManager = new FloatingUIManager({
      audioManager: this.audioManager,
      savePositionCallback: async (position) => {
        this.settings.floatingPlayerPosition = position;
        await this.saveSettings();
      },
      getSpeed: () => this.audioManager.speed,
      setSpeed: async (speed) => {
        // Moving the slider while a note sets its own speed changes only this session.
        if (this.noteOverrides.speed !== undefined) {
          this.noteOverrides.speed = speed;
          return;
        }
        this.settings.playbackSpeed = speed;
        await this.saveSettings();
      },
      getVolume: () => this.settings.volume,
      setVolume: async (volume) => {
        this.settings.volume = Math.round(volume * 100) / 100;
        if (this.settings.volume > 0) this.settings.lastVolume = this.settings.volume;
        await this.saveSettings();
      },
      // Unmuting returns to the level before the mute, never to full volume.
      mutedVolume: () => (this.settings.volume > 0 ? 0 : this.settings.lastVolume || 0.8),
      getMini: () => this.settings.playerMini,
      setMini: async (mini) => {
        this.settings.playerMini = mini;
        await this.saveSettings();
      },
      getHelp: () => this.helpItems(),
      openHotkeys: () => this.openHotkeySettings(),
    });
    this.audioManager.setFloatingPlayerCallbacks(
      (data) => this.floatingUIManager.showPlayer(data),
      () => this.floatingUIManager.hidePlayer(),
      (data) => this.floatingUIManager.updatePlayerState(data),
    );
    this.audioManager.onStopped = () => this.closeSession();
    this.audioManager.onProgress = (index, time) => this.onProgress(index, time);
    this.audioManager.onFinished = () => {
      this.forgetPosition();
      // Nothing is being read any more: the mark in the note would look like a highlight of the user's own.
      this.readingMarker.clear();
      this.readingDone = true;
      if (this.settings.queue.length === 0) return false;
      void this.playNextInQueue();
      return true;
    };
    this.registerEditorExtension(readingMarkerExtension);
    if (this.settings.floatingPlayerPosition) {
      this.floatingUIManager.setInitialSavedPosition(this.settings.floatingPlayerPosition);
    }

    this.uiManager = new UIManager(this, this.settings, this.audioManager);
    this.addSettingTab(new TtsChapterReaderSettingTab(this.app, this));
    this.uiManager.addPluginRibbonIcon();
    if (this.settings.showStatusBarButton) this.uiManager.initializeStatusBar();
    if (this.settings.showMenuItems) this.uiManager.addPluginMenuItems();

    this.registerCommands();
    this.registerNoteEvents();

    // Ctrl+Alt+click (Cmd+Alt on Mac) on a paragraph reads the note from there.
    this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
      if (!evt.altKey || !(evt.ctrlKey || evt.metaKey)) return;
      if (!(evt.target instanceof HTMLElement) || !evt.target.closest('.cm-content')) return;
      const editor = this.app.workspace.activeEditor?.editor;
      if (!editor) return;
      evt.preventDefault();
      void this.readFromCursor(editor);
    });

    // Asking once makes the operating system hand over its voice list, so it
    // is there by the time the settings page or the first reading needs it.
    window.speechSynthesis?.getVoices();
  }

  private registerCommands(): void {
    this.addCommand({
      id: 'read-note',
      name: 'Read note aloud',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.readNoteAloud();
        return true;
      },
    });

    this.addCommand({
      id: 'read-selection',
      name: 'Read selected text aloud',
      editorCheckCallback: (checking, editor) => {
        if (!editor.getSelection().trim()) return false;
        if (!checking) void this.readText(editor.getSelection(), 'Selection');
        return true;
      },
    });

    this.addCommand({
      id: 'read-from-cursor',
      name: 'Read aloud from here',
      editorCallback: (editor) => void this.readFromCursor(editor),
    });

    this.addCommand({ id: 'stop', name: 'Stop reading', callback: () => this.audioManager.stopPlayback() });

    this.addCommand({
      id: 'pause-resume',
      name: 'Pause or resume reading',
      callback: () => {
        if (this.audioManager.isPlaybackPaused()) this.audioManager.resumePlayback();
        else this.audioManager.pausePlayback();
      },
    });

    this.addCommand({ id: 'next-chapter', name: 'Next chapter', callback: () => this.audioManager.nextPart() });
    this.addCommand({ id: 'previous-chapter', name: 'Previous chapter', callback: () => this.audioManager.previousPart() });
    this.addCommand({ id: 'jump-forward', name: 'Jump forward 10 seconds', callback: () => this.audioManager.jumpForward() });
    this.addCommand({ id: 'jump-backward', name: 'Jump backward 10 seconds', callback: () => this.audioManager.jumpBackward() });

    this.addCommand({
      id: 'show-player',
      name: 'Show the player',
      callback: () => {
        if (!this.floatingUIManager.getIsPlayerVisible()) this.floatingUIManager.showPlayer();
      },
    });

    this.addCommand({
      id: 'reset-player-position',
      name: 'Move the player back to its corner',
      callback: () => this.floatingUIManager.resetPlayerPosition(),
    });

    this.addCommand({
      id: 'toggle-mini-player',
      name: 'Switch between the small and the full player',
      callback: () => {
        this.settings.playerMini = !this.settings.playerMini;
        void this.saveSettings().then(() => this.pushChapterUI());
      },
    });

    this.addCommand({
      id: 'copy-spoken-text',
      name: 'Copy the spoken text of the note being read',
      checkCallback: (checking) => {
        if (!this.session) return false;
        if (!checking) void this.copySpokenText();
        return true;
      },
    });

    this.addCommand({
      id: 'queue-add-note',
      name: 'Add this note to the reading list',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.addToQueue([file.path]);
        return true;
      },
    });

    this.addCommand({
      id: 'queue-add-links',
      name: 'Add the notes this note links to to the reading list',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.addToQueue(this.linkedNotes(file).map((f) => f.path));
        return true;
      },
    });

    this.addCommand({
      id: 'read-links',
      name: 'Read the notes this note links to, one after another',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.readList(this.linkedNotes(file).map((f) => f.path));
        return true;
      },
    });

    this.addCommand({
      id: 'queue-read',
      name: 'Read the reading list',
      checkCallback: (checking) => {
        if (this.settings.queue.length === 0) return false;
        if (!checking) void this.playNextInQueue();
        return true;
      },
    });

    this.addCommand({
      id: 'queue-clear',
      name: 'Clear the reading list',
      checkCallback: (checking) => {
        if (this.settings.queue.length === 0) return false;
        if (!checking) void this.clearQueue();
        return true;
      },
    });

    this.addCommand({
      id: 'export-mp3',
      name: 'Export this note as an MP3 file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) void this.exportMp3(file);
        return true;
      },
    });
  }

  // ------------------------------------------------------------ reading list

  /** The notes a note links to, in the order of the links (each once). */
  linkedNotes(file: TFile): TFile[] {
    const cache = this.app.metadataCache.getFileCache(file);
    const refs = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].sort((a, b) => a.position.start.offset - b.position.start.offset);
    const seen = new Set<string>();
    const out: TFile[] = [];
    for (const ref of refs) {
      const target = this.app.metadataCache.getFirstLinkpathDest(ref.link.split('#')[0], file.path);
      if (target && target.extension === 'md' && target.path !== file.path && !seen.has(target.path)) {
        seen.add(target.path);
        out.push(target);
      }
    }
    return out;
  }

  /** The notes in a folder and its subfolders, by path. */
  notesInFolder(folder: TFolder): TFile[] {
    const out: TFile[] = [];
    const walk = (f: TFolder) => {
      for (const child of f.children) {
        if (child instanceof TFolder) walk(child);
        else if (child instanceof TFile && child.extension === 'md') out.push(child);
      }
    };
    walk(folder);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  async addToQueue(paths: string[]): Promise<void> {
    const fresh = paths.filter((p) => !this.settings.queue.includes(p) && p !== this.sessionFile?.path);
    if (fresh.length === 0) {
      if (this.settings.showNotices) new Notice('Already on the reading list.');
      return;
    }
    this.settings.queue.push(...fresh);
    await this.saveSettings();
    this.pushChapterUI();
    if (this.settings.showNotices) {
      const n = this.settings.queue.length;
      new Notice(`${fresh.length === 1 ? 'Added' : `${fresh.length} notes added`} to the reading list (${n} ${n === 1 ? 'note' : 'notes'}). ${this.session ? 'It goes on when this note ends.' : 'Start it with "Read the reading list".'}`);
    }
  }

  /** Replace the list with these notes and start reading them. */
  async readList(paths: string[]): Promise<void> {
    if (paths.length === 0) {
      if (this.settings.showNotices) new Notice('This note links to no other notes.');
      return;
    }
    this.settings.queue = [...paths];
    await this.saveSettings();
    await this.playNextInQueue();
  }

  async clearQueue(): Promise<void> {
    this.settings.queue = [];
    await this.saveSettings();
    this.pushChapterUI();
  }

  /** Start the next note on the list that can be read; notes that cannot (gone, empty) are skipped with a notice. */
  private async playNextInQueue(): Promise<boolean> {
    while (this.settings.queue.length > 0) {
      const path = this.settings.queue[0];
      const file = this.app.vault.getFileByPath(path);
      const started = file ? await this.readNoteAloud(undefined, undefined, file.path) : false;
      // A read that was superseded (another read or Stop) must not eat the entry.
      if (!started && this.session) return false;
      this.settings.queue.shift();
      await this.saveSettings();
      if (started) {
        this.pushChapterUI();
        return true;
      }
      if (this.settings.showNotices) new Notice(`Skipped on the reading list: ${file ? file.basename : path} (nothing to read).`);
    }
    if (this.settings.showNotices) new Notice('The reading list is finished.');
    return false;
  }

  private upNext(): UpNext | undefined {
    const next = this.settings.queue.find((p) => this.app.vault.getFileByPath(p));
    if (!next) return undefined;
    return {
      title: this.app.vault.getFileByPath(next)?.basename ?? next,
      more: this.settings.queue.length - 1,
      onClear: () => void this.clearQueue(),
    };
  }

  // ------------------------------------------------------------ export

  /** Record every chapter of a note and save them as one MP3 beside it. */
  private async exportMp3(file: TFile): Promise<void> {
    const session = this.localSession({
      notePath: file.path,
      title: file.basename,
      getMarkdown: () => this.app.vault.cachedRead(file),
    });
    if (!(await session.load())) {
      session.destroy();
      new Notice('There is nothing to read in this note.');
      return;
    }
    const notice = new Notice('Export: recording…', 0);
    try {
      const pieces = await session.recordAll((done, total) => notice.setMessage(`Export: ${done} of ${total} chapters recorded`));
      const total = pieces.reduce((n, p) => n + p.byteLength, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const piece of pieces) {
        joined.set(new Uint8Array(piece), offset);
        offset += piece.byteLength;
      }
      // Never overwrite: an existing file of that name may be the user's own recording.
      const folder = file.parent?.path && file.parent.path !== '/' ? `${file.parent.path}/` : '';
      let target = normalizePath(`${folder}${file.basename}.mp3`);
      for (let n = 2; this.app.vault.getAbstractFileByPath(target); n++) target = normalizePath(`${folder}${file.basename} (${n}).mp3`);
      await this.app.vault.createBinary(target, joined.buffer);
      notice.setMessage(`Saved ${target} (${Math.round(total / 1024 / 1024 * 10) / 10} MB).`);
      window.setTimeout(() => notice.hide(), 6000);
    } catch (e) {
      notice.hide();
      if (!(e instanceof JobCancelled)) new Notice(`Export failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
    } finally {
      session.destroy();
    }
  }

  // ------------------------------------------------------------ help card

  /** The plugin's commands with their hotkeys, for the player's help card. */
  private helpItems(): HelpItem[] {
    interface HotkeyManager { printHotkeyForCommand?(id: string): string }
    interface CommandManager { commands: Record<string, { id: string; name: string }> }
    const app = this.app as unknown as { hotkeyManager?: HotkeyManager; commands?: CommandManager };
    const prefix = `${this.manifest.id}:`;
    const commands = Object.values(app.commands?.commands ?? {}).filter((c) => c.id.startsWith(prefix));
    return commands.map((c) => ({
      name: c.name.replace(/^TTS Chapter Reader: /, ''),
      keys: app.hotkeyManager?.printHotkeyForCommand?.(c.id) ?? '',
    }));
  }

  /** Obsidian's hotkey settings, filtered to this plugin. */
  private openHotkeySettings(): void {
    interface HotkeysTab { setQuery?(query: string): void }
    interface SettingManager { open(): void; openTabById(id: string): HotkeysTab | null }
    const setting = (this.app as unknown as { setting?: SettingManager }).setting;
    if (!setting) return;
    setting.open();
    setting.openTabById('hotkeys')?.setQuery?.(this.manifest.name);
  }

  private async copySpokenText(): Promise<void> {
    const text = this.session?.spokenText();
    if (!text) return;
    await navigator.clipboard.writeText(text);
    if (this.settings.showNotices) new Notice('The spoken text was copied.');
  }

  /** Keep the chapter list in step with the note while it is being read. */
  private registerNoteEvents(): void {
    const refresh = debounce(() => void this.session?.refresh(), 800, true);

    this.registerEvent(
      this.app.vault.on('modify', (file) => {
        if (this.sessionFile && file.path === this.sessionFile.path) refresh();
      }),
    );

    // The favorite/hidden marks are stored by note path, so they move with it.
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        // Marks, resume points and the reading list all follow the note.
        let changed = false;
        const flags = this.settings.chapterFlags[oldPath];
        if (flags) {
          delete this.settings.chapterFlags[oldPath];
          this.settings.chapterFlags[file.path] = flags;
          changed = true;
        }
        const position = this.settings.positions[oldPath];
        if (position) {
          delete this.settings.positions[oldPath];
          this.settings.positions[file.path] = position;
          changed = true;
        }
        const at = this.settings.queue.indexOf(oldPath);
        if (at >= 0) {
          this.settings.queue[at] = file.path;
          changed = true;
        }
        if (changed) void this.saveSettings();
        if (this.sessionFile?.path === oldPath && file instanceof TFile) {
          this.sessionFile = file;
          this.session?.renamed?.(file.path, file.basename);
          this.pushChapterUI();
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        if (!this.settings.chapterFlags[file.path]) return;
        delete this.settings.chapterFlags[file.path];
        void this.saveSettings();
      }),
    );
  }

  // ------------------------------------------------------------ voice

  /** The engine that records audio, or null when the system voice is chosen. */
  private currentEngine(): Engine | null {
    return this.settings.engine === 'system' ? null : this.engines[this.settings.engine];
  }

  /** The settings with the session's speaker overrides laid over them (a note's `tts-voice`, or a sample). */
  private effectiveSettings(): PluginSettings {
    const o = this.noteOverrides;
    if (!o.builtinVoice && !o.geminiVoice) return this.settings;
    return {
      ...this.settings,
      builtinVoice: o.builtinVoice ?? this.settings.builtinVoice,
      gemini: o.geminiVoice ? { ...this.settings.gemini, voice: o.geminiVoice } : this.settings.gemini,
    };
  }

  /** Read the sample sentence, with the chosen speaker or with one to try out. */
  async playSample(engine?: EngineId, speaker?: string): Promise<void> {
    this.audioManager.stopPlayback();
    const overrides: typeof this.noteOverrides = {};
    if (engine === 'builtin' && speaker !== undefined) overrides.builtinVoice = speaker;
    if (engine === 'gemini' && speaker !== undefined) overrides.geminiVoice = speaker;
    if (engine === 'system' && speaker !== undefined) overrides.systemVoice = speaker;
    await this.readText(SAMPLE_TEXT, 'Voice sample', overrides);
  }

  /** Read `tts-voice` and `tts-speed` from a note's properties. */
  private overridesFor(file: TFile): { builtinVoice?: string; speed?: number } {
    // Properties are untyped; read them as unknown values.
    const raw: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const fm = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
    const out: { builtinVoice?: string; speed?: number } = {};
    const voice = fm?.['tts-voice'];
    if (typeof voice === 'string' && isBuiltinVoice(voice.trim())) out.builtinVoice = voice.trim();
    const speed = Number(fm?.['tts-speed']);
    if (Number.isFinite(speed) && speed >= 0.5 && speed <= 3) out.speed = Math.round(speed * 10) / 10;
    return out;
  }

  // ------------------------------------------------------------ following the reading

  private onProgress(index: number, time: number): void {
    const session = this.session;
    if (!session) return;
    if (this.readingDone) {
      // A replay starts the chapter over; anything else after the end is not reading.
      if (!this.audioManager.isPlaybackPaused() && time < 1) this.readingDone = false;
      else return;
    }
    if (this.settings.followReading && this.sessionFile) this.markReading(session, index, time);
    this.rememberPosition(session, index, time);
  }

  private markReading(session: ChapterSession, index: number, time: number): void {
    const lines = session.positionLines(index, time);
    if (!lines) return;
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== this.sessionFile?.path) {
      this.readingMarker.clear();
      return;
    }
    const cm = editorView(view.editor);
    if (cm) this.readingMarker.show(cm, lines[0], lines[1]);
  }

  /** Keep where the listener is, a few times a minute, so the note can go on from there next time. */
  private rememberPosition(session: ChapterSession, index: number, time: number): void {
    if (!session.notePath) return;
    const now = Date.now();
    if (now - this.lastPositionSave < 5000) return;
    this.lastPositionSave = now;
    const key = session.chapters[index]?.key;
    if (!key) return;
    const positions = this.settings.positions;
    positions[session.notePath] = { key, time: Math.floor(time), when: now };
    // Keep the list short: the 200 most recent notes.
    const paths = Object.keys(positions);
    if (paths.length > 200) {
      paths.sort((a, b) => positions[a].when - positions[b].when);
      for (const path of paths.slice(0, paths.length - 200)) delete positions[path];
    }
    void this.saveSettings();
  }

  /** The note was read to the end: next time it starts from the top. */
  private forgetPosition(): void {
    const path = this.session?.notePath;
    if (path && this.settings.positions[path]) {
      delete this.settings.positions[path];
      void this.saveSettings();
    }
  }

  /** Where this note was left: chapter index and seconds, or null to start from the top. */
  private resumePoint(session: ChapterSession): { index: number; time: number } | null {
    const path = session.notePath;
    const saved = path ? this.settings.positions[path] : undefined;
    if (!saved) return null;
    const index = session.chapters.findIndex((c) => c.key === saved.key);
    if (index < 0) return null;
    if (index === 0 && saved.time < 10) return null;
    return { index, time: saved.time };
  }

  /**
   * First use: ask which voice to use. Returns true when reading can start
   * now; otherwise the dialog starts it once the user has chosen.
   */
  private async voiceReady(thenRead: () => void): Promise<boolean> {
    if (this.settings.engine !== 'builtin') return true;
    if (await isBuiltinVoiceInstalled()) return true;
    new VoiceSetupModal(this.app, this, thenRead).open();
    return false;
  }

  /** Free the built-in voice (after its files or its settings changed). */
  releaseVoiceEngine(): void {
    this.recorder.dropAll();
    this.worker.dispose();
  }

  /** Free the translation model (after its files were removed). */
  releaseTranslator(): void {
    this.worker.unloadTranslator();
  }

  /** A setting that changes what a recording sounds like was switched: re-check the open note's chapters. */
  async refreshSession(): Promise<void> {
    await this.session?.refresh();
  }

  /** Withdraw queued and running recordings (the voice changed under them). */
  dropRecordings(): void {
    this.recorder.dropAll();
  }

  // ------------------------------------------------------------ translation

  /** Whether the voice in use wants English text, and how to get it. */
  private currentTranslation(): TranslationSetup {
    const t = this.settings.translation;
    const wanted = t.voices[this.settings.engine];
    return { wanted, translator: wanted && t.mode !== 'off' ? this.translators[t.mode] : null };
  }

  /**
   * A note in another language with a voice that wants English: make sure
   * the plugin can translate it, or that the user said to read it as it is.
   * Returns true when reading can go on now; otherwise the dialog restarts it.
   */
  private async translationReady(session: ChapterSession, thenRead: () => void): Promise<boolean> {
    const { wanted, translator } = this.currentTranslation();
    if (!wanted) return true;
    // Every language in the note, not only the first: a German note with a French chapter needs both models.
    for (const lang of session.foreignLanguages()) {
      if (this.settings.translation.readAsIs.includes(lang)) continue;
      if (translator && (await translator.ready(lang))) continue;
      if (!this.alive) return false;
      new TranslationModal(this.app, this, lang, thenRead).open();
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------ reading

  private clean = (markdown: string): string =>
    filterMarkdown(markdown, this.settings.textFiltering, this.settings.symbolReplacement);

  /** Resolves true when reading started. */
  async readNoteAloud(editor?: Editor, view?: MarkdownView | MarkdownFileInfo, filePath?: string, startLine?: number): Promise<boolean> {
    const file = filePath ? this.app.vault.getFileByPath(filePath) : this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      if (this.settings.showNotices) new Notice('Open a note to read it aloud.');
      return false;
    }

    // With text selected in the note, "read aloud" means the selection.
    // Selecting everything (Ctrl+A) means the note, so favorites still apply.
    const activeEditor = editor ?? (filePath ? undefined : this.app.workspace.activeEditor?.editor);
    const selection = startLine === undefined ? activeEditor?.getSelection() ?? '' : '';
    // In Live Preview the properties block is not selectable, so Ctrl+A leaves the frontmatter out.
    const value = activeEditor?.getValue() ?? '';
    const body = value.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const wholeNote = selection.trim() === value.trim() || selection.trim() === body.trim();
    if (selection.trim() && !wholeNote) {
      await this.readText(selection, 'Selection');
      return this.session !== null;
    }

    if (!(await this.voiceReady(() => void this.readNoteAloud(undefined, undefined, file.path, startLine)))) return false;

    this.audioManager.stopPlayback();
    const gen = ++this.readGen;
    const outdated = () => gen !== this.readGen || !this.alive;

    if (this.settings.personalOptions && this.settings.externalChapters.enabled) {
      const remote = new RemoteChapterSession(() => this.settings, file.path, this.audioManager, () => this.pushChapterUI());
      try {
        if (await remote.load()) {
          if (outdated()) return false;
          return this.openSession(remote, file);
        }
      } catch {
        // Chapter server down or note outside its vault: read it locally.
      }
      if (outdated()) return false;
    }

    // The note's own voice and speed apply before anything is hashed.
    this.noteOverrides = this.overridesFor(file);
    const session = this.localSession({
      notePath: file.path,
      title: file.basename,
      // The editor has the latest text, saved or not.
      getMarkdown: async () => {
        const openEditor = this.app.workspace.getActiveFile()?.path === file.path ? this.app.workspace.activeEditor?.editor : undefined;
        return openEditor ? openEditor.getValue() : this.app.vault.cachedRead(file);
      },
    });
    const loaded = await session.load();
    if (outdated()) {
      session.destroy();
      return false;
    }
    if (!loaded) {
      session.destroy();
      this.noteOverrides = {};
      if (this.settings.showNotices) new Notice('There is nothing to read in this note.');
      return false;
    }
    const ready = await this.translationReady(session, () => void this.readNoteAloud(undefined, undefined, file.path));
    if (!ready || outdated()) {
      session.destroy();
      if (!ready) this.noteOverrides = {};
      return false;
    }
    if (startLine !== undefined) {
      // From a paragraph: its chapter, and into it as far as the recording allows.
      const at = session.locate(startLine);
      return this.openSession(session, file, at ? { index: at.index, time: at.time ?? 0 } : null);
    }
    const resume = this.resumePoint(session);
    const started = this.openSession(session, file, resume);
    if (started && resume && this.settings.showNotices) {
      new Notice(`Continuing at chapter ${resume.index + 1}, ${formatChapterTime(resume.time)}. Use the chapter list to start over.`);
    }
    return started;
  }

  /** Read the note from the paragraph under the cursor (chapters and all). */
  async readFromCursor(editor: Editor): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (file && file.extension === 'md') {
      await this.readNoteAloud(undefined, undefined, file.path, editor.getCursor().line);
      return;
    }
    const lastLine = editor.lastLine();
    const text = editor.getRange(editor.getCursor(), { line: lastLine, ch: editor.getLine(lastLine).length });
    await this.readText(text, 'From cursor');
  }

  /** Read loose text (a selection, a sample): chapters at its headings, but no favorite/hidden marks. */
  async readText(text: string, title: string, overrides: typeof this.noteOverrides = {}): Promise<void> {
    if (!text.trim()) {
      if (this.settings.showNotices) new Notice('There is no text to read.');
      return;
    }
    if (!(await this.voiceReady(() => void this.readText(text, title, overrides)))) return;

    this.audioManager.stopPlayback();
    const gen = ++this.readGen;
    this.noteOverrides = overrides;
    const session = this.localSession({ notePath: null, title, getMarkdown: async () => text });
    const loaded = await session.load();
    if (gen !== this.readGen || !this.alive) {
      session.destroy();
      return;
    }
    if (!loaded) {
      session.destroy();
      this.noteOverrides = {};
      if (this.settings.showNotices) new Notice('There is nothing left to read after the text filters.');
      return;
    }
    const ready = await this.translationReady(session, () => void this.readText(text, title, overrides));
    if (!ready || gen !== this.readGen || !this.alive) {
      session.destroy();
      if (!ready) this.noteOverrides = {};
      return;
    }
    this.openSession(session, null);
  }

  private localSession(source: ConstructorParameters<typeof LocalChapterSession>[1]): LocalChapterSession {
    return new LocalChapterSession(
      {
        // With the note's own speaker laid over, so hashes and recordings agree.
        getSettings: () => this.effectiveSettings(),
        getEngine: () => this.currentEngine(),
        getTranslation: () => this.currentTranslation(),
        audioManager: this.audioManager,
        recorder: this.recorder,
        cache: this.cache,
        clean: this.clean,
        saveFlags: (notePath, key, flags) => this.saveChapterFlags(notePath, key, flags),
        onChange: () => this.pushChapterUI(),
      },
      source,
    );
  }

  /** False when nothing could play (every chapter hidden, or favorites only with none); the list is shown so it can be undone. */
  private openSession(session: ChapterSession, file: TFile | null, at: { index: number; time: number } | null = null): boolean {
    this.session?.destroy();
    this.session = session;
    this.sessionFile = file;
    this.lastPositionSave = 0;
    this.readingDone = false;
    this.audioManager.setPlaybackSpeed(this.noteOverrides.speed ?? this.settings.playbackSpeed);
    this.audioManager.systemVoiceOverride = this.noteOverrides.systemVoice ?? null;
    this.pushChapterUI();
    const started = at ? session.start(at.index, at.time) : session.start();
    if (!started) {
      new Notice(
        session.favoritesOnly
          ? 'No favorite chapter is left to play. Open the chapter list to star one or turn "favorites only" off.'
          : 'Every chapter of this note is hidden. Open the chapter list and unhide one.',
        8000,
      );
      this.floatingUIManager.showPlayer();
    }
    return started;
  }

  private closeSession(): void {
    this.readGen++;
    this.session?.destroy();
    this.session = null;
    this.sessionFile = null;
    this.noteOverrides = {};
    this.readingMarker.clear();
    this.floatingUIManager.setChapterData(null);
  }

  private saveChapterFlags(notePath: string, key: string, flags: ChapterFlags): void {
    const note = (this.settings.chapterFlags[notePath] ??= {});
    if (flags.pinned || flags.hidden) note[key] = flags;
    else delete note[key];
    if (Object.keys(note).length === 0) delete this.settings.chapterFlags[notePath];
    void this.saveSettings();
  }

  private pushChapterUI(): void {
    const session = this.session;
    if (!session || !session.showList) {
      this.floatingUIManager.setChapterData(null);
      return;
    }
    const notePath = session.notePath;
    this.floatingUIManager.setChapterData({
      title: session.title,
      onOpenNote: notePath
        ? () => {
            const file = this.app.vault.getFileByPath(notePath);
            if (file) void this.app.workspace.getLeaf().openFile(file);
          }
        : undefined,
      favoritesOnly: session.favoritesOnly,
      onToggleFavoritesOnly:
        session.canFlag && session.chapters.some((c) => c.pinned)
          ? () => {
              session.setFavoritesOnly(!session.favoritesOnly);
              this.settings.favoritesOnly = session.favoritesOnly;
              void this.saveSettings();
            }
          : undefined,
      onCopyText: () => void this.copySpokenText(),
      upNext: this.upNext(),
      canRecord: session.canRecord,
      rows: session.chapters.map((c) => ({
        i: c.i,
        title: c.title,
        level: c.level,
        durationLabel: c.empty ? '' : c.duration !== null ? formatChapterTime(c.duration) : `~${formatChapterTime(c.estSec)}`,
        cached: c.cached,
        empty: c.empty,
        pinned: c.pinned,
        hidden: c.hidden,
        recording: c.recording,
        translated: c.translated,
        translating: c.translating,
        isCurrent: session.currentIndex === c.i,
      })),
      onPick: (i) => session.play(i),
      onTogglePin: session.canFlag ? (i) => session.togglePinned(i) : undefined,
      onToggleHide: session.canFlag ? (i) => session.toggleHidden(i) : undefined,
      onRerecord: (i) => void session.rerecord(i),
    });
  }

  // ------------------------------------------------------------ settings

  /** data.json was changed from outside (a sync service, for example). */
  async onExternalSettingsChange() {
    this.settings = mergeSettings((await this.loadData()) as Partial<PluginSettings> | null);
    this.audioManager.updateSettings(this.settings);
    this.uiManager.updateSettings(this.settings);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.audioManager.updateSettings(this.settings);
    this.uiManager.updateSettings(this.settings);
  }

  onunload() {
    this.alive = false;
    this.audioManager.stopPlayback();
    this.closeSession();
    this.recorder.dropAll();
    this.worker.dispose();
    this.voiceDownload.cancel();
    this.modelDownload.cancel();
    this.uiManager.removeStatusBarButton();
    this.floatingUIManager.destroy();
  }
}
