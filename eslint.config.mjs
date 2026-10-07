// Lints the plugin with Obsidian's own rules (the same family of checks the
// community-plugin review runs), so problems show up here first.
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	{ ignores: ["main.js", "node_modules/**", "scripts/**", "tests/**", "demo-vault/**", "esbuild.config.mjs", "version-bump.mjs", "eslint.config.mjs", ".test-build/**"] },
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts", "src/**/*.tsx"],
		languageOptions: {
			parser: tsparser,
			parserOptions: { project: "./tsconfig.json" },
			// Values esbuild fills in at build time (see esbuild.config.mjs).
			globals: {
				__ORT_VERSION__: "readonly",
				__ORT_WASM_FILE__: "readonly",
				__ORT_WASM_SHA256__: "readonly",
				__ORT_WASM_BYTES__: "readonly",
			},
		},
		rules: {
			"obsidianmd/ui/sentence-case": [
				"warn",
				{ brands: ["OpenAI", "Kokoro", "Kokoro-FastAPI", "Google", "Gemini", "Google Gemini", "Google AI Studio", "Knowledge Tracker", "Daily Priming", "Obsidian", "English", "EN", "MP3"] },
			],
			// The settings page is written with display(), which works on every
			// supported Obsidian version (1.11.4+). The declarative API that
			// replaces it only exists from 1.13.0.
			"obsidianmd/settings-tab/prefer-setting-definitions": "off",
		},
	},
]);
