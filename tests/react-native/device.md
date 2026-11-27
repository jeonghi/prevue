# React Native device verification

`fixtures/react-native-bare` builds a React Native 0.82.1 application with Fabric and Hermes. The shipment preview contains a pressable dispatch action, a controlled text field, a receipt and a scrollable route. The debug entry mounts the Prevue host. The release entry is `index.js`.

Run the commands from the repository root. Choose a dedicated booted Simulator or Emulator. Set `IOS_UDID` to its Simulator UDID or `ANDROID_SERIAL` to its adb serial. The renderer holds an exclusive device lease while it is running.

```sh
npm --prefix plugin/rn-runtime ci
npm --prefix fixtures/react-native-bare ci
```

## iOS Simulator

Install Xcode, CocoaPods, `idb` and `idb_companion`. `idb ui describe-all --udid "$IOS_UDID" --json` must be able to read the selected simulator for the interaction checks. The Podfile uses the prebuilt React Native core. Open the generated workspace when building in Xcode.

```sh
(cd fixtures/react-native-bare/ios && pod install)
xcodebuild -workspace fixtures/react-native-bare/ios/PrevueNativeFixture.xcworkspace \
  -scheme PrevueNativeFixture -configuration Debug \
  -destination "platform=iOS Simulator,id=$IOS_UDID" \
  -derivedDataPath .cache/prevue-native-ios build
xcrun simctl install "$IOS_UDID" \
  .cache/prevue-native-ios/Build/Products/Debug-iphonesimulator/PrevueNativeFixture.app
node tests/react-native/device.mjs ios "$IOS_UDID"
node tests/react-native/device.mjs ios "$IOS_UDID" --refresh
```

The fixture selects display `1` for the iPhone Duo primary screen. For another simulator, omit the `display` property in `prevue.native.json` to use the device default, or choose a display ID reported by `simctl io`. `PREVUE_METRO_PORT` reaches the application through `simctl launch` at runtime.

## Android Emulator

Install the Android SDK platform 36, build tools 36.0.0, NDK 27.1.12297006, CMake and a supported JDK. Set `ANDROID_HOME` and include its `platform-tools` directory on `PATH`. The Gradle wrapper builds one ABI for the selected emulator.

```sh
ABI="$(adb -s "$ANDROID_SERIAL" shell getprop ro.product.cpu.abi | tr -d '\r')"
(cd fixtures/react-native-bare/android && ./gradlew :app:assembleDebug "-PreactNativeArchitectures=$ABI")
adb -s "$ANDROID_SERIAL" install -r \
  fixtures/react-native-bare/android/app/build/outputs/apk/debug/app-debug.apk
node tests/react-native/device.mjs android "$ANDROID_SERIAL"
node tests/react-native/device.mjs android "$ANDROID_SERIAL" --refresh
```

The renderer passes the fixture's explicit debug activity a loopback Metro address and installs a pair of temporary `adb reverse` mappings on the selected device. Android text dispatch uses adb's printable ASCII input. The keyboard and full device chrome are part of native captures.

## Evidence

The harness opens the client through `plugin/bin/prevue rn`, reads real PNG headers and accessibility hierarchies, and checks the same preview and generation in the response. It measures five warm foreground `render` commands. `elapsedMs` includes CLI startup, device capture, tree extraction and IPC. `captureMs` comes from the renderer. It checks coordinate selection, tap, typing, scrolling and reset by comparing accessible text or element bounds.

To reproduce the Android latency check, keep the emulator booted with the same installed Debug build, project and Metro cache for both revisions. Select each revision's CLI with `PREVUE_BIN` and use separate output directories. Each timed frame must contain a new PNG and tree with the shipment text and dispatch button. The report includes each sample and the nearest-rank CLI P50/P95. The command fails if the CLI P50 exceeds the budget.

```sh
node tests/react-native/device.mjs android "$ANDROID_SERIAL" \
  --warm-runs 15 --max-warm-p50-ms 2000 --output .cache/android-warm/after
```

For a byte-for-byte device reference, open a shipment preview, focus it and let the screen settle. The checker captures the framebuffer again when the renderer writes the next PNG. It also compares the entire tree with an independent UI Automator dump to a regular file. Run it again after a tap, text input, reset or scroll to check that state.

```sh
plugin/bin/prevue rn show fixtures/react-native-bare/Shipment.preview.tsx --platform android --device "$ANDROID_SERIAL"
plugin/bin/prevue rn focus 0 --on --project fixtures/react-native-bare --platform android
plugin/rn-runtime/node_modules/.bin/tsx tests/react-native/android-reference.mts "$ANDROID_SERIAL" fixtures/react-native-bare
plugin/bin/prevue rn stop --project fixtures/react-native-bare --platform android
```

`--refresh` creates its own temporary preview under the fixture, edits the TSX, introduces a syntax error, verifies the stale image generation and saves a working revision. It removes the temporary preview and shuts down the platform session on completion. Native source or dependency changes require rebuilding and reinstalling the debug host.

The default evidence directory is `.cache/react-native-device/<platform>`. Pass `--output path` to keep screenshots, UI trees and JSON timing reports elsewhere. Each harness invocation uses the selected project/platform session and stops it at the end. `PREVUE_BIN` can select the full path to another checkout's `plugin/bin/prevue`.

`--build-change` adds and removes a temporary native source input and asserts `NATIVE_BUILD_REQUIRED` with the last valid image. Run this check last. Rebuild and reinstall the fixture before opening another session on that device.
