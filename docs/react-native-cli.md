# Running the RN preview

## Installed plugin

Use Node 22.12 or later. Set `PREVUE` to the installed plugin directory containing `bin/prevue`. Claude Code exposes it as `${CLAUDE_PLUGIN_ROOT}`. In Codex it is three directories above the directory containing the installed `skills/codex/prevue/SKILL.md`.

```sh
(cd "$PREVUE/rn-runtime" && npm ci)
"$PREVUE/rn-runtime/node_modules/.bin/playwright" install chromium
cd /path/to/react-native-app
"$PREVUE/bin/prevue" rn doctor
"$PREVUE/bin/prevue" rn show OrderCard.preview.tsx --platform web
```

The project supplies its React, React DOM and React Native Web packages. The private preview SDK is shipped in `$PREVUE/rn-runtime/packages/react-native`. For Metro and TypeScript, add a project-owned copy of that package as a local development dependency with the app’s package manager. A native Debug Host also uses the bundled `packages/native-host` package.

## Write a preview

Place a named `definePreview` export in a sibling `*.preview.tsx` or `*.preview.jsx` file. Discovery reads the declarations with the TypeScript compiler. The renderer evaluates the selected module when the board opens. The OrderCard fixture uses local shipment data.

```tsx
import { definePreview } from '@prevue/react-native';
import { OrderCard, sampleOrder } from './OrderCard';

export const Default = definePreview({
  viewport: { width: 360, height: 320 },
  render: () => <OrderCard order={sampleOrder} />,
});
```

Add another named export for each state. A default export in `prevue.providers.tsx` supplies a project-wide provider. Each definition can supply its own `provider`, `props` and `theme`. The included [OrderCard file](../fixtures/react-native-web/OrderCard.preview.tsx) has three states and its [theme provider](../fixtures/react-native-web/prevue.providers.tsx) runs for all three.

## Repository demo

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

## Compare a design with the selected element

For example, if a supplied design specifies a 56 px detail button at scale 1, open `Default` and click “상세 보기.” `rn selection` returns `testId: order-detail`, the bounds and `OrderCard.tsx` at the `Pressable` declaration. This fixture starts at 282 × 43. Record the current generation, change the button minimum height from 43 to 56 and run `rn wait OrderCard.tsx --after <generation>`. Match `imageGeneration` to the returned generation, then read the new bounds and PNG. The [browser selection test](../tests/react-native/selection.e2e.mjs) performs that edit and checks both the height and the changed pixels.
