"""End-to-end checks of TTS Chapter Reader inside a real Obsidian window.

Drives the plugin through Obsidian's command-line tool (Settings > General >
Command line interface must be on, and the vault must be open with the plugin
enabled and the natural voice downloaded).

    python tests/e2e/obsidian_e2e.py                # all checks, demo-vault
    python tests/e2e/obsidian_e2e.py cached speed   # only the named checks

Audio plays through the speakers while this runs.
"""

import http.server
import json
import os
import struct
import subprocess
import sys
import threading
import time

VAULT = os.environ.get("TCR_VAULT", "demo-vault")
NOTE = "E2E test note.md"
OBSIDIAN = os.path.expandvars(r"%LOCALAPPDATA%\Programs\Obsidian\Obsidian.com")
HERE = os.path.dirname(os.path.abspath(__file__)).replace("\\", "/")
MOCK_PORT = 8796

NOTE_TEXT = """---
tags: [e2e]
---
Opening words before the first heading.

## Alpha

The first chapter talks about apples and nothing else.

## Beta

The second chapter talks about bridges. It has two sentences.

## Gamma

The third chapter is the last one.
"""


def ev(code, timeout=90):
    """Run JavaScript in the vault's window and return what it evaluates to."""
    r = subprocess.run(
        [OBSIDIAN, f"vault={VAULT}", "eval", "code=" + code],
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    out = (r.stdout + r.stderr).strip()
    # Console lines the page logged meanwhile come first; the value is the "=> " line.
    for line in out.splitlines():
        if line.startswith("=> "):
            return line[3:]
    return out


def js(body, timeout=90):
    """Run an async function body with `T` bound to the test helpers; returns parsed JSON."""
    out = ev("(async()=>{const T=window.__tcrTest;try{return JSON.stringify(await (async()=>{%s})())}catch(e){return JSON.stringify({__error:String(e&&e.message||e)})}})()" % body, timeout)
    try:
        value = json.loads(out)
    except json.JSONDecodeError:
        raise AssertionError(f"unexpected output from Obsidian: {out[:400]}")
    if isinstance(value, dict) and "__error" in value:
        raise AssertionError(value["__error"])
    return value


def setup():
    print(ev("eval(require('fs').readFileSync('%s/helpers.js','utf8'))" % HERE))
    js("""
      const text = %s;
      const existing = app.vault.getFileByPath(%s);
      if (existing) await app.vault.modify(existing, text); else await app.vault.create(%s, text);
      await T.stop();
      const p = T.P();
      p.settings.engine = 'builtin'; p.settings.builtinDevice = 'auto'; p.settings.recordAhead = 'auto';
      p.settings.playbackSpeed = 1.0; p.settings.chapterFlags = {}; p.settings.showNotices = false;
      // Player state that would hide the chapter list or change recordings.
      p.settings.playerMini = false; p.settings.favoritesOnly = false; p.settings.pauseAtChapterStart = false;
      p.settings.queue = []; p.settings.positions = {};
      await p.saveSettings();
      await T.openNote(%s);
      return true;
    """ % (json.dumps(NOTE_TEXT), json.dumps(NOTE), json.dumps(NOTE), json.dumps(NOTE)))


def start_note(wait_playing=True, limit=60000):
    return js("""
      const t0 = performance.now();
      await T.P().readNoteAloud();
      %s
      return { ms: Math.round(performance.now() - t0), state: T.state() };
    """ % (f"await T.until(T.playing, {limit}, 'playback to start');" if wait_playing else ""))


# ---------------------------------------------------------------- checks

def check_first_listen():
    """A note nobody has heard yet: chapters are found, recorded and played."""
    js("await T.P().cache.clear(); return true;")
    r = start_note()
    s = r["state"]
    titles = [c["title"] for c in s["chapters"]]
    assert titles == ["E2E test note", "Alpha", "Beta", "Gamma"], titles
    assert s["listShown"], "chapter list is not shown"
    done = js("""
      await T.until(() => T.state().chapters.every(c => c.cached), 60000, 'all chapters recorded');
      return { state: T.state(), stats: await T.cacheStats() };
    """)
    assert done["stats"]["count"] == 4, done["stats"]
    return f"first audio after {r['ms']} ms on {done['state']['device']}; 4 chapters recorded ahead"


def check_cached():
    """Second listen: everything comes from the saved recordings, at once."""
    js("await T.stop(); return true;")
    r = start_note()
    assert all(c["cached"] for c in r["state"]["chapters"]), "chapters lost their recordings"
    assert r["ms"] < 1500, f"cached start took {r['ms']} ms"
    return f"cached start in {r['ms']} ms"


def check_controls():
    """Pause, resume, seek, speed, next and previous chapter."""
    r = js("""
      const a = T.P().audioManager;
      a.pausePlayback(); await T.sleep(300);
      const paused = a.audio.paused && a.isPlaybackPaused();
      a.resumePlayback(); await T.until(() => !a.audio.paused, 3000, 'resume');
      a.seekPlayback(1.5); await T.sleep(200);
      const seeked = a.audio.currentTime;
      a.setPlaybackSpeed(2.0); await T.sleep(200);
      const rate = a.audio.playbackRate;
      a.setPlaybackSpeed(1.0);
      a.nextPart(); await T.until(() => T.state().idx === 1 && T.playing(), 5000, 'next chapter');
      a.previousPart(); await T.until(() => T.state().idx === 0 && T.playing(), 5000, 'previous chapter');
      T.P().session.play(3); await T.until(() => T.state().idx === 3 && T.playing(), 5000, 'jump to chapter 4');
      return { paused, seeked, rate };
    """)
    assert r["paused"], "pause did not pause"
    assert 1.3 < r["seeked"] < 2.2, r["seeked"]
    assert r["rate"] == 2.0, r["rate"]
    return "pause/resume, seek, 2x speed, next/previous/jump all respond"


def check_auto_advance():
    """A chapter that ends rolls into the next playable one; hidden ones are skipped."""
    r = js("""
      const p = T.P(); const s = p.session; const a = p.audioManager;
      s.toggleHidden(1);                                   // hide "Alpha"
      s.play(0); await T.until(() => T.state().idx === 0 && T.playing(), 5000, 'chapter 1');
      a.seekPlayback(a.audio.duration - 0.4);
      await T.until(() => T.state().idx === 2 && T.playing(), 8000, 'auto-advance past the hidden chapter');
      const saved = JSON.parse(JSON.stringify(p.settings.chapterFlags));
      s.togglePinned(2);
      const withPin = JSON.parse(JSON.stringify(p.settings.chapterFlags));
      s.toggleHidden(1); s.togglePinned(2);
      return { saved, withPin, after: p.settings.chapterFlags };
    """)
    assert r["saved"] == {NOTE: {"alpha": {"pinned": False, "hidden": True}}}, r["saved"]
    assert r["withPin"][NOTE]["beta"]["pinned"] is True, r["withPin"]
    assert r["after"] == {}, r["after"]
    return "ended chapter advanced past a hidden one; favorite/hidden marks saved and cleared"


def check_edit():
    """Editing one chapter makes only that chapter 'not recorded'; it is recorded again."""
    r = js("""
      const before = T.state().chapters.map(c => c.hash);
      const file = app.vault.getFileByPath(%s);
      await app.vault.process(file, (text) => text.replace('talks about bridges', 'talks about lighthouses'));
      await T.until(() => T.state().chapters[2].hash !== before[2], 5000, 'chapter list to notice the edit');
      const stale = T.state().chapters.map(c => c.cached);
      const same = T.state().chapters.map((c, i) => c.hash === before[i]);
      await T.until(() => T.state().chapters.every(c => c.cached), 60000, 'changed chapter recorded again');
      return { stale, same, stats: await T.cacheStats() };
    """ % json.dumps(NOTE))
    assert r["same"] == [True, True, False, True], r["same"]
    assert r["stale"] == [True, True, False, True], r["stale"]
    assert r["stats"]["count"] == 5, r["stats"]  # the old recording of Beta is kept until pruned
    return "only the edited chapter was marked and recorded again"


def check_rerecord():
    """The re-record button replaces a chapter's recording."""
    r = js("""
      const s = T.P().session;
      s.rerecord(1);
      await T.until(() => !T.state().chapters[1].cached, 3000, 'recording dropped');
      await T.until(() => T.state().chapters[1].cached, 60000, 'recorded again');
      return T.state().chapters[1];
    """)
    assert r["cached"] and r["duration"] > 1, r
    return "chapter recorded again on request"


def check_selection():
    """Loose text (a selection): chapters at its headings, list shown, no favorite/hide buttons."""
    r = js("""
      await T.stop();
      await T.P().readText('This is a selected sentence that nobody has recorded before, number %d.\\n\\n## Second part\\n\\nAnd one more sentence.', 'Selection');
      await T.until(T.playing, 60000, 'selection to play');
      const st = T.state();
      st.markButtons = document.querySelectorAll('.tcr-chapter-btn[aria-label*="avorite"], .tcr-chapter-btn[aria-label^="Hide"], .tcr-chapter-btn[aria-label^="Unhide"]').length;
      await T.stop();
      return st;
    """ % int(time.time()))
    assert len(r["chapters"]) == 2 and r["listShown"] and r["markButtons"] == 0, r
    return "selection played with a 2-chapter list and no favorite/hide buttons"


def check_system_voice():
    """The system voice speaks directly; nothing is recorded."""
    r = js("""
      const p = T.P();
      // The voice list arrives a moment after the first time it is asked for.
      let voices = 0;
      for (let i = 0; i < 30 && !voices; i++) { voices = window.speechSynthesis ? window.speechSynthesis.getVoices().length : 0; if (!voices) await T.sleep(100); }
      if (!voices) return { skipped: true };
      const before = await T.cacheStats();
      p.settings.engine = 'system'; await p.saveSettings();
      await T.openNote(%s);
      await p.readNoteAloud();
      await T.until(() => p.audioManager.speaking && window.speechSynthesis.speaking, 8000, 'system voice to speak');
      const st = T.state();
      p.audioManager.pausePlayback(); await T.sleep(300);
      const pausedOk = p.audioManager.isPlaybackPaused();
      await T.stop();
      const stillSpeaking = window.speechSynthesis.speaking;
      p.settings.engine = 'builtin'; await p.saveSettings();
      return { voices, st, pausedOk, stillSpeaking, before, after: await T.cacheStats() };
    """ % json.dumps(NOTE))
    if r.get("skipped"):
        return "SKIPPED: this machine reports no system voices"
    assert r["st"]["speaking"] and len(r["st"]["chapters"]) == 4, r["st"]
    assert r["pausedOk"] and not r["stillSpeaking"], r
    assert r["before"] == r["after"], "the system voice must not create recordings"
    return f"system voice spoke ({r['voices']} voices installed), paused and stopped"


def check_cpu():
    """Without a graphics card the voice runs on the processor."""
    r = js("""
      const p = T.P();
      await T.stop();
      p.settings.builtinDevice = 'cpu'; p.releaseVoiceEngine(); await p.saveSettings();
      const t0 = performance.now();
      await p.readText('The processor can read this sentence without any help from a graphics card, run %d.', 'Selection');
      await T.until(T.playing, 90000, 'processor playback');
      const ms = Math.round(performance.now() - t0);
      const device = T.state().device;
      await T.stop();
      p.settings.builtinDevice = 'auto'; p.releaseVoiceEngine(); await p.saveSettings();
      return { ms, device };
    """ % int(time.time()), timeout=150)
    assert r["device"] == "wasm", r
    return f"processor-only voice started in {r['ms']} ms (cold start, includes loading the model)"


class MockSpeechServer(http.server.BaseHTTPRequestHandler):
    """An OpenAI-compatible /v1/audio/speech that answers with a short tone as WAV."""
    requests = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))) or b"{}")
        MockSpeechServer.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        if self.path.endswith("/chat/completions"):
            # A "translation": every paragraph becomes an English sentence that names it.
            source = next((m["content"] for m in body.get("messages", []) if m.get("role") == "user"), "")
            paragraphs = [p for p in source.split("\n\n") if p.strip()]
            answer = "\n\n".join(f"English version of paragraph {i + 1}." for i in range(len(paragraphs)))
            payload = json.dumps({"choices": [{"message": {"role": "assistant", "content": answer}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if body.get("voice") == "broken":
            payload = json.dumps({"error": {"message": "Unknown voice 'broken'"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        rate, seconds = 24000, max(0.6, len(body.get("input", "")) / 40)
        import math
        frames = b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(int(rate * seconds)))
        # Streaming servers leave the sizes open (0xFFFFFFFF); the plugin has to cope.
        wav = b"RIFF" + struct.pack("<I", 0xFFFFFFFF) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16) + b"data" + struct.pack("<I", 0xFFFFFFFF) + frames
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def log_message(self, *args):
        pass


def check_openai_compatible():
    """Own server: the request has the OpenAI shape and the WAV answer is played."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockSpeechServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        r = js("""
          const p = T.P();
          await T.stop();
          const keep = JSON.parse(JSON.stringify(p.settings.openai));
          p.settings.engine = 'openai';
          p.settings.openai = { baseUrl: 'http://127.0.0.1:%d/v1/', model: 'kokoro', voice: 'af_heart', keyName: '' };
          await p.saveSettings();
          await T.openNote(%s);
          await p.readNoteAloud();
          await T.until(T.playing, 20000, 'server audio to play');
          await T.until(() => T.state().chapters.every(c => c.cached), 30000, 'all chapters recorded from the server');
          const good = T.state();
          await T.stop();

          // A server error must reach the user as a readable message, not a hang.
          p.settings.openai.voice = 'broken';
          p.settings.showNotices = true;
          await p.saveSettings();
          await p.readNoteAloud();
          const notice = await T.until(() => [...document.querySelectorAll('.notice')].map(n => n.textContent).find(t => t.includes('Unknown voice')), 10000, 'error notice');
          const stopped = await T.until(() => !p.audioManager.isActive(), 5000, 'playback to stop after the error');
          p.settings.showNotices = false;
          p.settings.openai = keep; p.settings.engine = 'builtin';
          await p.saveSettings();
          return { good, notice, stopped };
        """ % (MOCK_PORT, json.dumps(NOTE)))
    finally:
        server.shutdown()
        server.server_close()
    ok = [q for q in MockSpeechServer.requests if q["body"].get("voice") == "af_heart"]
    assert ok, "the server received no request"
    first = ok[0]
    assert first["path"] == "/v1/audio/speech", first["path"]
    assert first["body"]["model"] == "kokoro" and first["body"]["response_format"] == "wav", first["body"]
    assert first["auth"] is None, "no key configured, so no Authorization header expected"
    assert all(len(q["body"]["input"]) <= 900 for q in ok), "a request exceeded the per-request size"
    assert "Unknown voice" in r["notice"], r["notice"]
    return f"{len(ok)} requests in OpenAI format, audio played, server error shown as: {r['notice'][:70]}"


GERMAN_NOTE = """---
tags: [e2e]
---
Dieser Text steht vor der ersten Überschrift und ist lang genug, damit die Sprache sicher erkannt wird.

## Erstes Kapitel

Jede Überschrift wird ein Kapitel. Das Plugin teilt eine Notiz an ihren Überschriften, so dass man direkt zu dem Teil springen kann, den man hören möchte.

## Zweites Kapitel

Nur geänderte Kapitel werden neu aufgenommen. Alle anderen behalten ihre Aufnahme und zeigen einen grünen Punkt.
"""


def check_translate():
    """A German note with an English-only voice: translated through the (mock) chat API, "EN" shown, English text recorded."""
    server = http.server.ThreadingHTTPServer(("127.0.0.1", MOCK_PORT), MockSpeechServer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    MockSpeechServer.requests.clear()
    try:
        r = js("""
          const p = T.P();
          await T.stop();
          const keep = JSON.parse(JSON.stringify(p.settings.translation));
          p.settings.translation.mode = 'openai';
          p.settings.translation.openai = { baseUrl: 'http://127.0.0.1:%d/v1', model: 'mock-chat', keyName: '' };
          p.settings.translation.voices.builtin = true;
          await p.saveSettings();
          // Saved translations from an earlier run would skip the chat server.
          await new Promise((res, rej) => {
            const r = indexedDB.open('tts-chapter-reader');
            r.onsuccess = () => {
              const tx = r.result.transaction('translations', 'readwrite');
              tx.objectStore('translations').clear();
              tx.oncomplete = () => { r.result.close(); res(); };
              tx.onerror = () => rej(tx.error);
            };
            r.onerror = () => rej(r.error);
          });
          const file = await app.vault.create('E2E German note.md', %s);
          try {
            await app.workspace.getLeaf().openFile(file);
            await p.readNoteAloud(undefined, undefined, file.path);
            await T.until(T.playing, 40000, 'translated chapter to play');
            // Recording speed is the voice's business (other checks cover it); here only the translations matter.
            await T.until(() => p.session && p.session.chapters.every(c => c.translated), 30000, 'all chapters translated');
            const st = T.state();
            st.translated = p.session.chapters.map(c => c.translated);
            st.texts = p.session.chapters.map(c => c.text);
            st.langs = p.session.chapters.map(c => c.lang);
            st.tags = document.querySelectorAll('.tcr-chapter-lang').length;
            await T.stop();
            return st;
          } finally {
            await app.vault.delete(file);
            p.settings.translation = keep;
            await p.saveSettings();
          }
        """ % (MOCK_PORT, json.dumps(GERMAN_NOTE)))
    finally:
        server.shutdown()
        server.server_close()
    chats = [q for q in MockSpeechServer.requests if q["path"].endswith("/chat/completions")]
    assert len(chats) == 3, f"expected one translation request per chapter, got {len(chats)}"
    assert all(r["translated"]), r["translated"]
    assert all(l == "de" for l in r["langs"]), r["langs"]
    assert all("English version of paragraph" in t for t in r["texts"]), r["texts"]
    assert r["tags"] == 3, r["tags"]
    return f"3 German chapters detected, translated through the chat API, marked EN and recorded in English"


def check_settings_page():
    """The settings page draws for every voice engine without errors."""
    r = js("""
      const p = T.P();
      app.setting.open(); app.setting.openTabById('tts-chapter-reader');
      const seen = {};
      for (const engine of ['builtin', 'system', 'openai', 'gemini']) {
        p.settings.engine = engine;
        app.setting.activeTab.display();
        await T.sleep(400);
        seen[engine] = [...app.setting.activeTab.containerEl.querySelectorAll('.setting-item-name')].map(e => e.textContent);
      }
      p.settings.engine = 'builtin'; await p.saveSettings();
      app.setting.activeTab.display(); await T.sleep(400);
      return seen;
    """)
    assert "Voice files" in r["builtin"] and "Run on" in r["builtin"], r["builtin"]
    assert "Server address" in r["openai"] and "API key" in r["openai"], r["openai"]
    assert "API key" in r["gemini"], r["gemini"]
    for names in r.values():
        assert "Chapters" in names and "Player" in names and "Saved recordings" in names, names
    return "settings page drew for all four voices"


def check_download():
    """Remove the natural voice and download it again (about 330 MB). Only runs when named."""
    r = js("""
      const p = T.P();
      await T.stop();
      p.releaseVoiceEngine();
      const idb = (store) => new Promise((res, rej) => { const q = indexedDB.open('tts-chapter-reader'); q.onsuccess = () => { const db = q.result; const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => { db.close(); res(true); }; tx.onerror = () => rej(tx.error); }; q.onerror = () => rej(q.error); });
      await idb('files');
      const t0 = performance.now();
      const ok = await p.voiceDownload.start(p.settings.builtinVoice);
      return { ok, error: p.voiceDownload.error, seconds: Math.round((performance.now() - t0) / 1000) };
    """, timeout=900)
    assert r["ok"], r
    played = js("""
      await T.P().readText('The voice was downloaded again and still speaks, run %d.', 'Selection');
      await T.until(T.playing, 90000, 'playback after the download');
      await T.stop();
      return true;
    """ % int(time.time()), timeout=150)
    assert played
    return f"downloaded and verified in {r['seconds']} s, then spoke"


CHECKS = {
    "first": check_first_listen,
    "cached": check_cached,
    "controls": check_controls,
    "advance": check_auto_advance,
    "edit": check_edit,
    "rerecord": check_rerecord,
    "selection": check_selection,
    "system": check_system_voice,
    "cpu": check_cpu,
    "openai": check_openai_compatible,
    "translate": check_translate,
    "settings": check_settings_page,
}

# Heavy or destructive checks: run only when named on the command line.
ON_REQUEST = {"download": check_download}


def main():
    wanted = sys.argv[1:] or list(CHECKS)
    setup()
    failed = 0
    for name in wanted:
        try:
            print(f"PASS {name}: {(CHECKS.get(name) or ON_REQUEST[name])()}", flush=True)
        except Exception as e:  # report every check, do not stop at the first failure
            failed += 1
            print(f"FAIL {name}: {e}", flush=True)
    try:
        js("""
          await T.stop(); app.setting.close();
          const f = app.vault.getFileByPath(%s); if (f) await app.vault.delete(f);
          const p = T.P(); p.settings.showNotices = true; p.settings.chapterFlags = {}; await p.saveSettings();
          return true;
        """ % json.dumps(NOTE))
    except Exception as e:
        print(f"cleanup problem: {e}")
    errors = subprocess.run([OBSIDIAN, f"vault={VAULT}", "dev:errors"], capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.strip()
    print("Obsidian errors:", errors)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
