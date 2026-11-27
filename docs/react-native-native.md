# Running a native debug preview

Build and install the project's Debug app on a dedicated, booted Simulator or Emulator. The app supplies React Native, Metro and any native modules the preview uses. The runtime loads the project's Metro configuration and starts an isolated loopback server for the selected platform.

## Debug host integration

Install the two private packages `@prevue/react-native` and `@prevue/native-host` as local development dependencies from `plugin/rn-runtime/packages`. Put the debug bootstrap in a separate JS entry. For an embedded React Native screen, register a dedicated debug activity or view controller that mounts this root.

```js
import {AppRegistry} from 'react-native';
import PreviewHost from './.prevue/entry';

AppRegistry.registerComponent('PrevueNativeFixture', () => PreviewHost);
```

Select the debug JS entry from the native Debug build configuration. The release app uses its ordinary entry. On iOS, the launch environment variable `PREVUE_METRO_PORT` supplies the port for the debug bundle URL at `127.0.0.1`. On Android, the launch intent string extra `prevueMetroHost` supplies the debug server's `host:port`. The renderer opens two device-specific ADB reverse connections for Metro and the bridge, then removes them on shutdown. The included bare fixture has both native implementations.

Add `prevue.native.json` at the React Native package root and ignore `.prevue/` in Git. This example loads `index.preview.js`.

```json
{
  "ios": { "appId": "com.prevue.nativefixture", "entry": "index.preview" },
  "android": { "appId": "com.prevue.nativefixture", "activity": ".MainActivity", "entry": "index.preview" }
}
```

For a multi-display iOS Simulator, select the display containing the React Native root with the optional numeric `ios.display` field. `xcrun simctl io <UDID> enumerate` lists available displays on supporting Xcode versions. Apps using file-linked packages outside the app root must include those package directories in Metro's `watchFolders` and resolve React from the app's `node_modules`.

## Opening the preview

```sh
prevue rn doctor --platform ios --device "$SIMULATOR_UDID"
prevue rn show Shipment.preview.tsx --platform ios --device "$SIMULATOR_UDID"
prevue rn show Shipment.preview.tsx --platform android --device "$EMULATOR_SERIAL"
prevue rn focus 0 --on --platform ios
prevue rn render --platform ios
prevue rn stop --platform ios
```

Use `xcrun simctl list devices booted` or `adb devices` to obtain the identifier. Doctor reports the local package configuration, device tools and installed host readiness. On iOS it checks the installed bundle identifier. On Android it also checks the package's debuggable flag. Show verifies the debug bridge through a live React commit. It requires an explicit device and launches the configured application. A process-owned loopback socket leases each device across checkouts. An occupied lease port yields `NATIVE_DEVICE_BUSY`. The operating system releases the lease when the daemon exits.

The daemon writes `.prevue/entry.ios.js` or `.prevue/entry.android.js` with Metro-static module references, the global provider, a session token and the bundle revision. It reads Metro's file-change events before advancing this revision. The device acknowledges the command ID, session, preview ID and generation after a React commit and native view measurement. The daemon checks the bundle revision before and after capturing the native framebuffer and accessibility tree. A command timeout or failing bundle produces an error and preserves the last successful capture in the board. A connected host uses React Native Fast Refresh. If the active host has an older revision after refresh, it reloads its Metro bundle.

iOS capture uses `simctl io`. Install `idb` and `idb_companion` for accessibility inspection, taps, swipes and text input. Text input appends through the focused, non-secure field using idb's `ui set-value` action, including on non-Latin keyboard layouts. Accessibility frames and tap positions convert between screen points and raw screenshot pixels using the acknowledged screen dimensions. Android uses `adb exec-out screencap`, `uiautomator dump` and `input` on the selected Emulator. Android bounds and touch arguments are physical pixels. ADB text input supports printable ASCII. Native accessibility trees return `source: null` for unverified TSX source locations.

Interactive focus holds the physical display until the session closes. Reset remounts the selected preview and providers with its initial fixture. `NativePreviewSession.setArgs(props)` overrides the preview's initial props until the next reset. The captured image uses the device's physical viewport, native insets and system appearance. Changes to native sources, Pods, Gradle inputs or package manifests yield `NATIVE_BUILD_REQUIRED`. Rebuild and reinstall the debug host, then restart the preview daemon. Project credentials and application state should be provided explicitly by debug-only providers and fixtures.

On Android each frame reads the full UI Automator hierarchy after the screenshot. The renderer streams the XML through `adb exec-out uiautomator dump /dev/fd/1`, waits for the tool's confirmation after accessibility disconnects, then parses the tree. Android's normal idle wait still applies. The remaining ADB process teardown finishes in the background, and shutdown waits for it before releasing the device. Images that cannot stream the dump use a fresh temporary file on the device. [Android DumpCommand](https://android.googlesource.com/platform/frameworks/base/+/2940697c9c7d6edecc9ce1d14d9945d92139bf4e/cmds/uiautomator/cmds/uiautomator/src/com/android/commands/uiautomator/DumpCommand.java)
