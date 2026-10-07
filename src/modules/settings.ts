import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type { SettingDefinitionItem } from 'obsidian';
import type TtsChapterReaderPlugin from '../main';
import { COMPARISON_SYMBOL_TRANSLATIONS } from '../lib/translations';
import { detectUserLanguage } from '../utils';
import {
  downloadBytes,
  formatMb,
  isBuiltinVoiceInstalled,
  removeBuiltinVoice,
} from './builtin-voice';
import { languageName } from './language';
import { favoritesFirst, voiceOptions } from './voices';
import { clearTranslations } from './translators';
import { VoicePickerModal } from '../ui/VoicePickerModal';
import { DEFAULT_SETTINGS } from './settings-data';
import type { EngineId, PluginSettings, RecordAhead, TextFilterSettings, TranslationMode } from './settings-data';
import { TRANSLATION_MODELS } from './translation-models';
import { installedModels, modelBytes, removeModel } from './translation-store';
import type { TranslationModel } from './translation-models';

const TRANSLATION_MODE_LABELS: Record<TranslationMode, string> = {
  off: 'Off',
  local: 'On this computer (one download per language)',
  gemini: 'Google Gemini (own API key)',
  openai: 'OpenAI or compatible server (own API key)',
};

const TRANSLATION_VOICE_LABELS: Record<EngineId, string> = {
  builtin: 'Natural voice',
  system: 'System voice',
  openai: 'Own server or OpenAI voice',
  gemini: 'Google Gemini voice',
  kokoroServer: 'Kokoro server voice',
};

const ENGINE_LABELS: Record<EngineId, string> = {
  builtin: 'Natural voice (runs on this computer)',
  system: 'System voice',
  openai: 'Own server or OpenAI (OpenAI-compatible)',
  gemini: 'Google Gemini (own API key)',
  kokoroServer: 'Kokoro server (document reader)',
};

const ENGINE_NOTES: Record<EngineId, string> = {
  builtin: 'Sounds human, works offline and costs nothing. English only.',
  system: 'The voice built into your computer. Works at once and in any language it speaks, but nothing is recorded: no seeking, no saved chapters.',
  openai: 'Any server with the OpenAI speech API: one you run yourself (for example Kokoro-FastAPI) or OpenAI with your own API key.',
  gemini: 'Google\'s voices in over 100 languages, with your own API key. Google bills you for what you record.',
  kokoroServer: 'Your own Kokoro server with the document-reader protocol.',
};

/** Ready-made values for the OpenAI-compatible engine. */
const OPENAI_PRESETS: Record<string, { label: string; baseUrl: string; model: string; voice: string }> = {
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy' },
  kokoroFastApi: { label: 'Kokoro-FastAPI on this computer', baseUrl: 'http://localhost:8880/v1', model: 'kokoro', voice: 'af_heart' },
};


const RECORD_AHEAD_LABELS: Record<RecordAhead, string> = {
  auto: 'Automatic',
  all: 'The whole note',
  next: 'Only the next chapter',
  off: 'Nothing',
};

const CACHE_LIMITS_MB = [250, 500, 1000, 2000, 5000];

const TEXT_FILTERS: { key: keyof TextFilterSettings; name: string; desc: string }[] = [
  { key: 'filterFrontmatter', name: 'Skip properties', desc: 'Leave out the properties (YAML) at the top of a note.' },
  { key: 'filterCodeBlocks', name: 'Skip code blocks', desc: 'Leave out fenced code blocks.' },
  { key: 'filterTables', name: 'Skip tables', desc: 'Leave out Markdown tables.' },
  { key: 'filterImages', name: 'Skip images', desc: 'Leave out images and embedded files.' },
  { key: 'filterMarkdownLinks', name: 'Skip links entirely', desc: 'Off: the link text is read and the address is dropped. On: the whole link is left out, [[note links]] too.' },
  { key: 'filterFootnotes', name: 'Skip footnotes', desc: 'Leave out footnote markers and footnote text.' },
  { key: 'filterComments', name: 'Skip comments', desc: 'Leave out HTML comments and %% Obsidian comments %%.' },
  { key: 'filterMathExpressions', name: 'Skip math', desc: 'Leave out LaTeX formulas.' },
  { key: 'filterCallouts', name: 'Clean up callouts', desc: 'Read the text of a callout without its [!type] marker.' },
  { key: 'filterInlineCode', name: 'Clean up inline code', desc: 'Read inline code as plain words.' },
  { key: 'filterHighlights', name: 'Clean up highlights', desc: 'Read highlighted text without the == markers.' },
  { key: 'filterHtmlTags', name: 'Clean up HTML', desc: 'Read the text inside HTML tags, not the tags.' },
  { key: 'replaceComparisonSymbols', name: 'Say comparison symbols', desc: 'Read < and > as "less than" and "greater than".' },
];

export class TtsChapterReaderSettingTab extends PluginSettingTab {
  private unsubscribeDownload: (() => void) | null = null;
  /** Bumped on every redraw, so an older async redraw can tell it is stale. */
  private drawId = 0;

  constructor(app: App, private plugin: TtsChapterReaderPlugin) {
    super(app, plugin);
  }

