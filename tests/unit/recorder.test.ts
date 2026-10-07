import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AudioCache } from '../../src/modules/audio-cache';
import { decodeWav, Engine, EngineError } from '../../src/modules/engines';
import { Recorder, RecordingRequest } from '../../src/modules/recorder';
import { CancelToken, JobCancelled, Mp3Sink } from '../../src/modules/tts-worker-client';

// ---------------------------------------------------------------- helpers

/** An engine whose recordings finish only when the test says so. */
class ManualEngine implements Engine {
  id = 'builtin' as const;
  metered = false;
  started: string[] = [];
  private open = new Map<string, { sink: Mp3Sink; finish: (seconds: number) => void; fail: (e: Error) => void }>();

  fingerprint(): string {
    return 'test';
  }

  record(segments: { text: string }[], sink: Mp3Sink, cancel: CancelToken): Promise<number> {
    const name = segments[0].text;
    this.started.push(name);
    return new Promise<number>((resolve, reject) => {
      this.open.set(name, { sink, finish: resolve, fail: reject });
      cancel.onCancel = () => {
        this.open.delete(name);
        reject(new JobCancelled());
      };
    });
  }

  piece(name: string, bytes: number[], seconds: number): void {
    this.open.get(name)?.sink.onPiece(new Uint8Array(bytes).buffer, seconds);
  }

  finish(name: string, seconds: number): void {
    this.open.get(name)?.finish(seconds);
    this.open.delete(name);
  }

  fail(name: string, error: Error): void {
    this.open.get(name)?.fail(error);
    this.open.delete(name);
  }
}

