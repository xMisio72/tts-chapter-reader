import { createElement } from 'preact';
import { createRoot } from 'preact/compat/client';
import { FloatingPlayerUI, ChapterRowData, HelpItem } from '../ui/FloatingPlayerUI';
import type { AudioPlaybackManager, PlaybackState } from './audio-playback';

/**
 * Owns the floating player: one React root in a host element on the body,
 * fed with the playback state, the chapter list and the plugin's callbacks.
 * Remembers where the user dragged it and keeps it on screen when the
 * window shrinks.
 */

export interface ChapterUIData {
  title: string;
  /** Missing for loose text (nothing to open). */
  onOpenNote?: () => void;
  rows: ChapterRowData[];
  canRecord: boolean;
  onPick: (i: number) => void;
  /** Missing when marks cannot be remembered (loose text, no note). */
  onTogglePin?: (i: number) => void;
  onToggleHide?: (i: number) => void;
  onRerecord: (i: number) => void;
  favoritesOnly: boolean;
  /** Missing when the note has no favorite chapters. */
  onToggleFavoritesOnly?: () => void;
  onCopyText: () => void;
  /** The reading list, when it holds more notes. */
  upNext?: UpNext;
}

export interface UpNext {
  title: string;
  /** How many more notes wait after that one. */
  more: number;
  onClear: () => void;
}

interface FloatingUIManagerOptions {
  audioManager: AudioPlaybackManager;
  savePositionCallback: (position: { x: number; y: number }) => Promise<void>;
  getSpeed: () => number;
  setSpeed: (speed: number) => Promise<void>;
  getMini: () => boolean;
  setMini: (mini: boolean) => Promise<void>;
  getVolume: () => number;
  setVolume: (volume: number) => Promise<void>;
  /** The volume to switch to when the speaker icon is clicked (0, or the level before the mute). */
  mutedVolume: () => number;
  getHelp: () => HelpItem[];
  openHotkeys: () => void;
}

type Point = { x: number; y: number };

const IDLE: PlaybackState = { currentTime: 0, duration: 0, isPlaying: false, isLoading: false };
/** Distance from the window's right and bottom edge for the default spot. */
const MARGIN = 20;
/** Size assumed before the player has been drawn once. */
const GUESS = { width: 300, height: 420 };

export class FloatingUIManager {
  private host: HTMLElement | null = null;
  private root: ReturnType<typeof createRoot> | null = null;
  private visible = false;
  private state: PlaybackState = IDLE;
  private chapterUI: ChapterUIData | null = null;
  private spot: Point | null = null;
  private resizeFrame: number | null = null;

  constructor(private options: FloatingUIManagerOptions) {
    window.addEventListener('resize', this.onResize);
  }

  // ------------------------------------------------------------ position

  /** Bottom-right corner, with the player's real size once it has been drawn. */
  private defaultSpot(): Point {
    const box = this.host?.querySelector('.tcr-player')?.getBoundingClientRect();
    const width = box?.width || GUESS.width;
    const height = box?.height || GUESS.height;
    return { x: Math.max(0, window.innerWidth - width - MARGIN), y: Math.max(0, window.innerHeight - height - 2 * MARGIN) };
  }

