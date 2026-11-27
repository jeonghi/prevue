# React Native compatibility

Verified on Apple Silicon, macOS 27.2.1. The screenshots under `assets/react-native` were produced from the fixtures in this fork.

| Target | Evidence | Scope |
| --- | --- | --- |
| React Native Web | OrderCard Default, Loading and Error PNGs in the existing board | React 19.2.0, RN 0.82.1, RN Web 0.21.4, Vite 6.4.6, Playwright Chromium |
| Web interaction | Press, type Korean text, scroll, reset; committed tree and image | One isolated browser context per interactive preview; physical screenshot pixels |
| Web source inspection | Selected OrderCard Pressable and its actual TSX location | Directly imported RN primitives whose source marker reached the DOM. Unknown sources stay null |
| iOS simulator | Actual device PNG and accessibility hierarchy, 1398 × 2034 | Installed, explicitly configured Debug Host on iOS 27.2. Source lookup in its accessibility tree is unavailable |
| Android emulator | Actual device PNG and UI Automator hierarchy, 1080 × 2400 | Installed Debug Host on API 36, explicit ADB serial |
| Bare RN | RN 0.82.1 Debug Host and web-compatible component fixtures | Third-party native modules require the project-specific host build |
| Monorepo | npm and pnpm workspace discovery tests; linked workspace component rendered by Chromium | Select the intended app when multiple packages qualify. Sources outside the selected project have no Inspector file link |
| Compose | 761 JVM unit tests, 107 integration tests, actual AdaptivePearlPreview PNG, CLI tests, 19 quick-open checks, 37 workspace checks and 19 resize-content checks in Chrome | Existing Kotlin runtime and installed viewer assets |

Device screenshots use the actual device dimensions and appearance. Expo, Storybook and embedded app verification are described in their respective adapter branches. No public npm package is required. Package manifests and lockfiles belong to the fork's development packages and fixtures.

## Licenses

The original Apache-2.0 license and NOTICE remain in the root and plugin. Direct runtime packages Vite, its React plugin, Babel, Chokidar, tsx and vite-tsconfig-paths declare MIT; Playwright and TypeScript declare Apache-2.0; yaml declares ISC. The web fixture's React, React DOM, React Native and React Native Web declare MIT. Dependencies are installed from their pinned lockfiles with their original license files. The native fixture retains the React Native Community template license.
