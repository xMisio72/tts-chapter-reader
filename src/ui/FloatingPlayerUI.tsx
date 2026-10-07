import type { FunctionComponent } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { useDrag } from './useDrag';
import { setIcon } from 'obsidian';

interface ObsidianIconProps {
  icon: string;
  className?: string;
}

const ObsidianIcon: FunctionComponent<ObsidianIconProps> =({ icon, className }) => {
  const iconRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (iconRef.current) {
      iconRef.current.empty();
      setIcon(iconRef.current, icon);
    }
  }, [icon]);
  return <span ref={iconRef} className={`tcr-icon${className ? ` ${className}` : ''}`}></span>;
};

export interface ChapterRowData {
  i: number;
  title: string;
  /** Heading level 1-6 (0 for the text before the first heading); deeper chapters are indented. */
  level: number;
  durationLabel: string;
  cached: boolean;
  empty: boolean;
  pinned: boolean;
  hidden: boolean;
  recording: boolean;
  /** Read in English translation. */
  translated: boolean;
  translating: boolean;
  isCurrent: boolean;
}

export interface HelpItem {
  name: string;
  /** The hotkey as Obsidian prints it; empty when none is set. */
  keys: string;
}

interface FloatingPlayerUIProps {
  isVisible: boolean;
  onClose: () => void;
  /** The note being read (or "Selection"); click opens it. */
  title?: string;
  onOpenNote?: () => void;
  mini?: boolean;
  onToggleMini?: () => void;
  help?: HelpItem[];
  onOpenHotkeys?: () => void;
  onCopyText?: () => void;
  favoritesOnly?: boolean;
  /** Present when the note has favorite chapters to play on their own. */
  onToggleFavoritesOnly?: () => void;
  /** The next note in the reading list. */
  upNext?: { title: string; more: number; onClear: () => void };
  onPause?: () => void;
  onResume?: () => void;
  onStop: () => void;
  isPaused: boolean;
  initialPosition?: { x: number; y: number };
  onDragEnd?: (position: { x: number; y: number }) => void;
  currentTime?: number;
  duration?: number;
  hasTimeline?: boolean;
  status?: string;
  onSeek?: (time: number) => void;
  onReplay?: () => void;
  onJumpForward?: () => void;
  onJumpBackward?: () => void;
  isLoading?: boolean;
  speed?: number;
  onSpeedChange?: (speed: number) => void;
  volume?: number;
  onVolumeChange?: (volume: number) => void;
  onToggleMute?: () => void;
  currentPart?: number;
  totalParts?: number;
  onNextPart?: () => void;
  onPreviousPart?: () => void;
  chapters?: ChapterRowData[];
  /** False for the system voice: nothing is recorded, so no record controls. */
  canRecord?: boolean;
  onPickChapter?: (i: number) => void;
  onTogglePin?: (i: number) => void;
  onToggleHide?: (i: number) => void;
  onRerecord?: (i: number) => void;
}

/** Above this many chapters the list starts folded and gets a filter box. */
const LONG_LIST = 12;