  private get settings(): PluginSettings {
    return this.plugin.settings;
  }

  private async save(): Promise<void> {
    await this.plugin.saveSettings();
    // A note being read re-checks its chapters against the new settings (hashes, translation, filters).
    await this.plugin.refreshSession();
  }

  /** The voice or speaker changed: queued recordings would mix old and new, so they are dropped. */
  private async voiceChanged(): Promise<void> {
    this.plugin.dropRecordings();
    await this.save();
  }

  hide(): void {
    this.unsubscribeDownload?.();
    this.unsubscribeDownload = null;
  }

  /**
   * Obsidian 1.13+ renders `getSettingDefinitions()` itself and never calls
   * `display()`; its `update()` re-renders. Older versions have neither, so
   * the method is looked up rather than called directly.
   */
  private declarativeUpdate(): boolean {
    const update = (this as { update?: () => void }).update;
    if (typeof update !== 'function') return false;
    update.call(this);
    return true;
  }

  /** Redraw after something changed that the page shows (a download finished, files were removed). */
  private redraw(): void {
    if (!this.declarativeUpdate()) this.display();
  }

  // ------------------------------------------------------------ declarative (Obsidian 1.13+)

  /**
   * The settings as definitions: simple controls declared (so they show up in
   * Obsidian's settings search), the richer parts rendered by the same code
   * as the fallback below.
   */
  getSettingDefinitions(): SettingDefinitionItem[] {
    const s = this.settings;
    const engineOptions: Record<string, string> = {};
    for (const id of ['builtin', 'system', 'openai', 'gemini', ...(s.personalOptions ? ['kokoroServer'] : [])] as EngineId[]) {
      engineOptions[id] = ENGINE_LABELS[id];
    }
    const cacheOptions: Record<string, string> = {};
    for (const mb of CACHE_LIMITS_MB) cacheOptions[String(mb)] = mb >= 1000 ? `Up to ${mb / 1000} GB` : `Up to ${mb} MB`;
    const symbolLanguages: Record<string, string> = {
      auto: 'Same as Obsidian', en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano',
      pt: 'Português', ru: 'Русский', ja: '日本語', ko: '한국어', zh: '中文',
    };

    const items: SettingDefinitionItem[] = [
      {
        type: 'group',
        heading: 'Voice',
        items: [
          { name: 'Voice', desc: 'Which voice reads your notes. Each one is explained below.', control: { type: 'dropdown', key: 'engine', options: engineOptions } },
          {
            name: 'Voice settings',
            aliases: ['download', 'speaker', 'API key', 'server address', 'natural voice', 'system voice', 'Gemini', 'OpenAI', 'Kokoro', 'graphics card', 'processor'],
            render: (setting) => this.embed(setting, async (host) => this.drawEngineBlock(host, await isBuiltinVoiceInstalled()), [this.plugin.voiceDownload]),
          },
          { name: 'Try the voice', desc: 'Reads one sentence with the settings above.', action: () => this.playSample() },
        ],
      },
      {
        type: 'group',
        heading: 'Other languages',
        items: [
          {
            name: 'Translate notes into English before reading',
            desc: 'The natural voice speaks English only. With this on, a chapter written in another language is translated once and the English text is read. Translated chapters show "EN" in the player.',
            control: { type: 'dropdown', key: 'translation.mode', options: { ...TRANSLATION_MODE_LABELS } },
          },
          {
            name: 'Translation settings',
            aliases: ['translation files', 'German', 'French', 'Spanish', 'Gemini model', 'translate for these voices', 'languages read as they are'],
            visible: () => this.settings.translation.mode !== 'off' || this.settings.translation.readAsIs.length > 0,
            render: (setting) => this.embed(setting, async (host) => this.drawTranslationDetails(host, await installedModels()), [this.plugin.modelDownload]),
          },
          {
            name: 'Delete saved translations',
            desc: 'Translated chapter text is kept on this computer so a chapter is translated once. Delete it here; chapters are translated again when played.',
            action: () => void this.deleteTranslations(),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Chapters',
        items: [
          { name: 'Read headings aloud', desc: 'Say each heading before its text, like a chapter title in an audiobook.', control: { type: 'toggle', key: 'readHeadings' } },
          {
            name: 'Record ahead',
            desc: 'What is recorded in the background while you listen, so the next chapters start without a wait. Automatic records the whole note with a free voice, and only the next chapter with a voice that is billed.',
            control: { type: 'dropdown', key: 'recordAhead', options: { ...RECORD_AHEAD_LABELS } },
          },
          {
            name: 'Saved recordings',
            desc: 'Stored on this computer, outside your vault. When the limit is reached, the recordings you have not played for the longest time are removed.',
            control: { type: 'dropdown', key: 'cacheLimitMb', options: cacheOptions },
          },
          {
            name: 'Delete all saved recordings',
            aliases: ['cache', 'clear'],
            render: (setting) => this.embed(setting, async (host) => this.drawCacheRow(host, await this.plugin.cache.stats())),
          },
        ],
      },
      {
        type: 'group',
        heading: 'Player',
        items: [
          { name: 'Speed', desc: 'From 0.5x to 3x.', control: { type: 'slider', key: 'playbackSpeed', min: 0.5, max: 3, step: 0.1, displayFormat: (v) => `${v.toFixed(1)}x` } },
          { name: 'Follow the reading in the note', desc: 'Marks the paragraph being read and keeps it in view while the note is open in an editor.', control: { type: 'toggle', key: 'followReading' } },
          {
            name: 'Pause at the start of each chapter',
            desc: 'A short silence (0.7 s) before the first words of every chapter, which makes them easier to catch at higher speeds. Recordings with and without the pause are both kept; a chapter is recorded again the first time it plays after switching.',
            control: { type: 'toggle', key: 'pauseAtChapterStart' },
          },
          { name: 'Show notices', desc: 'Short messages such as "Finished reading".', control: { type: 'toggle', key: 'showNotices' } },
          { name: 'Button in the status bar', desc: 'A play button at the bottom of the window.', control: { type: 'toggle', key: 'showStatusBarButton' } },
          { name: 'Entries in the right-click menus', desc: 'Read note, read selection, read from cursor. Takes effect after a restart.', control: { type: 'toggle', key: 'showMenuItems' } },
          { name: 'Keep the player open at the end', desc: 'So the last chapter can be replayed.', control: { type: 'toggle', key: 'enableReplayOption' } },
          { name: 'Floating player', desc: 'The small window with the controls and the chapter list. Turn it off to control playback with commands only.', control: { type: 'toggle', key: 'floatingPlayer' } },
        ],
      },
      {
        type: 'group',
        heading: 'What is read aloud',
        items: [
          ...TEXT_FILTERS.map((filter) => ({ name: filter.name, desc: filter.desc, control: { type: 'toggle' as const, key: `textFiltering.${filter.key}` } })),
          { name: 'Language for comparison symbols', desc: this.symbolPreview(), control: { type: 'dropdown', key: 'symbolReplacement.language', options: symbolLanguages } },
        ],
      },
    ];

    if (s.personalOptions) {
      items.push({
        type: 'group',
        heading: 'Own chapter server',
        items: [
          {
            name: 'Use the chapter server',
            desc: 'Chapters and their audio come from the chapter server instead of being recorded by this plugin. Falls back to the voice above when the server does not answer.',
            control: { type: 'toggle', key: 'externalChapters.enabled' },
          },
          { name: 'Chapter server address', control: { type: 'text', key: 'externalChapters.vaultApiUrl', placeholder: DEFAULT_SETTINGS.externalChapters.vaultApiUrl } },
          {
            name: 'Knowledge Tracker address',
            desc: 'Stores favorite and hidden marks, shared with the Daily Priming player. Leave empty to keep them out of Knowledge Tracker.',
            control: { type: 'text', key: 'externalChapters.ktApiUrl' },
          },
        ],
      });
    }
    return items;
  }

  /** Read a setting by its (dotted) key for the declarative controls. */
  getControlValue(key: string): unknown {
    if (key === 'floatingPlayer') return !this.settings.disablePlaybackControlPopover;
    const value = this.lookup(key);
    return key === 'cacheLimitMb' ? String(value) : value;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    const s = this.settings;
    switch (key) {
      case 'floatingPlayer':
        s.disablePlaybackControlPopover = !value;
        break;
      case 'cacheLimitMb':
        s.cacheLimitMb = Number(value);
        break;
      case 'playbackSpeed':
        s.playbackSpeed = Math.round(Number(value) * 10) / 10;
        this.plugin.audioManager.setPlaybackSpeed(s.playbackSpeed);
        break;
      case 'engine':
        s.engine = value as EngineId;
        s.voiceChosen = true;
        break;
      default:
        this.assign(key, value);
    }
    if (key === 'engine' || key === 'builtinVoice' || key === 'systemVoice' || key.startsWith('openai.') || key.startsWith('gemini.')) this.plugin.dropRecordings();
    await this.save();
    if (key === 'showStatusBarButton') {
      if (value) this.plugin.uiManager.initializeStatusBar();
      else this.plugin.uiManager.removeStatusBarButton();
    }
    if (key === 'followReading' && !value) this.plugin.readingMarker.clear();
    if (key === 'pauseAtChapterStart') await this.plugin.refreshSession();
    // The engine and the translation mode decide which blocks are shown.
    if (key === 'engine' || key === 'translation.mode' || key === 'symbolReplacement.language') this.declarativeUpdate();
  }

  private lookup(key: string): unknown {
    let node: unknown = this.settings;
    for (const part of key.split('.')) {
      if (!node || typeof node !== 'object') return undefined;
      node = (node as Record<string, unknown>)[part];
    }
    return node;
  }

  private assign(key: string, value: unknown): void {
    const parts = key.split('.');
    let node: Record<string, unknown> = this.settings as unknown as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) node = node[part] as Record<string, unknown>;
    const last = parts[parts.length - 1];
    node[last] = typeof value === 'string' && typeof node[last] === 'string' ? value.trim() : value;
  }

  /**
   * A definition row drawn by the plugin's own code: the row becomes a
   * container, `draw` fills it (after loading what it needs), and it is drawn
   * again whenever one of the `watch`ed downloads reports progress.
   */
  private embed(setting: Setting, draw: (host: HTMLElement) => Promise<void> | void, watch: { subscribe(listener: () => void): () => void }[] = []): () => void {
    const host = setting.settingEl;
    host.empty();
    host.addClass('tcr-embed');
    let alive = true;
    let pass = 0;
    const run = async () => {
      const mine = ++pass;
      const fresh = createDiv();
      await draw(fresh);
      if (!alive || mine !== pass) return;
      host.empty();
      host.appendChild(fresh);
    };
    const unsubscribe = watch.map((w) => w.subscribe(() => void run()));
    void run();
    return () => {
      alive = false;
      for (const u of unsubscribe) u();
    };
  }

  private playSample(): void {
    void this.plugin.playSample();
  }

  // ------------------------------------------------------------ fallback (Obsidian before 1.13)

  display(): void {
    if (!this.unsubscribeDownload) {
      const a = this.plugin.voiceDownload.subscribe(() => this.display());
      const b = this.plugin.modelDownload.subscribe(() => this.display());
      this.unsubscribeDownload = () => {
        a();
        b();
      };
    }
    void this.draw();
  }

  private async draw(): Promise<void> {
    const drawId = ++this.drawId;
    // Read everything that needs waiting before touching the page, so the
    // page is rebuilt in one go and never shows a half-drawn state.
    const installed = await isBuiltinVoiceInstalled();
    const cacheStats = await this.plugin.cache.stats();
    const models = await installedModels();
    if (drawId !== this.drawId) return;

    const { containerEl } = this;
    containerEl.empty();

    this.drawVoice(containerEl, installed);
    this.drawTranslation(containerEl, models);
    this.drawChapters(containerEl, cacheStats);
    this.drawPlayer(containerEl);
    this.drawTextFilters(containerEl);
    if (this.settings.personalOptions) this.drawPersonal(containerEl);
  }

  // ------------------------------------------------------------ voice

  private drawVoice(containerEl: HTMLElement, installed: boolean): void {
    const engine = this.settings.engine;

    new Setting(containerEl)
      .setName('Voice')
      .setDesc(ENGINE_NOTES[engine])
      .addDropdown((dropdown) => {
        const ids: EngineId[] = ['builtin', 'system', 'openai', 'gemini'];
        if (this.settings.personalOptions) ids.push('kokoroServer');
        for (const id of ids) dropdown.addOption(id, ENGINE_LABELS[id]);
        dropdown.setValue(engine).onChange(async (value) => {
          this.settings.engine = value as EngineId;
          this.settings.voiceChosen = true;
          await this.voiceChanged();
          this.redraw();
        });
      });

    this.drawEngineBlock(containerEl, installed);

    new Setting(containerEl)
      .setName('Try the voice')
      .setDesc('Reads one sentence with the settings above.')
      .addButton((button) => button.setButtonText('Play a sample').onClick(() => this.playSample()));
  }

  /** The settings of the chosen voice (download, speaker, keys, addresses). */
  private drawEngineBlock(containerEl: HTMLElement, installed: boolean): void {
    const engine = this.settings.engine;
    if (engine === 'builtin') this.drawBuiltin(containerEl, installed);
    if (engine === 'system') this.drawSystem(containerEl);
    if (engine === 'openai') this.drawOpenAi(containerEl);
    if (engine === 'gemini') this.drawGemini(containerEl);
    if (engine === 'kokoroServer') this.drawKokoroServer(containerEl);
  }

  private drawBuiltin(containerEl: HTMLElement, installed: boolean): void {
    const download = this.plugin.voiceDownload;

    const status = new Setting(containerEl).setName('Voice files');
    if (download.running) {
      status.setDesc(`Downloading: ${formatMb(download.received)} of ${formatMb(download.total)}`);
      status.addProgressBar((bar) => bar.setValue(download.percent));
      status.addButton((button) => button.setButtonText('Cancel').onClick(() => download.cancel()));
    } else if (installed) {
      status.setDesc('Downloaded and ready. Stored on this computer, outside your vault.');
      status.addButton((button) =>
        button.setButtonText('Remove').onClick(async () => {
          this.plugin.releaseVoiceEngine();
          await removeBuiltinVoice();
          new Notice('The natural voice was removed from this computer.');
          this.redraw();
        }),
      );
    } else {
      status.setDesc(
        `${download.error ? `The last download did not finish: ${download.error} ` : ''}Not downloaded yet. One-time download of ${formatMb(downloadBytes())}, then it works offline.`,
      );
      status.addButton((button) =>
        button
          .setButtonText('Download')
          .setCta()
          .onClick(async () => {
            const ok = await download.start(this.settings.builtinVoice);
            if (ok) {
              this.settings.voiceChosen = true;
              await this.save();
              new Notice('The natural voice is ready.');
            }
          }),
      );
    }

    new Setting(containerEl)
      .setName('Speaker')
      .setDesc('Recordings made with another speaker are kept, so switching back costs nothing. The button next to it plays each speaker and lets you star favorites.')
      .addDropdown((dropdown) => {
        this.speakerOptions('builtin', dropdown);
        dropdown.setValue(this.settings.builtinVoice).onChange(async (value) => {
          this.settings.builtinVoice = value;
          await this.voiceChanged();
        });
      })
      .addButton((button) => button.setButtonText('Choose').onClick(() => this.openPicker('builtin')));

    new Setting(containerEl)
      .setName('Run on')
      .setDesc('Automatic uses the graphics card when there is one, which is several times faster than the processor.')
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', 'Automatic');
        dropdown.addOption('gpu', 'Graphics card');
        dropdown.addOption('cpu', 'Processor');
        dropdown.setValue(this.settings.builtinDevice).onChange(async (value) => {
          this.settings.builtinDevice = value as PluginSettings['builtinDevice'];
          this.plugin.releaseVoiceEngine();
          await this.save();
        });
      });
  }

  private drawSystem(containerEl: HTMLElement): void {
    const voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : [];
    const setting = new Setting(containerEl).setName('Speaker');
    if (voices.length === 0) {
      // The list arrives a moment after it is first asked for; redraw then.
      window.speechSynthesis?.addEventListener('voiceschanged', () => this.redraw(), { once: true });
      setting.setDesc('This device reports no system voices. Pick another voice above.');
      return;
    }
    setting
      .setDesc('The voices installed on this computer. The button next to it plays each one and lets you star favorites.')
      .addDropdown((dropdown) => {
        this.speakerOptions('system', dropdown);
        dropdown.setValue(this.settings.systemVoice).onChange(async (value) => {
          this.settings.systemVoice = value;
          await this.save();
        });
      })
      .addButton((button) => button.setButtonText('Choose').onClick(() => this.openPicker('system')));
  }

  /** Fill a speaker dropdown, starred speakers first and marked. */
  private speakerOptions(engine: EngineId, dropdown: { addOption(value: string, label: string): unknown }): void {
    const favorites = this.settings.favoriteVoices[engine];
    for (const option of favoritesFirst(voiceOptions(engine), favorites)) {
      dropdown.addOption(option.id, favorites.includes(option.id) ? `★ ${option.label}` : option.label);
    }
  }

  private openPicker(engine: EngineId): void {
    new VoicePickerModal(this.app, this.plugin, engine, () => this.redraw()).open();
  }

  private drawOpenAi(containerEl: HTMLElement): void {
    const s = this.settings.openai;

    new Setting(containerEl)
      .setName('Quick setup')
      .setDesc('Fills in the fields below for a common setup.')
      .addDropdown((dropdown) => {
        dropdown.addOption('', 'Choose…');
        for (const [id, preset] of Object.entries(OPENAI_PRESETS)) dropdown.addOption(id, preset.label);
        dropdown.onChange(async (value) => {
          const preset = OPENAI_PRESETS[value];
          if (!preset) return;
          s.baseUrl = preset.baseUrl;
          s.model = preset.model;
          s.voice = preset.voice;
          await this.save();
          this.redraw();
        });
      });

    new Setting(containerEl)
      .setName('Server address')
      .setDesc('The address up to and including /v1.')
      .addText((text) =>
        text
          .setPlaceholder(OPENAI_PRESETS.openai.baseUrl)
          .setValue(s.baseUrl)
          .onChange(async (value) => {
            s.baseUrl = value.trim();
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName('API key')
      .setDesc('Kept in Obsidian\'s secret storage, not in this plugin\'s settings file. A server on your own computer usually needs none.')
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s.keyName).onChange(async (value) => {
          s.keyName = value;
          await this.save();
        }),
      );

    new Setting(containerEl).setName('Model').addText((text) =>
      text.setValue(s.model).onChange(async (value) => {
        s.model = value.trim();
        await this.save();
      }),
    );

    new Setting(containerEl)
      .setName('Speaker')
      .setDesc('The voice name as the server knows it, for example alloy (OpenAI) or af_heart (Kokoro).')
      .addText((text) =>
        text.setValue(s.voice).onChange(async (value) => {
          s.voice = value.trim();
          await this.save();
        }),
      );
  }

  private drawGemini(containerEl: HTMLElement): void {
    const s = this.settings.gemini;

    new Setting(containerEl)
      .setName('API key')
      .setDesc('Your key from Google AI Studio. Kept in Obsidian\'s secret storage, not in this plugin\'s settings file.')
      .addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s.keyName).onChange(async (value) => {
          s.keyName = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Speaker')
      .setDesc('The button next to it plays each speaker and lets you star favorites. Google bills the samples.')
      .addDropdown((dropdown) => {
        this.speakerOptions('gemini', dropdown);
        dropdown.setValue(s.voice).onChange(async (value) => {
          s.voice = value;
          await this.voiceChanged();
        });
      })
      .addButton((button) => button.setButtonText('Choose').onClick(() => this.openPicker('gemini')));

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Change this only if Google renames its speech models.')
      .addText((text) =>
        text.setValue(s.model).onChange(async (value) => {
          s.model = value.trim();
          await this.save();
        }),
      );
  }

  private drawKokoroServer(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Server address').addText((text) =>
      text
        .setPlaceholder(DEFAULT_SETTINGS.kokoroServerUrl)
        .setValue(this.settings.kokoroServerUrl)
        .onChange(async (value) => {
          this.settings.kokoroServerUrl = value.trim();
          await this.save();
        }),
    );
    new Setting(containerEl).setName('Speaker').addText((text) =>
      text.setValue(this.settings.kokoroServerVoice).onChange(async (value) => {
        this.settings.kokoroServerVoice = value.trim();
        await this.save();
      }),
    );
  }

  // ------------------------------------------------------------ chapters

  // ------------------------------------------------------------ other languages

  private drawTranslation(containerEl: HTMLElement, models: TranslationModel[]): void {
    const t = this.settings.translation;
    new Setting(containerEl).setName('Other languages').setHeading();

    new Setting(containerEl)
      .setName('Translate notes into English before reading')
      .setDesc(
        'The natural voice speaks English only. With this on, a chapter written in another language is translated once and the English text is read. Translated chapters show "EN" in the player.',
      )
      .addDropdown((dropdown) => {
        for (const mode of Object.keys(TRANSLATION_MODE_LABELS) as TranslationMode[]) {
          dropdown.addOption(mode, TRANSLATION_MODE_LABELS[mode]);
        }
        dropdown.setValue(t.mode).onChange(async (value) => {
          t.mode = value as TranslationMode;
          await this.save();
          this.redraw();
        });
      });

    this.drawTranslationDetails(containerEl, models);
  }

  /** Everything under the translation mode: voices, models or keys, languages read as they are. */
  private drawTranslationDetails(containerEl: HTMLElement, models: TranslationModel[]): void {
    const t = this.settings.translation;
    if (t.mode === 'off') {
      if (t.readAsIs.length > 0) this.drawReadAsIs(containerEl);
      return;
    }

    const voices = (Object.keys(TRANSLATION_VOICE_LABELS) as EngineId[]).filter(
      (id) => id !== 'kokoroServer' || this.settings.personalOptions,
    );
    new Setting(containerEl)
      .setName('Translate for these voices')
      .setDesc('Voices that speak many languages can read the original instead.')
      .setHeading();
    for (const id of voices) {
      new Setting(containerEl).setName(TRANSLATION_VOICE_LABELS[id]).addToggle((toggle) =>
        toggle.setValue(t.voices[id]).onChange(async (value) => {
          t.voices[id] = value;
          await this.save();
        }),
      );
    }

    if (t.mode === 'local') this.drawLocalModels(containerEl, models);
    if (t.mode === 'gemini') {
      new Setting(containerEl)
        .setName('Gemini API key')
        .setDesc('The same key the Gemini voice uses. Kept in Obsidian\'s secret storage. Google bills the translated text.')
        .addComponent((el) =>
          new SecretComponent(this.app, el).setValue(this.settings.gemini.keyName).onChange(async (value) => {
            this.settings.gemini.keyName = value;
            await this.save();
          }),
        );
      new Setting(containerEl)
        .setName('Gemini model')
        .setDesc('Change this only if Google renames its models.')
        .addText((text) =>
          text.setValue(t.geminiModel).onChange(async (value) => {
            t.geminiModel = value.trim() || DEFAULT_SETTINGS.translation.geminiModel;
            await this.save();
          }),
        );
    }
    if (t.mode === 'openai') {
      new Setting(containerEl)
        .setName('Server address')
        .setDesc('OpenAI, or any server with the OpenAI chat API (for example a local model server).')
        .addText((text) =>
          text.setValue(t.openai.baseUrl).onChange(async (value) => {
            t.openai.baseUrl = value.trim();
            await this.save();
          }),
        );
      new Setting(containerEl).setName('Model').addText((text) =>
        text.setValue(t.openai.model).onChange(async (value) => {
          t.openai.model = value.trim() || DEFAULT_SETTINGS.translation.openai.model;
          await this.save();
        }),
      );
      new Setting(containerEl)
        .setName('API key')
        .setDesc('Leave empty to use the key of the OpenAI voice. Stored in Obsidian\'s secret storage, not in the vault.')
        .addComponent((el) =>
          new SecretComponent(this.app, el).setValue(t.openai.keyName).onChange(async (value) => {
            t.openai.keyName = value;
            await this.save();
          }),
        );
    }

    if (t.readAsIs.length > 0) this.drawReadAsIs(containerEl);
  }

  private drawLocalModels(containerEl: HTMLElement, models: TranslationModel[]): void {
    const download = this.plugin.modelDownload;
    const status = new Setting(containerEl).setName('Translation files');

    if (download.running) {
      status.setDesc(`Downloading ${download.running.name} → English: ${formatMb(download.received)} of ${formatMb(download.total)}`);
      status.addProgressBar((bar) => bar.setValue(download.percent));
      status.addButton((button) => button.setButtonText('Cancel').onClick(() => download.cancel()));
      return;
    }

    const have = models.map((m) => `${m.name} → English (${formatMb(modelBytes(m))})`);
    status.setDesc(
      `${download.error ? `The last download did not finish: ${download.error} ` : ''}${
        have.length > 0 ? `Downloaded: ${have.join(', ')}.` : 'Nothing downloaded yet.'
      } A language is offered for download the first time a note in it is read; you can also fetch one here ahead of time.`,
    );

    let picked = TRANSLATION_MODELS.find((m) => !models.includes(m))?.lang ?? '';
    status.addDropdown((dropdown) => {
      for (const model of TRANSLATION_MODELS) {
        if (!models.includes(model)) dropdown.addOption(model.lang, `${model.name} → English (${formatMb(modelBytes(model))})`);
      }
      dropdown.setValue(picked).onChange((value) => {
        picked = value;
      });
    });
    status.addButton((button) =>
      button.setButtonText('Download').onClick(async () => {
        const model = TRANSLATION_MODELS.find((m) => m.lang === picked);
        if (!model) return;
        const ok = await download.start(model);
        if (ok) new Notice(`${model.name} → English is ready.`);
      }),
    );

    for (const model of models) {
      new Setting(containerEl)
        .setName(`${model.name} → English`)
        .setDesc(`${formatMb(modelBytes(model))}, stored on this computer outside your vault.`)
        .addButton((button) =>
          button.setButtonText('Remove').onClick(async () => {
            this.plugin.releaseTranslator();
            await removeModel(model);
            new Notice(`${model.name} → English was removed.`);
            this.redraw();
          }),
        );
    }
  }

  private async deleteTranslations(): Promise<void> {
    await clearTranslations();
    new Notice('All saved translations were deleted.');
    await this.plugin.refreshSession();
  }

  private drawReadAsIs(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Delete saved translations')
      .setDesc('Translated chapter text is kept on this computer so a chapter is translated once. Chapters are translated again when played.')
      .addButton((button) => button.setButtonText('Delete all').onClick(() => void this.deleteTranslations()));
    const t = this.settings.translation;
    new Setting(containerEl)
      .setName('Languages read as they are')
      .setDesc(`You chose to hear these without translation: ${t.readAsIs.map(languageName).join(', ')}.`)
      .addButton((button) =>
        button.setButtonText('Ask again').onClick(async () => {
          t.readAsIs = [];
          await this.save();
          this.redraw();
        }),
      );
  }

  private drawChapters(containerEl: HTMLElement, cacheStats: { count: number; bytes: number }): void {
    new Setting(containerEl).setName('Chapters').setHeading();

    new Setting(containerEl)
      .setName('Read headings aloud')
      .setDesc('Say each heading before its text, like a chapter title in an audiobook.')
      .addToggle((toggle) =>
        toggle.setValue(this.settings.readHeadings).onChange(async (value) => {
          this.settings.readHeadings = value;
          await this.save();
        }),
      );

    new Setting(containerEl)
      .setName('Record ahead')
      .setDesc('What is recorded in the background while you listen, so the next chapters start without a wait. Automatic records the whole note with a free voice, and only the next chapter with a voice that is billed.')
      .addDropdown((dropdown) => {
        for (const [value, label] of Object.entries(RECORD_AHEAD_LABELS)) dropdown.addOption(value, label);
        dropdown.setValue(this.settings.recordAhead).onChange(async (value) => {
          this.settings.recordAhead = value as RecordAhead;
          await this.save();
        });
      });

    new Setting(containerEl)
      .setName('Saved recordings')
      .setDesc('Stored on this computer, outside your vault. When the limit is reached, the recordings you have not played for the longest time are removed.')
      .addDropdown((dropdown) => {
        for (const mb of CACHE_LIMITS_MB) dropdown.addOption(String(mb), mb >= 1000 ? `Up to ${mb / 1000} GB` : `Up to ${mb} MB`);
        dropdown.setValue(String(this.settings.cacheLimitMb)).onChange(async (value) => {
          this.settings.cacheLimitMb = Number(value);
          await this.save();
        });
      });

    this.drawCacheRow(containerEl, cacheStats);
  }

  private drawCacheRow(containerEl: HTMLElement, cacheStats: { count: number; bytes: number }): void {
    new Setting(containerEl)
      .setName('Delete all saved recordings')
      .setDesc(`${cacheStats.count} ${cacheStats.count === 1 ? 'chapter' : 'chapters'}, ${formatMb(cacheStats.bytes)} at the moment.`)
      .addButton((button) =>
        button.setButtonText('Delete all').onClick(async () => {
          await this.plugin.cache.clear();
          new Notice('All saved recordings were deleted.');
          this.redraw();
        }),
      );
  }

  // ------------------------------------------------------------ player

  private drawPlayer(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Player').setHeading();

    const speedNote = (speed: number) => `Now ${speed.toFixed(1)}x. From 0.5x to 3x.`;
    const speed = new Setting(containerEl).setName('Speed').setDesc(speedNote(this.settings.playbackSpeed));
    speed.addSlider((slider) =>
      slider
        .setLimits(0.5, 3.0, 0.1)
        .setValue(this.settings.playbackSpeed)
        .onChange(async (value) => {
          this.settings.playbackSpeed = Math.round(value * 10) / 10;
          speed.setDesc(speedNote(this.settings.playbackSpeed));
          this.plugin.audioManager.setPlaybackSpeed(this.settings.playbackSpeed);
          await this.save();
        }),
    );

    new Setting(containerEl)
      .setName('Follow the reading in the note')
      .setDesc('Marks the paragraph being read and keeps it in view while the note is open in an editor.')
      .addToggle((toggle) =>
        toggle.setValue(this.settings.followReading).onChange(async (value) => {
          this.settings.followReading = value;
          await this.save();
          if (!value) this.plugin.readingMarker.clear();
        }),
      );

    new Setting(containerEl)
      .setName('Pause at the start of each chapter')
      .setDesc(
        'A short silence (0.7 s) before the first words of every chapter, which makes them easier to catch at higher speeds. Recordings with and without the pause are both kept; a chapter is recorded again the first time it plays after switching.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.settings.pauseAtChapterStart).onChange(async (value) => {
          this.settings.pauseAtChapterStart = value;
          await this.save();
          await this.plugin.refreshSession();
        }),
      );

    const toggles: { key: 'showNotices' | 'showStatusBarButton' | 'showMenuItems' | 'enableReplayOption'; name: string; desc: string }[] = [
      { key: 'showNotices', name: 'Show notices', desc: 'Short messages such as "Finished reading".' },
      { key: 'showStatusBarButton', name: 'Button in the status bar', desc: 'A play button at the bottom of the window.' },
      { key: 'showMenuItems', name: 'Entries in the right-click menus', desc: 'Read note, read selection, read from cursor. Takes effect after a restart.' },
      { key: 'enableReplayOption', name: 'Keep the player open at the end', desc: 'So the last chapter can be replayed.' },
    ];
    for (const item of toggles) {
      new Setting(containerEl)
        .setName(item.name)
        .setDesc(item.desc)
        .addToggle((toggle) =>
          toggle.setValue(this.settings[item.key]).onChange(async (value) => {
            this.settings[item.key] = value;
            await this.save();
            if (item.key === 'showStatusBarButton') {
              if (value) this.plugin.uiManager.initializeStatusBar();
              else this.plugin.uiManager.removeStatusBarButton();
            }
          }),
        );
    }

    new Setting(containerEl)
      .setName('Floating player')
      .setDesc('The small window with the controls and the chapter list. Turn it off to control playback with commands only.')
      .addToggle((toggle) =>
        toggle.setValue(!this.settings.disablePlaybackControlPopover).onChange(async (value) => {
          this.settings.disablePlaybackControlPopover = !value;
          await this.save();
        }),
      );
  }

  // ------------------------------------------------------------ what is read

  private drawTextFilters(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('What is read aloud').setHeading();

    const details = containerEl.createEl('details', { cls: 'tcr-details' });
    details.createEl('summary', { text: 'Choose what to skip and what to clean up' });

    for (const filter of TEXT_FILTERS) {
      new Setting(details)
        .setName(filter.name)
        .setDesc(filter.desc)
        .addToggle((toggle) =>
          toggle.setValue(this.settings.textFiltering[filter.key]).onChange(async (value) => {
            this.settings.textFiltering[filter.key] = value;
            await this.save();
          }),
        );
    }

    const symbols = this.settings.symbolReplacement;
    new Setting(details)
      .setName('Language for comparison symbols')
      .setDesc(this.symbolPreview())
      .addDropdown((dropdown) => {
        dropdown.addOption('auto', 'Same as Obsidian');
        const names: Record<string, string> = {
          en: 'English', es: 'Español', fr: 'Français', de: 'Deutsch', it: 'Italiano',
          pt: 'Português', ru: 'Русский', ja: '日本語', ko: '한국어', zh: '中文',
        };
        for (const [code, name] of Object.entries(names)) dropdown.addOption(code, name);
        dropdown.setValue(symbols.language).onChange(async (value) => {
          symbols.language = value;
          await this.save();
          this.redraw();
        });
      });
  }

  private symbolPreview(): string {
    const symbols = this.settings.symbolReplacement;
    const language = symbols.language === 'auto' ? detectUserLanguage() : symbols.language;
    const words = COMPARISON_SYMBOL_TRANSLATIONS[language as keyof typeof COMPARISON_SYMBOL_TRANSLATIONS] || COMPARISON_SYMBOL_TRANSLATIONS.en;
    return `> is read as "${words.greaterThan.trim()}", < as "${words.lessThan.trim()}".`;
  }

  // ------------------------------------------------------------ personal

  private drawPersonal(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Own chapter server').setHeading();
    const external = this.settings.externalChapters;

    new Setting(containerEl)
      .setName('Use the chapter server')
      .setDesc('Chapters and their audio come from the chapter server instead of being recorded by this plugin. Falls back to the voice above when the server does not answer.')
      .addToggle((toggle) =>
        toggle.setValue(external.enabled).onChange(async (value) => {
          external.enabled = value;
          await this.save();
        }),
      );

    new Setting(containerEl).setName('Chapter server address').addText((text) =>
      text
        .setPlaceholder(DEFAULT_SETTINGS.externalChapters.vaultApiUrl)
        .setValue(external.vaultApiUrl)
        .onChange(async (value) => {
          external.vaultApiUrl = value.trim();
          await this.save();
        }),
    );

    new Setting(containerEl)
      .setName('Knowledge Tracker address')
      .setDesc('Stores favorite and hidden marks, shared with the Daily Priming player. Leave empty to keep them out of Knowledge Tracker.')
      .addText((text) =>
        text.setValue(external.ktApiUrl).onChange(async (value) => {
          external.ktApiUrl = value.trim();
          await this.save();
        }),
      );
  }
}
