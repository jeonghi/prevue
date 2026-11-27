# Running the RN preview

From the checkout install the optional runtime and the demo project's own dependencies.

```sh
npm ci --prefix plugin/rn-runtime
npm ci --prefix fixtures/react-native-web
(cd plugin/rn-runtime && npx playwright install chromium)
cd fixtures/react-native-web
../../plugin/bin/prevue rn doctor
../../plugin/bin/prevue rn show OrderCard.preview.tsx --platform web --lang ko
../../plugin/bin/prevue rn open --lang ko
```

Use the private viewer URL printed by show or open in the browser on the same computer. Keep that URL out of public bug reports. Working in a different directory is supported with `--project <path>`. Dependencies and the Chromium installation are explicit. A Compose-only checkout uses the existing Compose setup.

The board returns an array of local image paths, preview IDs, generation numbers and status. Focus selects a zero-based index and creates a fresh interactive session. Screenshot coordinates use image pixels. Read the PNG, edit the TSX, then call wait with the saved file. For an unambiguous save barrier, read the current generation before editing and pass it to wait.

```sh
../../plugin/bin/prevue rn board
../../plugin/bin/prevue rn wait OrderCard.tsx --after 1 --timeout 30
../../plugin/bin/prevue rn focus 0 --on
../../plugin/bin/prevue rn render
../../plugin/bin/prevue rn touch 120 140
../../plugin/bin/prevue rn scroll --direction down
../../plugin/bin/prevue rn type "부산"
../../plugin/bin/prevue rn reset
../../plugin/bin/prevue rn selection
../../plugin/bin/prevue rn stop
```

Every command accepts --help. Exit codes are 0 for success, 1 for an unsuccessful render, input, selection or wait, 2 for invalid arguments and 3 for an unavailable project or runtime. Commands return JSON, including structured code and message on errors. Project and platform determine the cache, PID, log and server. Use `rn log` for startup diagnostics.