function formatTime(timeInSeconds: number): string {
  if (!Number.isFinite(timeInSeconds)) return '0:00';
  const minutes = Math.floor(timeInSeconds / 60);
  const seconds = Math.floor(timeInSeconds % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}`;
}

export const FloatingPlayerUI: FunctionComponent<FloatingPlayerUIProps> = ({
  isVisible,
  onClose,
  title,
  onOpenNote,
  mini = false,
  onToggleMini,
  help,
  onOpenHotkeys,
  onCopyText,
  favoritesOnly = false,
  onToggleFavoritesOnly,
  upNext,
  onPause,
  onResume,
  onStop,
  isPaused,
  initialPosition = { x: 50, y: 50 },
  onDragEnd,
  currentTime = 0,
  duration = 0,
  hasTimeline = true,
  status,
  onSeek,
  onReplay,
  onJumpForward,
  onJumpBackward,
  isLoading = false,
  speed = 1.0,
  onSpeedChange,
  volume = 1,
  onVolumeChange,
  onToggleMute,
  currentPart,
  totalParts,
  onNextPart,
  onPreviousPart,
  chapters,
  canRecord = true,
  onPickChapter,
  onTogglePin,
  onToggleHide,
  onRerecord,
}) => {
  const drag = useDrag(initialPosition, onDragEnd);
  const position = drag.position;
  const isDragging = drag.active;
  const [chaptersOpen, setChaptersOpen] = useState(true);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState('');
  const currentRowRef = useRef<HTMLDivElement>(null);
  const listSizedFor = useRef<number | null>(null);

  // A long note starts with the list folded; the chapter bar still shows where we are.
  const chapterCount = chapters ? chapters.filter((c) => !c.empty).length : 0;
  useEffect(() => {
    if (!chapters || listSizedFor.current === chapterCount) return;
    listSizedFor.current = chapterCount;
    setChaptersOpen(chapterCount <= LONG_LIST);
    setFilter('');
  }, [chapters, chapterCount]);

  // Keep the chapter being read in view inside a scrolling list.
  useEffect(() => {
    currentRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [currentPart, chaptersOpen]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const volumeRef = useRef<HTMLSpanElement>(null);

  // The volume slider shows on demand and goes away with a click anywhere else.
  useEffect(() => {
    if (!volumeOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target instanceof Node) || !volumeRef.current?.contains(e.target)) setVolumeOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [volumeOpen]);
  if (!isVisible) return null;

  const isAtEnd = duration > 0 && currentTime >= duration - 0.1;
  const isReplayState = isPaused && isAtEnd && !!onReplay && !isLoading;
  const hasChapterNav = !!currentPart && !!totalParts && totalParts > 1;
  const readable = chapters ? chapters.filter((c) => !c.empty) : [];
  const hiddenCount = chapters ? chapters.filter((c) => c.hidden).length : 0;
  const current = chapters?.find((c) => c.isCurrent);
  const isLong = readable.length > LONG_LIST;
  const minLevel = Math.min(...(chapters ?? []).filter((c) => c.level > 0).map((c) => c.level), 6);

  const playPause = isReplayState ? (
    <button onClick={onReplay} aria-label="Replay" className="tcr-main">
      <ObsidianIcon icon="rotate-cw" />
    </button>
  ) : isPaused && !isLoading ? (
    <button onClick={onResume} aria-label="Resume" className="tcr-main">
      <ObsidianIcon icon="play" />
    </button>
  ) : (
    <button onClick={onPause} disabled={isLoading} aria-label="Pause" className="tcr-main">
      <ObsidianIcon icon="pause" />
    </button>
  );

  const header = (
    <div className="tcr-header">
      {title !== undefined &&
        (onOpenNote ? (
          <button className="tcr-title" onClick={onOpenNote} aria-label="Open this note" title={title}>
            {title}
          </button>
        ) : (
          <span className="tcr-title" title={title}>
            {title}
          </span>
        ))}
      <span className="tcr-header-spacer" />
      {help && (
        <button
          onClick={() => setHelpOpen((v) => !v)}
          className={`tcr-icon-btn${helpOpen ? ' is-active' : ''}`}
          aria-label={helpOpen ? 'Hide the help' : 'Keyboard shortcuts and more'}
        >
          <ObsidianIcon icon="circle-help" />
        </button>
      )}
      {onToggleMini && (
        <button onClick={onToggleMini} className="tcr-icon-btn" aria-label={mini ? 'Full player' : 'Small player'}>
          <ObsidianIcon icon={mini ? 'maximize-2' : 'minimize-2'} />
        </button>
      )}
      <button onClick={onClose} className="tcr-icon-btn tcr-close" aria-label="Close player">
        <ObsidianIcon icon="x" />
      </button>
    </div>
  );

  const upNextRow = upNext && (
    <div className="tcr-upnext">
      <span className="tcr-upnext-text" title={upNext.title}>
        Up next: {upNext.title}
        {upNext.more > 0 ? ` (+${upNext.more})` : ''}
      </span>
      <button onClick={upNext.onClear} className="tcr-icon-btn" aria-label="Clear the reading list">
        <ObsidianIcon icon="x" />
      </button>
    </div>
  );

  // Speaker icon in the transport row; the slider appears on click, the wheel nudges by 5%.
  const volumeControl = onVolumeChange && (
    <span className="tcr-vol-wrap" ref={volumeRef}>
      <button
        onClick={() => setVolumeOpen((v) => !v)}
        onWheel={(e) => {
          e.preventDefault();
          onVolumeChange(Math.max(0, Math.min(1, Math.round((volume + (e.deltaY < 0 ? 0.05 : -0.05)) * 100) / 100)));
        }}
        className={`tcr-vol-btn${volume === 0 ? ' is-muted' : ''}`}
        aria-label={`Volume ${Math.round(volume * 100)}%. Click for the slider, scroll to change`}
      >
        <ObsidianIcon icon={volume === 0 ? 'volume-x' : volume < 0.5 ? 'volume-1' : 'volume-2'} />
      </button>
      {volumeOpen && (
        <span className="tcr-vol-pop">
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(e) => onVolumeChange(parseFloat(e.currentTarget.value))}
            className="tcr-speed-slider"
            aria-label="Volume"
          />
          <button onClick={onToggleMute} className="tcr-vol-pct" aria-label={volume > 0 ? 'Mute' : 'Unmute'}>
            {Math.round(volume * 100)}%
          </button>
        </span>
      )}
    </span>
  );

  const helpCard = helpOpen && help && (
    <div className="tcr-help">
      {help.map((item) => (
        <div key={item.name} className="tcr-help-row">
          <span>{item.name}</span>
          <span className={`tcr-help-keys${item.keys ? '' : ' is-empty'}`}>{item.keys || 'no hotkey'}</span>
        </div>
      ))}
      <div className="tcr-help-actions">
        {onOpenHotkeys && (
          <button onClick={onOpenHotkeys} className="tcr-text-btn">
            Set hotkeys
          </button>
        )}
        {onCopyText && (
          <button onClick={onCopyText} className="tcr-text-btn">
            Copy the spoken text
          </button>
        )}
      </div>
    </div>
  );

  if (mini) {
    return (
      <div
        className={`tcr-player is-mini${isDragging ? ' is-dragging' : ''}`}
        style={{ left: `${position.x}px`, top: `${position.y}px` }}
        {...drag.handlers}
      >
        {header}
        <div className="tcr-controls tcr-mini-row">
          {hasChapterNav && (
            <button onClick={onPreviousPart} disabled={currentPart <= 1} aria-label="Previous chapter">
              <ObsidianIcon icon="skip-back" />
            </button>
          )}
          {playPause}
          {hasChapterNav && (
            <button onClick={onNextPart} disabled={currentPart >= totalParts} aria-label="Next chapter">
              <ObsidianIcon icon="skip-forward" />
            </button>
          )}
          <button onClick={onStop} aria-label="Stop" className="tcr-stop">
            <ObsidianIcon icon="square" />
          </button>
          {volumeControl}
          <span className="tcr-mini-info">
            {isLoading ? status || 'Loading…' : hasChapterNav ? `${currentPart}/${totalParts}` : ''}
            {hasTimeline && duration > 0 && !isLoading ? ` · ${formatTime(currentTime)}` : ''}
            {onSpeedChange ? ` · ${speed.toFixed(1)}x` : ''}
          </span>
        </div>
        {upNextRow}
        {helpCard}
      </div>
    );
  }

  return (
    <div
      className={`tcr-player${isDragging ? ' is-dragging' : ''}`}
      // Position follows the pointer while dragging, so it has to be set here.
      style={{ left: `${position.x}px`, top: `${position.y}px` }}
      {...drag.handlers}
    >
      {header}
      {helpCard}

      {/* Timeline, or a status line while there is nothing to show yet */}
      <div className="tcr-progress">
        {isLoading || !hasTimeline || duration <= 0 ? (
          <span className="tcr-status">
            {isLoading && <ObsidianIcon icon="loader-2" className="tcr-spin" />}
            {status || (isLoading ? 'Loading…' : hasTimeline ? '' : 'System voice')}
          </span>
        ) : (
          <>
            <span className="tcr-time">{formatTime(currentTime)}</span>
            <input
              type="range"
              min="0"
              max={duration}
              step="0.1"
              value={Math.min(currentTime, duration)}
              onChange={(e) => onSeek?.(parseFloat(e.currentTarget.value))}
              className="tcr-seek"
              aria-label="Seek"
            />
            <span className="tcr-time">{status ? status : formatTime(duration)}</span>
          </>
        )}
      </div>

      <div className="tcr-controls">
        {hasTimeline && !isReplayState && (
          <button onClick={onJumpBackward} disabled={isLoading} aria-label="Back 10 seconds">
            <ObsidianIcon icon="rotate-ccw" />
          </button>
        )}
        {playPause}
        {hasTimeline && !isReplayState && (
          <button onClick={onJumpForward} disabled={isLoading} aria-label="Forward 10 seconds">
            <ObsidianIcon icon="rotate-cw" />
          </button>
        )}
        <button onClick={onStop} aria-label="Stop" className="tcr-stop">
          <ObsidianIcon icon="square" />
        </button>
        {volumeControl}
      </div>

      {onSpeedChange && (
        <div className="tcr-speed">
          <span className="tcr-speed-label">{speed.toFixed(1)}x</span>
          <input
            type="range"
            min="0.5"
            max="3"
            step="0.1"
            value={speed}
            onChange={(e) => onSpeedChange(Math.round(parseFloat(e.currentTarget.value) * 10) / 10)}
            className="tcr-speed-slider"
            aria-label="Playback speed"
          />
        </div>
      )}


      {chapters && chapters.length > 0 && (
        <div className="tcr-chapters">
          {/* Chapter bar: where we are, and ‹ › to the previous/next chapter that plays (hidden and non-favorite ones are skipped) */}
          <div className="tcr-chapters-head">
            <button
              className="tcr-chapters-toggle"
              onClick={() => setChaptersOpen((v) => !v)}
              aria-label={chaptersOpen ? 'Collapse the chapter list' : `Show the chapter list (${readable.length} chapters)`}
            >
              <ObsidianIcon icon={chaptersOpen ? 'chevron-down' : 'chevron-right'} />
            </button>
            {hasChapterNav && (
              <button onClick={onPreviousPart} disabled={currentPart <= 1} className="tcr-icon-btn" aria-label="Previous chapter">
                <ObsidianIcon icon="chevron-left" />
              </button>
            )}
            <span className="tcr-chapter-now" title={current?.title}>
              {hasChapterNav ? `${currentPart}/${totalParts} · ` : ''}
              {current?.title ?? (readable.length === 1 ? '1 chapter' : `${readable.length} chapters`)}
            </span>
            {hasChapterNav && (
              <button onClick={onNextPart} disabled={currentPart >= totalParts} className="tcr-icon-btn" aria-label="Next chapter">
                <ObsidianIcon icon="chevron-right" />
              </button>
            )}
            <span className="tcr-chapters-tools">
              {chaptersOpen && hiddenCount > 0 && (
                <button
                  className={`tcr-hidden-toggle${showHidden ? ' is-active' : ''}`}
                  onClick={() => setShowHidden((v) => !v)}
                  aria-label={showHidden ? 'Conceal hidden chapters' : 'Show hidden chapters'}
                >
                  {hiddenCount} hidden
                </button>
              )}
              {onToggleFavoritesOnly && (
                <button
                  className={`tcr-icon-btn${favoritesOnly ? ' is-pinned' : ''}`}
                  onClick={onToggleFavoritesOnly}
                  aria-label={favoritesOnly ? 'Playing favorites only. Click to play all chapters' : 'Play favorites only'}
                >
                  <ObsidianIcon icon="star" />
                </button>
              )}
            </span>
          </div>
          {chaptersOpen && isLong && (
            <input
              type="text"
              className="tcr-filter"
              placeholder="Filter chapters"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
              aria-label="Filter chapters by title"
            />
          )}
          {chaptersOpen && (
            <div className="tcr-chapters-list">
              {chapters.map((c) => {
                if (c.hidden && !showHidden) return null;
                if (filter && !c.title.toLowerCase().includes(filter.toLowerCase())) return null;
                return (
                  <div
                    key={c.i}
                    ref={c.isCurrent ? currentRowRef : undefined}
                    style={c.level > minLevel ? { paddingLeft: `${(c.level - minLevel) * 10}px` } : undefined}
                    className={`tcr-chapter${c.isCurrent ? ' is-current' : ''}${c.hidden || c.empty || (favoritesOnly && !c.pinned) ? ' is-dimmed' : ''}`}
                  >
                    <button
                      className="tcr-chapter-main"
                      disabled={c.empty || !onPickChapter}
                      onClick={() => { if (!c.empty && onPickChapter) onPickChapter(c.i); }}
                      aria-label={c.empty ? 'Nothing to read aloud here' : `Play chapter ${c.i + 1}: ${c.title}`}
                    >
                      <span className="tcr-chapter-num">{c.i + 1}</span>
                      <span className={`tcr-chapter-title${c.hidden ? ' is-struck' : ''}`}>{c.title}</span>
                      {c.translated && <span className="tcr-chapter-lang" aria-label="Read in English translation">EN</span>}
                      {c.translating && (
                        <span className="tcr-chapter-recording" aria-label="Translating…">
                          <ObsidianIcon icon="loader-2" className="tcr-spin" />
                        </span>
                      )}
                      {canRecord && !c.cached && !c.empty && !c.recording && !c.translating && (
                        <span className="tcr-chapter-new" aria-label="Not recorded yet, or the text changed. Records when played.">●</span>
                      )}
                      {canRecord && c.cached && !c.empty && !c.recording && !c.translating && (
                        <span className="tcr-chapter-saved" aria-label="Recorded. Plays at once.">●</span>
                      )}
                      {c.recording && (
                        <span className="tcr-chapter-recording" aria-label="Recording…">
                          <ObsidianIcon icon="loader-2" className="tcr-spin" />
                        </span>
                      )}
                      <span className="tcr-chapter-duration">{c.durationLabel}</span>
                    </button>
                    {onTogglePin && (
                      <button
                        className={`tcr-chapter-btn${c.pinned ? ' is-pinned' : ''}`}
                        onClick={() => onTogglePin(c.i)}
                        aria-label={c.pinned ? 'Remove favorite' : 'Favorite'}
                      >
                        <ObsidianIcon icon="star" />
                      </button>
                    )}
                    {onToggleHide && (
                      <button
                        className={`tcr-chapter-btn${c.hidden ? ' is-hidden-flag' : ''}`}
                        onClick={() => onToggleHide(c.i)}
                        aria-label={c.hidden ? 'Unhide: playback includes it again' : 'Hide: playback skips it'}
                      >
                        <ObsidianIcon icon={c.hidden ? 'eye-off' : 'eye'} />
                      </button>
                    )}
                    {canRecord && onRerecord && !c.empty && (
                      <button
                        className="tcr-chapter-btn"
                        onClick={() => { if (!c.recording) onRerecord(c.i); }}
                        aria-label="Record this chapter again"
                        disabled={c.recording}
                      >
                        <ObsidianIcon icon="refresh-cw" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
      {upNextRow}
    </div>
  );
};
