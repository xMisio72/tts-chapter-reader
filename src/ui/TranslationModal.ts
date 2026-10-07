import { App, Modal, ProgressBarComponent, Setting } from 'obsidian';
import type TtsChapterReaderPlugin from '../main';
import { formatMb } from '../modules/builtin-voice';
import { languageName } from '../modules/language';
import { modelBytes, modelForLanguage } from '../modules/translation-store';

/**
 * Shown when a note is in a language the voice does not speak: translate it
 * (one download per language) or hear it as it is. Whichever is picked, the
 * reading that was asked for starts right after.
 */
export class TranslationModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private finished = false;

  constructor(
    app: App,
    private plugin: TtsChapterReaderPlugin,
    private lang: string,
    private onReady: () => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`This note is in ${languageName(this.lang)}`);
    this.unsubscribe = this.plugin.modelDownload.subscribe(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    const download = this.plugin.modelDownload;
    const model = modelForLanguage(this.lang);
    contentEl.empty();

    if (download.running) {
      contentEl.createEl('p', {
        text: `Downloading the ${download.running.name} → English translation: ${formatMb(download.received)} of ${formatMb(download.total)}`,
      });
      new ProgressBarComponent(contentEl.createDiv({ cls: 'tcr-download-bar' })).setValue(download.percent);
      contentEl.createEl('p', {
        cls: 'tcr-muted',
        text: 'Reading starts by itself when this is done. You can close this window; the download continues.',
      });
      new Setting(contentEl).addButton((button) => button.setButtonText('Cancel download').onClick(() => download.cancel()));
      return;
    }

    if (download.error) {
      contentEl.createEl('p', { cls: 'tcr-error', text: `The download did not finish: ${download.error}` });
    }

    contentEl.createEl('p', {
      text:
        this.plugin.settings.engine === 'builtin'
          ? 'The natural voice speaks English only.'
          : 'Translation into English is switched on for the voice you use.',
    });

    const modelName = model.lang === 'mul' ? `${languageName(this.lang)} (many-languages model)` : model.name;
    new Setting(contentEl)
      .setName('Translate to English (recommended)')
      .setDesc(
        `Translation runs on this computer: free, private, offline. One-time download of ${formatMb(modelBytes(model))} for ${modelName}. Translated chapters are marked "EN" in the player.`,
      )
      .addButton((button) =>
        button
          .setButtonText('Download')
          .setCta()
          .onClick(() => void this.translate()),
      );

    new Setting(contentEl)
      .setName('Read it as it is')
      .setDesc(`The voice reads the ${languageName(this.lang)} text with an English accent. The plugin will not ask again for this language.`)
      .addButton((button) => button.setButtonText('Read as is').onClick(() => void this.readAsIs()));

    contentEl.createEl('p', {
      cls: 'tcr-muted',
      text: 'In the plugin settings you can translate with Google Gemini or an OpenAI-compatible service instead, and change this choice at any time.',
    });
  }

  private async translate(): Promise<void> {
    const model = modelForLanguage(this.lang);
    const ok = await this.plugin.modelDownload.start(model);
    if (!ok || this.finished) return;
    const t = this.plugin.settings.translation;
    if (t.mode === 'off') t.mode = 'local';
    t.readAsIs = t.readAsIs.filter((l) => l !== this.lang);
    await this.finish();
  }

  private async readAsIs(): Promise<void> {
    const t = this.plugin.settings.translation;
    if (!t.readAsIs.includes(this.lang)) t.readAsIs.push(this.lang);
    await this.finish();
  }

  private async finish(): Promise<void> {
    this.finished = true;
    if (!this.plugin.alive) return;
    await this.plugin.saveSettings();
    this.close();
    this.onReady();
  }
}
