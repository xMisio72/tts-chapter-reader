import { App, Modal, ProgressBarComponent, Setting } from 'obsidian';
import type TtsChapterReaderPlugin from '../main';
import { downloadBytes, formatMb } from '../modules/builtin-voice';

/**
 * Shown the first time something is read aloud: one question, two answers.
 * Whichever is picked, the reading that was asked for starts right after.
 */
export class VoiceSetupModal extends Modal {
  private unsubscribe: (() => void) | null = null;
  private finished = false;

  constructor(app: App, private plugin: TtsChapterReaderPlugin, private onReady: () => void) {
    super(app);
  }

  onOpen(): void {
    this.setTitle('Choose a voice');
    this.unsubscribe = this.plugin.voiceDownload.subscribe(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    const download = this.plugin.voiceDownload;
    contentEl.empty();

    if (download.running) {
      contentEl.createEl('p', {
        text: `Downloading the natural voice: ${formatMb(download.received)} of ${formatMb(download.total)}`,
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

    new Setting(contentEl)
      .setName('Natural voice (recommended)')
      .setDesc(
        `Sounds human. Runs on this computer: free, private, no account. English. One-time download of ${formatMb(downloadBytes())}.`,
      )
      .addButton((button) =>
        button
          .setButtonText('Download')
          .setCta()
          .onClick(() => void this.downloadNaturalVoice()),
      );

    new Setting(contentEl)
      .setName('System voice')
      .setDesc('Works right now with the voice built into your computer, in any language it speaks. Sounds more robotic.')
      .addButton((button) => button.setButtonText('Use system voice').onClick(() => void this.useSystemVoice()));

    contentEl.createEl('p', {
      cls: 'tcr-muted',
      text: 'You can change this at any time in the plugin settings. There you can also connect your own voice server or a Google Gemini API key.',
    });
  }

  private async downloadNaturalVoice(): Promise<void> {
    const ok = await this.plugin.voiceDownload.start(this.plugin.settings.builtinVoice);
    if (!ok || this.finished) return;
    this.plugin.settings.engine = 'builtin';
    await this.finish();
  }

  private async useSystemVoice(): Promise<void> {
    this.plugin.settings.engine = 'system';
    await this.finish();
  }

  private async finish(): Promise<void> {
    this.finished = true;
    if (!this.plugin.alive) return;
    this.plugin.settings.voiceChosen = true;
    await this.plugin.saveSettings();
    this.close();
    this.onReady();
  }
}