  /**
   * After a resize the remembered spot may be off screen; then it goes back to
   * the corner. A player that was never dragged follows the corner directly.
   */
  private onResize = (): void => {
    if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      if (!this.visible) return;
      if (!this.spot) {
        this.render();
        return;
      }
      const box = this.host?.querySelector('.tcr-player')?.getBoundingClientRect();
      const width = box?.width || GUESS.width;
      const height = box?.height || GUESS.height;
      const offScreen = this.spot.x + 40 > window.innerWidth || this.spot.y + 40 > window.innerHeight || this.spot.x + width < 40 || this.spot.y + height < 40;
      if (offScreen) this.resetPlayerPosition();
    });
  };

  private remember(position: Point): void {
    this.spot = position;
    this.options.savePositionCallback(position).catch((e: unknown) => console.error('TTS Chapter Reader: could not save the player position.', e));
  }

  public setInitialSavedPosition(position: Point | null): void {
    if (!position) return;
    this.spot = position;
    if (this.visible) this.render();
  }

  public resetPlayerPosition(): void {
    this.remember(this.defaultSpot());
    if (this.visible) this.render();
  }

  // ------------------------------------------------------------ show / hide

  public showPlayer(initial?: PlaybackState): void {
    if (!this.host) {
      this.host = document.body.createDiv({ cls: 'tcr-player-host' });
      this.root = createRoot(this.host);
    }
    this.visible = true;
    this.state = initial ?? IDLE;
    this.render();
  }

  public hidePlayer(): void {
    this.visible = false;
    this.render();
  }

  public updatePlayerState(state: PlaybackState): void {
    this.state = state;
    if (this.visible) this.render();
  }

  public getIsPlayerVisible(): boolean {
    return this.visible;
  }

  /** Chapter mode: give the player a chapter list (null clears it). */
  public setChapterData(data: ChapterUIData | null): void {
    this.chapterUI = data;
    this.render();
  }

  // ------------------------------------------------------------ render

  private render(): void {
    if (!this.root) return;
    const options = this.options;
    const { audioManager } = options;
    const state = this.state;
    const chapterUI = this.chapterUI;

    // The setters assign their setting before the save awaits, so every redraw can follow at once.
    const changeVolume = (volume: number) => {
      audioManager.setVolume(volume);
      void options.setVolume(volume);
      this.render();
    };

    this.root.render(
      createElement(FloatingPlayerUI, {
        isVisible: this.visible,
        onClose: () => this.hidePlayer(),
        title: chapterUI?.title,
        onOpenNote: chapterUI?.onOpenNote,
        mini: options.getMini(),
        onToggleMini: () => {
          void options.setMini(!options.getMini());
          this.render();
        },
        help: options.getHelp(),
        onOpenHotkeys: options.openHotkeys,
        onCopyText: chapterUI?.onCopyText,
        favoritesOnly: chapterUI?.favoritesOnly ?? false,
        onToggleFavoritesOnly: chapterUI?.onToggleFavoritesOnly,
        upNext: chapterUI?.upNext,
        onPause: () => audioManager.pausePlayback(),
        onResume: () => audioManager.resumePlayback(),
        onStop: () => audioManager.stopPlayback(),
        isPaused: !state.isPlaying,
        initialPosition: this.spot ?? this.defaultSpot(),
        onDragEnd: (position) => this.remember(position),
        currentTime: state.currentTime,
        duration: state.duration,
        hasTimeline: state.hasTimeline ?? true,
        status: state.status,
        onSeek: (time: number) => audioManager.seekPlayback(time),
        onReplay: () => audioManager.replayPlayback(),
        onJumpForward: () => audioManager.jumpForward(),
        onJumpBackward: () => audioManager.jumpBackward(),
        isLoading: state.isLoading,
        currentPart: state.currentPart,
        totalParts: state.totalParts,
        onNextPart: () => audioManager.nextPart(),
        onPreviousPart: () => audioManager.previousPart(),
        speed: options.getSpeed(),
        onSpeedChange: (speed: number) => {
          audioManager.setPlaybackSpeed(speed);
          void options.setSpeed(speed);
          this.render();
        },
        volume: options.getVolume(),
        onVolumeChange: changeVolume,
        onToggleMute: () => changeVolume(options.mutedVolume()),
        chapters: chapterUI?.rows,
        canRecord: chapterUI?.canRecord ?? true,
        onPickChapter: chapterUI?.onPick,
        onTogglePin: chapterUI?.onTogglePin,
        onToggleHide: chapterUI?.onToggleHide,
        onRerecord: chapterUI?.onRerecord,
      }),
    );
  }

  public destroy(): void {
    window.removeEventListener('resize', this.onResize);
    if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame);
    this.root?.unmount();
    this.root = null;
    this.host?.remove();
    this.host = null;
    this.visible = false;
  }
}
