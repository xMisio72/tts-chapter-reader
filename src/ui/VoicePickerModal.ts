import { App, Modal, setIcon } from 'obsidian';
import type TtsChapterReaderPlugin from '../main';
import type { EngineId } from '../modules/settings-data';
import { currentSpeaker, favoritesFirst, isFavorite, setSpeaker, toggleFavorite, voiceOptions } from '../modules/voices';

/**
 * All speakers of a voice in one list: play the same sample sentence with
 * each, star the ones worth keeping, pick one. Starred speakers come first
 * here and in the settings dropdown.
 */
export class VoicePickerModal extends Modal {
  constructor(
    app: App,
    private plugin: TtsChapterReaderPlugin,
    private engine: EngineId,
    private onDone: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Choose a speaker');
    this.modalEl.addClass('tcr-voice-picker');
    this.render();
  }

  onClose(): void {
    this.plugin.audioManager.stopPlayback();
    this.contentEl.empty();
    this.onDone();
  }

  private render(): void {
    const { contentEl } = this;
    const settings = this.plugin.settings;
    contentEl.empty();

    contentEl.createEl('p', {
      cls: 'tcr-muted',
      text: `Play the same sentence with each speaker, star the ones you like, then pick one. Starred speakers are listed first everywhere.${
        this.engine === 'gemini' ? ' Google bills each sample like any other recording.' : ''
      }`,
    });

    const chosen = currentSpeaker(settings, this.engine);
    const list = contentEl.createDiv({ cls: 'tcr-voice-list' });
    for (const option of favoritesFirst(voiceOptions(this.engine), settings.favoriteVoices[this.engine])) {
      const row = list.createDiv({ cls: `tcr-voice-row${option.id === chosen ? ' is-chosen' : ''}` });

      const star = row.createEl('button', { cls: `tcr-voice-star clickable-icon${isFavorite(settings, this.engine, option.id) ? ' is-on' : ''}` });
      setIcon(star, 'star');
      star.setAttribute('aria-label', isFavorite(settings, this.engine, option.id) ? 'Remove from favorites' : 'Add to favorites');
      star.addEventListener('click', () => {
        toggleFavorite(settings, this.engine, option.id);
        void this.plugin.saveSettings();
        this.render();
      });

      const name = row.createEl('button', { cls: 'tcr-voice-name', text: option.label });
      name.setAttribute('aria-label', `Use ${option.label}`);
      name.addEventListener('click', () => {
        setSpeaker(settings, this.engine, option.id);
        void this.plugin.saveSettings();
        this.close();
      });

      const play = row.createEl('button', { cls: 'tcr-voice-play clickable-icon' });
      setIcon(play, 'play');
      play.setAttribute('aria-label', `Hear ${option.label}`);
      play.addEventListener('click', () => {
        void this.plugin.playSample(this.engine, option.id);
      });
    }
  }
}
