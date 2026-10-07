import { requestUrl } from 'obsidian';
import { idbDelete, idbHas, idbKeys, idbPut, STORE_FILES } from '../shared/idb';
import { KOKORO_KEY_PREFIX, KOKORO_REPO, ORT_WASM_KEY } from '../shared/protocol';

/**
 * The built-in voice: which files it needs, where they come from, and the
 * one-time download.
 *
 * Nothing is fetched until the user asks for it. Every file is pinned to an
 * exact version and checked against a known SHA-256 before it is stored, so
 * what runs is exactly what this plugin version was built and tested with.
 */

/** Model snapshot on Hugging Face (Apache-2.0). Pinned, never "latest". */
const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
const HF_BASE = `https://huggingface.co/${KOKORO_REPO}/resolve/${KOKORO_REVISION}/`;

interface VoiceFile {
  key: string;
  url: string;
  bytes: number;
  sha256: string;
}

const CORE_FILES: VoiceFile[] = [
  {
    // The speech runtime, the same build the plugin's worker was compiled against.
    key: ORT_WASM_KEY,
    url: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${__ORT_VERSION__}/dist/${__ORT_WASM_FILE__}`,
    bytes: __ORT_WASM_BYTES__,
    sha256: __ORT_WASM_SHA256__,
  },
  {
    key: `${KOKORO_KEY_PREFIX}config.json`,
    url: `${HF_BASE}config.json`,
    bytes: 44,
    sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f',
  },
  {
    key: `${KOKORO_KEY_PREFIX}tokenizer.json`,
    url: `${HF_BASE}tokenizer.json`,
    bytes: 3497,
    sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34',
  },
  {
    key: `${KOKORO_KEY_PREFIX}tokenizer_config.json`,
    url: `${HF_BASE}tokenizer_config.json`,
    bytes: 113,
    sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20',
  },
  {
    key: `${KOKORO_KEY_PREFIX}onnx/model.onnx`,
    url: `${HF_BASE}onnx/model.onnx`,
    bytes: 325532232,
    sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb',
  },
];


export interface BuiltinVoice {
  id: string;
  name: string;
  accent: 'US' | 'UK';
  gender: 'female' | 'male';
  /** Size and SHA-256 of the speaker file at the pinned revision. */
  bytes: number;
  sha256: string;
}

/** English voices of the built-in engine, best-sounding first. */
export const BUILTIN_VOICES: BuiltinVoice[] = [
  { id: 'af_heart', name: 'Heart', accent: 'US', gender: 'female', bytes: 522240, sha256: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b' },
  { id: 'af_bella', name: 'Bella', accent: 'US', gender: 'female', bytes: 522240, sha256: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b' },
  { id: 'af_nicole', name: 'Nicole', accent: 'US', gender: 'female', bytes: 522240, sha256: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a' },
  { id: 'bf_emma', name: 'Emma', accent: 'UK', gender: 'female', bytes: 522240, sha256: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73' },
  { id: 'am_fenrir', name: 'Fenrir', accent: 'US', gender: 'male', bytes: 522240, sha256: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43' },
  { id: 'am_michael', name: 'Michael', accent: 'US', gender: 'male', bytes: 522240, sha256: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1' },
  { id: 'am_puck', name: 'Puck', accent: 'US', gender: 'male', bytes: 522240, sha256: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0' },
  { id: 'bm_george', name: 'George', accent: 'UK', gender: 'male', bytes: 522240, sha256: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc' },
  { id: 'bm_fable', name: 'Fable', accent: 'UK', gender: 'male', bytes: 522240, sha256: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1' },
  { id: 'af_aoede', name: 'Aoede', accent: 'US', gender: 'female', bytes: 522240, sha256: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361' },
  { id: 'af_kore', name: 'Kore', accent: 'US', gender: 'female', bytes: 522240, sha256: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e' },
  { id: 'af_sarah', name: 'Sarah', accent: 'US', gender: 'female', bytes: 522240, sha256: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a' },
  { id: 'af_alloy', name: 'Alloy', accent: 'US', gender: 'female', bytes: 522240, sha256: 'c4a6b876047fd7fb472edf4ebd63cfac7c3b958a7cae7c106e8f038ca6308c45' },
  { id: 'af_nova', name: 'Nova', accent: 'US', gender: 'female', bytes: 522240, sha256: '18778272caa0d0eebaea251c35fd635f038434f9eee5e691d02a174bd328414f' },
  { id: 'af_sky', name: 'Sky', accent: 'US', gender: 'female', bytes: 522240, sha256: '4435255c9744f3f31659e0d714ab7689bf65d9e77ec1cce060f083912614f0b9' },
  { id: 'bf_isabella', name: 'Isabella', accent: 'UK', gender: 'female', bytes: 522240, sha256: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f' },
  { id: 'af_jessica', name: 'Jessica', accent: 'US', gender: 'female', bytes: 522240, sha256: 'a240a5e3c15b43563d6e923bdca8ef5613a23471d9b77653694012435df23bd8' },
  { id: 'af_river', name: 'River', accent: 'US', gender: 'female', bytes: 522240, sha256: '00a2bcf82b1d86e8f19902ede58c65ccf6c0e43b44b7d74fad54e5d8933c9c30' },
  { id: 'bf_alice', name: 'Alice', accent: 'UK', gender: 'female', bytes: 522240, sha256: '08afa6ba24da61ea5e8efa139e5aadc938d83f0a6da5a900adaf763ac1da5573' },
  { id: 'bf_lily', name: 'Lily', accent: 'UK', gender: 'female', bytes: 522240, sha256: '5e0ee32ebe64a467124976b14e69590746f1c4ce41a12b587a50c862edfea335' },
  { id: 'am_echo', name: 'Echo', accent: 'US', gender: 'male', bytes: 522240, sha256: '3968b92c3c4cd1c4416dbded36c13eaa388a90d5788d02a13e4d781f5f8cf3c3' },
  { id: 'am_eric', name: 'Eric', accent: 'US', gender: 'male', bytes: 522240, sha256: 'e8b5be17edd1e3636901ce7598baafe2dc8dd8ff707a0c23bf9e461add7e2832' },
  { id: 'am_liam', name: 'Liam', accent: 'US', gender: 'male', bytes: 522240, sha256: '52403be32fd047c6a44517cb0bcd6b134f2a18baa73e70ef41651e0eab921ade' },
  { id: 'am_onyx', name: 'Onyx', accent: 'US', gender: 'male', bytes: 522240, sha256: 'da5d135b424164916d75a68ffb4c2abce3d7d5ccc82dd1ee6cf447ce286145e6' },
  { id: 'am_adam', name: 'Adam', accent: 'US', gender: 'male', bytes: 522240, sha256: '162b035ed91cfc48b6046982184c645f72edcdd1b82843347f605d7bf7b15716' },
  { id: 'bm_lewis', name: 'Lewis', accent: 'UK', gender: 'male', bytes: 522240, sha256: 'b8f671cef828c30e66fdf0b0756a76bba58f6bb3398cbbf27058642acbcedb97' },
  { id: 'bm_daniel', name: 'Daniel', accent: 'UK', gender: 'male', bytes: 522240, sha256: '6b3194bbceffb746733cbc22c8f593dd44e401a71d53895a2dca891bc595a1e8' },
];

export const DEFAULT_BUILTIN_VOICE = BUILTIN_VOICES[0].id;

export function isBuiltinVoice(id: string): boolean {
  return BUILTIN_VOICES.some((v) => v.id === id);
}

function voiceKey(voiceId: string): string {
  return `${KOKORO_KEY_PREFIX}voices/${voiceId}.bin`;
}

/** Size of the one-time download, for the "Download (348 MB)" label. */
export function downloadBytes(): number {
  return CORE_FILES.reduce((n, f) => n + f.bytes, 0) + BUILTIN_VOICES[0].bytes;
}

export function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function isBuiltinVoiceInstalled(): Promise<boolean> {
  for (const file of CORE_FILES) {
    if (!(await idbHas(STORE_FILES, file.key))) return false;
  }
  return true;
}

/** The speech runtime alone (the translation models need it too). */
export function isRuntimeInstalled(): Promise<boolean> {
  return idbHas(STORE_FILES, ORT_WASM_KEY);
}

export function runtimeBytes(): number {
  return CORE_FILES[0].bytes;
}

/** Fetch the runtime when a translation model is downloaded before the voice. */
export async function ensureRuntime(onBytes: (received: number) => void, signal: AbortSignal): Promise<void> {
  if (await isRuntimeInstalled()) return;
  await downloadOne(CORE_FILES[0], onBytes, signal);
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class DownloadCancelled extends Error {
  constructor() {
    super('Download cancelled.');
  }
}

/** Large files are fetched in pieces of this size. */
const PIECE_BYTES = 16 * 1024 * 1024;

/**
 * Fetch one file with progress.
 *
 * Obsidian's requestUrl hands a response over only when it is complete, so a
 * large file is requested piece by piece (HTTP range requests). That gives the
 * progress bar something to show and lets a cancel take effect between pieces.
 */
async function fetchFile(
  url: string,
  expectedBytes: number,
  onBytes: (received: number) => void,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  if (expectedBytes <= PIECE_BYTES) {
    const whole = await requestUrl({ url, method: 'GET' });
    onBytes(whole.arrayBuffer.byteLength);
    return whole.arrayBuffer;
  }

  // One buffer of the known size, filled in place: collecting the pieces and
  // joining them afterwards would hold a large file in memory twice.
  const buffer = new Uint8Array(expectedBytes);
  let received = 0;
  while (received < expectedBytes) {
    if (signal.aborted) throw new DownloadCancelled();
    const last = Math.min(received + PIECE_BYTES, expectedBytes) - 1;
    const res = await requestUrl({ url, method: 'GET', headers: { Range: `bytes=${received}-${last}` }, throw: false });

    if (res.status === 200 && received === 0) {
      // The server ignored the range and sent everything at once.
      onBytes(res.arrayBuffer.byteLength);
      return res.arrayBuffer;
    }
    if (res.status !== 206) throw new Error(`Download failed (${res.status}) for ${url}`);

    const piece = new Uint8Array(res.arrayBuffer);
    if (piece.length === 0 || received + piece.length > expectedBytes) {
      throw new Error(`The server sent an unexpected amount of data for ${url}`);
    }
    buffer.set(piece, received);
    received += piece.length;
    onBytes(received);
  }
  if (signal.aborted) throw new DownloadCancelled();
  return buffer.buffer;
}

/** Fetch one file, check it, store it. Shared with the translation models. */
export async function downloadOne(
  file: VoiceFile | { key: string; url: string; bytes: number; sha256?: undefined },
  onBytes: (received: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const data = await fetchFile(file.url, file.bytes, onBytes, signal);
  if (file.sha256) {
    const actual = await sha256Hex(data);
    if (actual !== file.sha256) {
      throw new Error(`A downloaded file did not match its expected checksum (${file.key}). Please try again.`);
    }
  }
  await idbPut(STORE_FILES, file.key, data);
}

/**
 * Download everything the built-in voice needs. Files that are already there
 * are skipped, so an interrupted download continues where it stopped.
 */
export async function downloadBuiltinVoice(
  voiceId: string,
  onProgress: (receivedBytes: number, totalBytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const total = downloadBytes();
  let finished = 0;
  onProgress(0, total);

  for (const file of CORE_FILES) {
    if (signal.aborted) throw new DownloadCancelled();
    if (!(await idbHas(STORE_FILES, file.key))) {
      await downloadOne(file, (n) => onProgress(Math.min(total, finished + n), total), signal);
    }
    finished += file.bytes;
    onProgress(Math.min(total, finished), total);
  }
  await ensureVoiceFile(voiceId, signal);
  onProgress(total, total);
}

/** Each speaker is one small file (about 0.5 MB), fetched and checked the first time it is picked. */
export async function ensureVoiceFile(voiceId: string, signal?: AbortSignal): Promise<void> {
  const key = voiceKey(voiceId);
  if (await idbHas(STORE_FILES, key)) return;
  const voice = BUILTIN_VOICES.find((v) => v.id === voiceId);
  if (!voice) throw new Error(`Unknown speaker: ${voiceId}`);
  await downloadOne(
    { key, url: `${HF_BASE}voices/${voiceId}.bin`, bytes: voice.bytes, sha256: voice.sha256 },
    () => undefined,
    signal ?? new AbortController().signal,
  );
}

export async function removeBuiltinVoice(): Promise<void> {
  for (const key of await idbKeys(STORE_FILES)) {
    if (key === ORT_WASM_KEY || key.startsWith(KOKORO_KEY_PREFIX)) await idbDelete(STORE_FILES, key);
  }
}
