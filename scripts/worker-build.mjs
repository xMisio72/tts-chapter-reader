import esbuild from "esbuild";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ortDist = path.join(root, "node_modules", "onnxruntime-web", "dist");

// The speech runtime comes in two builds: plain WebAssembly (CPU only) and one
// that also carries the WebGPU backend. ORT_FLAVOR picks which one the worker is
// built against; the plugin downloads the matching binary.
const FLAVOR = process.env.ORT_FLAVOR === "cpu" ? "cpu" : "gpu";
const ORT_FILES = FLAVOR === "cpu"
	? { entry: "ort.wasm.bundle.min.mjs", loader: "ort-wasm-simd-threaded.mjs", wasm: "ort-wasm-simd-threaded.wasm" }
	: { entry: "ort.webgpu.bundle.min.mjs", loader: "ort-wasm-simd-threaded.jsep.mjs", wasm: "ort-wasm-simd-threaded.jsep.wasm" };
const ORT_ENTRY = path.join(ortDist, ORT_FILES.entry);
const ORT_LOADER = path.join(ortDist, ORT_FILES.loader);
const ORT_WASM = path.join(ortDist, ORT_FILES.wasm);

/**
 * Facts about the runtime binary this worker is built against. The plugin
 * downloads exactly this file on the user's request and verifies the hash.
 */
export function runtimeInfo() {
	const pkg = JSON.parse(readFileSync(path.join(root, "node_modules", "onnxruntime-web", "package.json"), "utf8"));
	const wasm = readFileSync(ORT_WASM);
	return {
		version: pkg.version,
		file: ORT_FILES.wasm,
		sha256: createHash("sha256").update(wasm).digest("hex"),
		bytes: wasm.length,
	};
}

// Obsidian runs on Electron, where even a web worker sees Node.js globals
// (process, require, ...). The speech libraries take that to mean "this is
// Node" and look for native modules that do not exist. Removing the globals
// from the worker's own scope makes them behave as in any browser. Nothing
// outside the worker is touched. The runtime loader is a separate module that
// also starts the runtime's helper threads, so it carries the same shield.
const NODE_GLOBALS = ["process", "require", "module", "exports", "Buffer", "global", "__dirname", "__filename"];
const NODE_SHIELD = `for (const k of ${JSON.stringify(NODE_GLOBALS)}) { try { delete globalThis[k]; } catch (e) {} try { if (globalThis[k] !== undefined) globalThis[k] = undefined; } catch (e) {} }
`;

const ortLoaderAsText = {
	name: "ort-loader-as-text",
	setup(build) {
		build.onResolve({ filter: /^virtual:ort-loader$/ }, () => ({ path: ORT_LOADER, namespace: "ort-loader" }));
		build.onLoad({ filter: /.*/, namespace: "ort-loader" }, () => ({
			contents: `export default ${JSON.stringify(NODE_SHIELD + readFileSync(ORT_LOADER, "utf8"))};`,
			loader: "js",
		}));
	},
};

/** Bundle the TTS worker into one string of JavaScript. */
export async function buildWorker({ minify }) {
	const result = await esbuild.build({
		absWorkingDir: root,
		entryPoints: ["src/worker/tts.worker.ts"],
		bundle: true,
		write: false,
		format: "iife",
		platform: "browser",
		target: "es2022",
		minify,
		legalComments: "none",
		logLevel: "error",
		alias: { "onnxruntime-web": ORT_ENTRY },
		plugins: [ortLoaderAsText],
		// Classic workers have no import.meta; the runtime only uses it to find
		// files next to itself, and every file is handed to it explicitly.
		define: { "import.meta.url": '""' },
	});
	return `${NODE_SHIELD}(function(${NODE_GLOBALS.join(",")}){
${result.outputFiles[0].text}
})();`;
}

// `node scripts/worker-build.mjs <outfile>` writes the worker for test harnesses.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const { writeFileSync } = await import("fs");
	const code = await buildWorker({ minify: true });
	writeFileSync(process.argv[2], code);
	console.log(`worker: ${code.length} bytes -> ${process.argv[2]}`);
}
