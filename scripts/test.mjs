// Unit tests: bundle each tests/unit/*.test.ts for Node and run it with the
// built-in test runner. Obsidian and the worker bundle are replaced by stubs,
// so only the plugin's own logic is under test.
import esbuild from "esbuild";
import { readdirSync, rmSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".test-build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out);

const tests = readdirSync(path.join(root, "tests", "unit")).filter((f) => f.endsWith(".test.ts"));
await esbuild.build({
	absWorkingDir: root,
	entryPoints: tests.map((f) => path.join("tests", "unit", f)),
	outdir: out,
	outExtension: { ".js": ".mjs" },
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	logLevel: "error",
	alias: { obsidian: path.join(root, "tests", "unit", "obsidian-stub.ts") },
	// Build-time facts about the speech runtime; irrelevant to these tests.
	define: { __ORT_VERSION__: '"test"', __ORT_WASM_FILE__: '"test.wasm"', __ORT_WASM_SHA256__: '""', __ORT_WASM_BYTES__: "0" },
	plugins: [{
		name: "stub-worker",
		setup(build) {
			build.onResolve({ filter: /^virtual:tts-worker$/ }, () => ({ path: "tts-worker", namespace: "stub" }));
			build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: 'export default "";', loader: "js" }));
		},
	}],
});

const files = readdirSync(out).filter((f) => f.endsWith(".mjs")).map((f) => path.join(out, f));
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
