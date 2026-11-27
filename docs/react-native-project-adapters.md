# Project adapters

## Expo Metro web

The opt-in entry is a development file in the Expo project. Point `prevue.expo.json` at it and statically import each preview module. Keep the production entry in the project's package manifest.

```json
{ "entry": "ExpoPreviews.js" }
```

```js
import { registerExpoPreviews } from '@prevue/react-native/metro-web';
import * as cards from './MetroCard.preview';
registerExpoPreviews({ 'MetroCard.preview.tsx': cards });
```

The adapter invokes the project's Expo CLI to build a web bundle using its Metro configuration. The browser runs that bundle in an isolated context and acknowledges the requested preview and generation after a React commit. Multiple cards share one bundle for a source revision. Source saves build a fresh bundle and remount the preview. A missing entry, failed build or missing registration is an error. The fixture uses Expo SDK 54.0.38, React 19.1.0, RN 0.81.5 and RN Web 0.21.4. Other Expo SDKs and Expo Router screen bootstrapping require separate verification.

From the repository checkout:

```sh
npm ci --prefix fixtures/react-native-expo
plugin/bin/prevue rn show fixtures/react-native-expo/MetroCard.preview.tsx --platform web
```

If the local SDK is symlinked, Metro needs its real directory in watchFolders. The fixture's metro.config.js also resolves React from the app's node_modules.

## Storybook CSF

The Vite adapter discovers named exports in *.stories.tsx and *.stories.jsx without executing the file. During rendering it merges default meta args and named story args, then invokes the story render, meta render or meta component. Unknown annotations, decorators, parameters, play functions and render context return an explicit error. The verified subset covers CSF objects with default meta, named stories, scalar/object args and render(args). Native and Expo story rendering require a dedicated adapter.

## Local native-module mocks

Place exact module names and development-only replacements in `prevue.web.json` in the project root. Restart the web preview server after changing the mapping. The target must resolve inside the selected project.

```json
{ "mocks": { "rn.device": "./mocks/device.ts" } }
```

The renderer resolves project React, React DOM and RN Web once. TypeScript path aliases and .web variants are covered by the Chromium tests. The renderer's browser blocks external requests. Supply fixture data to production-style components and explicit providers when needed.
