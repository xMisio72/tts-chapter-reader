# Contributing

Thanks for taking a look. Bug reports, ideas and pull requests are welcome.

## Reporting a problem

Open an issue with:

- what you did, what you expected, what happened
- your operating system and Obsidian version
- the voice in use (natural voice, system voice, own server, OpenAI, Gemini) and, for the natural voice, whether it runs on the graphics card or the processor (Settings → TTS Chapter Reader → Run on)
- anything from the developer console (Ctrl+Shift+I → Console) that mentions `tts-chapter-reader`

Please do not paste API keys.

## Building

```sh
npm install
npm run build        # type-check + bundle main.js
npm run dev          # rebuild on change
npm run lint         # eslint with the Obsidian plugin rules (0 errors expected)
npm test             # unit tests (tests/unit)
```

To try a build in a vault: `node scripts/deploy.mjs "<path to vault>"`, then reload the plugin in Obsidian (disable and enable it, or Ctrl+R).

The end-to-end suite drives the plugin inside a running Obsidian through its command-line interface (Settings → General → Command line interface). It needs a vault registered as `demo-vault` with the plugin enabled and the natural voice downloaded:

```sh
npm run e2e
```

Audio plays through the speakers while it runs.

## Code

- TypeScript, Preact for the player, a web worker for the natural voice (`src/worker`).
- Keep settings and wording plain. The yardstick for every change: a new user should get from install to listening without opening the settings.
- Text strings in the UI are English, sentence case.
- Run `npm run lint` and `npm test` before a pull request. The community directory rebuilds `main.js` from the repository and compares it byte for byte with the release, so do not hand-edit `main.js`.

## Releasing (maintainer)

1. Bump the version in `manifest.json`, `versions.json` and `package.json` (same number, no "v").
2. Commit and push, then push a tag with that version: `git tag 1.2.3 && git push origin 1.2.3`.
3. The release workflow builds `main.js`, attests the artifacts and creates the GitHub release with `main.js`, `manifest.json` and `styles.css`.
4. The community directory scans the new release on its own.

## License

AGPL-3.0. By contributing you agree that your contribution is licensed the same way.
