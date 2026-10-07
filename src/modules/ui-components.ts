import { Editor, MarkdownFileInfo, MarkdownView, Menu, TAbstractFile, TFile, TFolder, setIcon, setTooltip } from 'obsidian';
import type TtsChapterReaderPlugin from '../main';
import type { AudioPlaybackManager } from './audio-playback';
import type { PluginSettings } from './settings-data';

/**
 * The plugin's entry points in Obsidian's own interface: ribbon icon, status
 * bar button and right-click menu entries.
 */
export class UIManager {
  private statusBarEl: HTMLElement | null = null;

  constructor(
    private plugin: TtsChapterReaderPlugin,
    private settings: PluginSettings,
    private audioManager: AudioPlaybackManager,
  ) {}

  initializeStatusBar(): void {
    if (this.statusBarEl) return;
    this.statusBarEl = this.plugin.addStatusBarItem();
    this.updateStatusBar(this.audioManager.isActive());
  }

  removeStatusBarButton(): void {
    this.statusBarEl?.remove();
    this.statusBarEl = null;
  }

  private statusBarButton(icon: string, tooltip: string, onClick: () => void): void {
    if (!this.statusBarEl) return;
    const button = this.statusBarEl.createSpan({ cls: 'tcr-status-bar-control' });
    setIcon(button, icon);
    setTooltip(button, tooltip, { placement: 'top' });
    button.addEventListener('click', onClick);
  }

  updateStatusBar(withControls = false): void {
    if (!this.statusBarEl) return;
    this.statusBarEl.empty();

    if (withControls) {
      const paused = this.audioManager.isPlaybackPaused();
      this.statusBarButton(paused ? 'circle-play' : 'circle-pause', paused ? 'Resume' : 'Pause', () => {
        if (this.audioManager.isPlaybackPaused()) this.audioManager.resumePlayback();
        else this.audioManager.pausePlayback();
      });
      this.statusBarButton('square', 'Stop', () => this.audioManager.stopPlayback());
    } else {
      this.statusBarButton('audio-lines', 'Read note aloud', () => void this.plugin.readNoteAloud());
    }
  }

  addPluginRibbonIcon(): void {
    this.plugin.addRibbonIcon('audio-lines', 'Read note aloud', () => void this.plugin.readNoteAloud());
  }

  addPluginMenuItems(): void {
    this.plugin.registerEvent(
      this.plugin.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFolder) {
          menu.addItem((item) =>
            item
              .setTitle('Add folder to the reading list')
              .setIcon('list-plus')
              .onClick(() => void this.plugin.addToQueue(this.plugin.notesInFolder(file).map((f) => f.path))),
          );
          return;
        }
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setTitle('Read note aloud')
            .setIcon('audio-lines')
            .onClick(() => void this.plugin.readNoteAloud(undefined, undefined, file.path)),
        );
        menu.addItem((item) =>
          item
            .setTitle('Add to the reading list')
            .setIcon('list-plus')
            .onClick(() => void this.plugin.addToQueue([file.path])),
        );
      }),
    );

    this.plugin.registerEvent(
      this.plugin.app.workspace.on('editor-menu', (menu: Menu, editor: Editor, view: MarkdownView | MarkdownFileInfo) => {
        if (editor.getSelection().trim()) {
          menu.addItem((item) =>
            item
              .setTitle('Read selection aloud')
              .setIcon('audio-lines')
              .onClick(() => void this.plugin.readText(editor.getSelection(), 'Selection')),
          );
        } else {
          menu.addItem((item) =>
            item
              .setTitle('Read note aloud')
              .setIcon('audio-lines')
              .onClick(() => void this.plugin.readNoteAloud(editor, view)),
          );
        }
        menu.addItem((item) =>
          item
            .setTitle('Read aloud from here')
            .setIcon('text-cursor')
            .onClick(() => void this.plugin.readFromCursor(editor)),
        );
      }),
    );
  }

  updateSettings(settings: PluginSettings): void {
    this.settings = settings;
  }
}