function fakeCache() {
  const saved = new Map<string, { audio: ArrayBuffer; seconds: number }>();
  const cache = {
    put: async (hash: string, audio: ArrayBuffer, seconds: number) => {
      saved.set(hash, { audio, seconds });
    },
  } as unknown as AudioCache;
  return { cache, saved };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup() {
  const engine = new ManualEngine();
  const { cache, saved } = fakeCache();
  const recorder = new Recorder(cache);
  const events: string[] = [];
  recorder.addListener({ onChange: (hash, event) => events.push(`${hash}:${event}`) });
  const owner = {};
  const request = (name: string, from: object = owner): RecordingRequest => ({
    hash: name,
    label: name,
    segments: [{ text: name, pauseMs: 0 }],
    engine,
    owner: from,
  });
  return { engine, recorder, saved, events, request, owner };
}

// ---------------------------------------------------------------- recorder

test('a recording is assembled from its pieces and saved', async () => {
  const { engine, recorder, saved, events, request } = setup();
  const recording = recorder.request(request('a'), 'now');
  await tick();
  engine.piece('a', [1, 2], 0.5);
  engine.piece('a', [3], 1.0);
  engine.finish('a', 1.0);
  const result = await recording.done;
  assert.deepEqual([...new Uint8Array(result.audio)], [1, 2, 3]);
  assert.equal(result.seconds, 1.0);
  assert.equal(saved.get('a')?.seconds, 1.0);
  assert.deepEqual(events, ['a:started', 'a:saved']);
  assert.equal(recorder.stateOf('a'), null);
});

test('someone who starts listening late still gets the pieces made so far', async () => {
  const { engine, recorder, request } = setup();
  const recording = recorder.request(request('a'), 'ahead');
  await tick();
  engine.piece('a', [1], 0.5);
  const heard: number[] = [];
  recorder.request(request('a'), 'now').subscribe((piece) => heard.push(new Uint8Array(piece)[0]));
  engine.piece('a', [2], 1.0);
  assert.deepEqual(heard, [1, 2]);
  assert.equal(engine.started.length, 1, 'the running recording is reused, not restarted');
  engine.finish('a', 1.0);
  await recording.done;
});

test('recordings run one at a time, most urgent first', async () => {
  const { engine, recorder, request } = setup();
  recorder.request(request('first'), 'ahead');
  recorder.request(request('later'), 'ahead');
  recorder.request(request('asked-by-hand'), 'soon');
  await tick();
  assert.deepEqual(engine.started, ['first']);
  engine.finish('first', 1);
  await tick();
  assert.deepEqual(engine.started, ['first', 'asked-by-hand']);
  engine.finish('asked-by-hand', 1);
  await tick();
  assert.deepEqual(engine.started, ['first', 'asked-by-hand', 'later']);
});

test('the chapter the listener waits for interrupts background work, which starts over later', async () => {
  const { engine, recorder, saved, request } = setup();
  const background = recorder.request(request('background'), 'ahead');
  await tick();
  engine.piece('background', [9], 0.5);

  const wanted = recorder.request(request('wanted'), 'now');
  await tick();
  assert.deepEqual(engine.started, ['background', 'wanted']);
  assert.equal(recorder.stateOf('background'), 'queued');

  engine.piece('wanted', [1], 1);
  engine.finish('wanted', 1);
  await wanted.done;
  await tick();

  // The interrupted recording runs again from the beginning; the piece from
  // the first attempt must not end up in the result.
  assert.deepEqual(engine.started, ['background', 'wanted', 'background']);
  engine.piece('background', [7], 0.5);
  engine.finish('background', 0.5);
  const result = await background.done;
  assert.deepEqual([...new Uint8Array(result.audio)], [7]);
  assert.equal(saved.size, 2);
});

test('a failed recording reports the error and frees the queue', async () => {
  const { engine, recorder, events, request } = setup();
  const broken = recorder.request(request('broken'), 'now');
  const next = recorder.request(request('next'), 'ahead');
  await tick();
  engine.fail('broken', new EngineError('The voice server answered 401.'));
  await assert.rejects(broken.done, /401/);
  await tick();
  assert.deepEqual(engine.started, ['broken', 'next']);
  assert.ok(events.includes('broken:failed'));
  engine.finish('next', 1);
  await next.done;
});

test('closing a note withdraws its background recordings but not other notes', async () => {
  const { engine, recorder, events, request } = setup();
  const noteA = {};
  const noteB = {};
  const a1 = recorder.request(request('a1', noteA), 'ahead');
  const a2 = recorder.request(request('a2', noteA), 'ahead');
  const b1 = recorder.request(request('b1', noteB), 'ahead');
  await tick();
  recorder.dropOwner(noteA);
  await assert.rejects(a1.done, JobCancelled);
  await assert.rejects(a2.done, JobCancelled);
  await tick();
  assert.deepEqual(engine.started, ['a1', 'b1']);
  assert.ok(events.includes('a1:dropped') && events.includes('a2:dropped'));
  engine.finish('b1', 1);
  await b1.done;
});

// ---------------------------------------------------------------- WAV decoding

function wav({ rate = 24000, channels = 1, samples = [0, 1000, -1000], openSizes = false, bits = 16 } = {}): ArrayBuffer {
  const data = new Int16Array(samples);
  const buffer = new ArrayBuffer(44 + data.byteLength);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF');
  view.setUint32(4, openSizes ? 0xffffffff : 36 + data.byteLength, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, bits, true);
  tag(36, 'data');
  view.setUint32(40, openSizes ? 0xffffffff : data.byteLength, true);
  new Int16Array(buffer, 44).set(data);
  return buffer;
}

test('a plain WAV file is read as it is', () => {
  const pcm = decodeWav(wav());
  assert.equal(pcm.sampleRate, 24000);
  assert.deepEqual([...pcm.samples], [0, 1000, -1000]);
});

test('a streamed WAV with open-ended sizes is read to the end of the data', () => {
  assert.deepEqual([...decodeWav(wav({ openSizes: true, rate: 22050 })).samples], [0, 1000, -1000]);
  assert.equal(decodeWav(wav({ openSizes: true, rate: 22050 })).sampleRate, 22050);
});

test('stereo is mixed down to mono', () => {
  assert.deepEqual([...decodeWav(wav({ channels: 2, samples: [100, 300, -200, -400] })).samples], [200, -300]);
});

test('anything that is not 16-bit WAV is refused with a readable message', () => {
  assert.throws(() => decodeWav(new TextEncoder().encode('{"error":"nope"}').buffer as ArrayBuffer), /did not return WAV/);
  assert.throws(() => decodeWav(wav({ bits: 24 })), /Unsupported WAV format/);
});

test('a recording whose save fails is handed over but not announced as saved', async () => {
  const events: string[] = [];
  const failingCache = {
    put: async () => {
      throw new Error('disk full');
    },
  } as unknown as AudioCache;
  const recorder = new Recorder(failingCache);
  recorder.addListener({ onChange: (_hash, event) => events.push(event) });
  const engine: Engine = {
    id: 'builtin',
    metered: false,
    fingerprint: () => 'test',
    record: async (_segments, sink) => {
      sink.onPiece(new ArrayBuffer(8), 1, 0);
      return 1;
    },
  };
  const request: RecordingRequest = { hash: 'h-fail', label: 'x', segments: [{ text: 'a', pauseMs: 0 }], engine, owner: {} };
  const result = await recorder.request(request, 'now').done;
  assert.equal(result.audio.byteLength, 8);
  assert.deepEqual(events, ['started', 'dropped']);
});
