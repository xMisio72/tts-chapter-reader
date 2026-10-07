// Copy the built plugin into one or more vaults:
//   node scripts/deploy.mjs "C:/path/to/vault" ["C:/path/to/another vault" ...]
// Obsidian only loads main.js, manifest.json and styles.css from the plugin
// folder, so those three files are the whole install.
import { copyFileSync, mkdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { id } = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const vaults = process.argv.slice(2);
if (vaults.length === 0) {
	console.error("Usage: node scripts/deploy.mjs <vault folder> [more vault folders]");
	process.exit(1);
}
for (const vault of vaults) {
	const target = path.join(vault, ".obsidian", "plugins", id);
	mkdirSync(target, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(path.join(root, file), path.join(target, file));
	}
	console.log(`deployed ${id} -> ${target}`);
}
