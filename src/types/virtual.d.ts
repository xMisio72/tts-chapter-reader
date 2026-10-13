/** The TTS worker, bundled into one string (see esbuild.config.mjs). */
declare module 'virtual:tts-worker' {
  const source: string;
  export default source;
}

/** The speech runtime's loader module as text (see scripts/worker-build.mjs). */
declare module 'virtual:ort-loader' {
  const source: string;
  export default source;
}

/** Facts about the runtime binary the worker was built against. */
declare const __ORT_VERSION__: string;
declare const __ORT_WASM_FILE__: string;
declare const __ORT_WASM_SHA256__: string;
declare const __ORT_WASM_BYTES__: number;
