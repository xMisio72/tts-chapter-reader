// Loaded into the Obsidian window by obsidian_e2e.py. Gives the test script a
// few short handles on the running plugin. Test-only: never shipped.
window.__tcrTest = (() => {
  const P = () => app.plugins.plugins['tts-chapter-reader'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const until = async (fn, ms, label) => {
    const t0 = Date.now();
    for (;;) {
      const value = await fn();
      if (value) return value;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for: ' + label);
      await sleep(100);
    }
  };

  const state = () => {
    const p = P();
    const a = p.audioManager;
    const s = p.session;
    return {
      active: a.isActive(),
      t: +a.audio.currentTime.toFixed(2),
      duration: Number.isFinite(a.audio.duration) ? +a.audio.duration.toFixed(2) : null,
      paused: a.audio.paused,
      loading: a.loading,
      speaking: a.speaking,
      idx: a.chapterIndex,
      rate: a.audio.playbackRate,
      device: p.worker.loaded ? p.worker.loaded.device : null,
      listShown: !!document.querySelector('.tcr-chapters'),
      chapters: s
        ? s.chapters.map((c) => ({ title: c.title, cached: c.cached, recording: c.recording, hidden: c.hidden, pinned: c.pinned, duration: c.duration, hash: c.hash }))
        : null,
    };
  };

  const playing = () => {
    const a = P().audioManager;
    return !a.loading && !a.audio.paused && a.audio.currentTime > 0.05;
  };

  const openNote = async (path) => {
    const file = app.vault.getFileByPath(path);
    await app.workspace.getLeaf(false).openFile(file);
    await sleep(300);
    return file;
  };

  const stop = async () => {
    P().audioManager.stopPlayback();
    await sleep(200);
  };

  /** Count the saved recordings. */
  const cacheStats = () => P().cache.stats();

  return { P, sleep, until, state, playing, openNote, stop, cacheStats };
})();
'helpers loaded';
