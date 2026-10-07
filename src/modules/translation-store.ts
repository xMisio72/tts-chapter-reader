import { idbDelete, idbHas, idbKeys, STORE_FILES } from '../shared/idb';
import { MODEL_KEY_PREFIX, modelFileKey } from '../shared/protocol';
import { DownloadCancelled, downloadOne, ensureRuntime, isRuntimeInstalled, runtimeBytes } from './builtin-voice';
import { TRANSLATION_MODELS, TranslationModel } from './translation-models';

/**
 * The downloaded translation models: which language has one, fetching one
 * (pinned version, checksums, progress, cancel) and removing it again.
 *
 * Like the voice, nothing is fetched until the user clicks, and the files
 * live in the app's database outside the vault.
 */

const MEGABYTE = 1024 * 1024;

/** The model for a language, or the many-languages model when there is none. */
export function modelForLanguage(lang: string): TranslationModel {
  return TRANSLATION_MODELS.find((m) => m.lang === lang) ?? TRANSLATION_MODELS.find((m) => m.lang === 'mul')!;
}

export function modelBytes(model: TranslationModel): number {
  return model.files.reduce((n, f) => n + f.bytes, 0);
}

export async function isModelInstalled(model: TranslationModel): Promise<boolean> {
  for (const file of model.files) {
    if (!(await idbHas(STORE_FILES, modelFileKey(model.repo, file.path)))) return false;
  }
  return true;
}

export async function installedModels(): Promise<TranslationModel[]> {
  const out: TranslationModel[] = [];
  for (const model of TRANSLATION_MODELS) {
    if (await isModelInstalled(model)) out.push(model);
  }
  return out;
}

export async function removeModel(model: TranslationModel): Promise<void> {
  const prefix = `${MODEL_KEY_PREFIX}${model.repo}/`;
  for (const key of await idbKeys(STORE_FILES)) {
    if (key.startsWith(prefix)) await idbDelete(STORE_FILES, key);
  }
}

async function downloadModel(
  model: TranslationModel,
  onProgress: (receivedBytes: number, totalBytes: number) => void,
  signal: AbortSignal,
): Promise<void> {
  // Without the voice the speech runtime is missing too; it is part of this download then.
  const needsRuntime = !(await isRuntimeInstalled());
  const total = modelBytes(model) + (needsRuntime ? runtimeBytes() : 0);
  let finished = 0;
  onProgress(0, total);
  if (needsRuntime) {
    await ensureRuntime((n) => onProgress(Math.min(total, n), total), signal);
    finished += runtimeBytes();
  }
  for (const file of model.files) {
    if (signal.aborted) throw new DownloadCancelled();
    const key = modelFileKey(model.repo, file.path);
    if (!(await idbHas(STORE_FILES, key))) {
      const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.path}`;
      await downloadOne({ key, url, bytes: file.bytes, sha256: file.sha256 }, (n) => onProgress(Math.min(total, finished + n), total), signal);
    }
    finished += file.bytes;
    onProgress(Math.min(total, finished), total);
  }
}

/**
 * One download at a time, shared by the dialog and the settings page so both
 * show the same progress and either can cancel it.
 */
export class ModelDownload {
  running: TranslationModel | null = null;
  received = 0;
  total = 0;
  error: string | null = null;

  private controller: AbortController | null = null;
  private current: Promise<boolean> | null = null;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** Resolves true once the model is installed, false if cancelled or failed. */
  start(model: TranslationModel): Promise<boolean> {
    if (this.current) return this.current;
    this.running = model;
    this.received = 0;
    this.total = modelBytes(model);
    this.error = null;
    this.controller = new AbortController();
    this.emit();

    this.current = downloadModel(
      model,
      (received, total) => {
        const before = Math.floor(this.received / MEGABYTE);
        this.received = received;
        this.total = total;
        if (Math.floor(received / MEGABYTE) !== before || received === total) this.emit();
      },
      this.controller.signal,
    ).then(
      () => true,
      (e: unknown) => {
        if (!(e instanceof DownloadCancelled)) {
          console.error('TTS Chapter Reader: translation model download failed.', e);
          this.error = e instanceof Error ? e.message : String(e);
        }
        return false;
      },
    ).then((ok) => {
      this.running = null;
      this.controller = null;
      this.current = null;
      this.emit();
      return ok;
    });
    return this.current;
  }

  cancel(): void {
    this.controller?.abort();
  }

  get percent(): number {
    return this.total > 0 ? Math.round((this.received / this.total) * 100) : 0;
  }
}
