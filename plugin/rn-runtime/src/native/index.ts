import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { watch, type FSWatcher } from 'chokidar';
import { PreviewFailure } from '../errors.ts';
import { atomicWrite, location } from '../instance.ts';
import type { Capabilities, ProjectContext, PreviewRenderer, PreviewSession, RenderRequest, RenderResult } from '../protocol.ts';
import { startBridge, type NativeCommand, type Screen } from './bridge.ts';
import { openDevice, parseConfig, type NativeConfig } from './device.ts';
import { acquireDevice } from './lease.ts';
import { startMetro, writeEntry } from './metro.ts';

const buildOutputs = new Set(['node_modules', '.git', '.prevue', '.gradle', 'build', 'Pods', 'DerivedData', '.cache']);
const nativeManifests = new Set([
  'Podfile', 'Podfile.lock', 'package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  'gradle.properties', 'gradle-wrapper.properties', 'libs.versions.toml', 'AndroidManifest.xml',
  'CMakeLists.txt', 'app.json', 'app.config.js', 'app.config.ts',
]);
export function nativeBuildInput(file: string, platform?: 'ios' | 'android') {
  const parts = file.split(/[\\/]/);
  if (platform === 'ios' && parts[0] === 'android' || platform === 'android' && parts[0] === 'ios') return false;
  if (parts.some(part => buildOutputs.has(part))) return false;
  const name = parts.at(-1) ?? '';
  return nativeManifests.has(name) || /\.(?:swift|[chm]|mm|cc|cpp|hpp|cxx|kt|java|gradle(?:\.kts)?|pbxproj|podspec(?:\.json)?|xcconfig|plist|entitlements|storyboard|xib)$/.test(name);
}

async function requireBundle(port: number, platform: string, entry: string, revision: string, signal: AbortSignal) {
  const url = `http://127.0.0.1:${port}/${entry}.bundle?platform=${platform}&dev=true&minify=false`;
  const deadline = Date.now() + 90_000;
  for (;;) {
    const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
    const contents = await response.text();
    if (!response.ok) {
      let message = contents.slice(0, 3000);
      try { message = JSON.parse(contents).message ?? message; } catch { /* Metro may return plain text */ }
      throw new PreviewFailure('NATIVE_BUNDLE_FAILED', message);
    }
    if (contents.includes(revision)) return;
    if (Date.now() >= deadline) throw new PreviewFailure('NATIVE_BUNDLE_MISMATCH', 'The selected Metro entry did not import this session’s .prevue/entry.');
    await delay(150, undefined, { signal });
  }
}

export interface NativePreviewSession extends PreviewSession {
  setArgs(props: Record<string, unknown>): Promise<void>;
}
export function createNativeRenderer(): Omit<PreviewRenderer, 'openSession'> & {
  openSession(request: RenderRequest): Promise<NativePreviewSession>;
} {
  const capabilities: Capabilities = { screenshot: true, interactiveInput: true, uiTree: true, sourceLocation: false,
    viewportResize: false, themeOverride: false, nativeInsets: true, animationFrameControl: false, stateReset: true };
  let context: ProjectContext, platform: 'ios' | 'android', config: NativeConfig;
  let bridge: Awaited<ReturnType<typeof startBridge>>, device: Awaited<ReturnType<typeof openDevice>>,
    metro: Awaited<ReturnType<typeof startMetro>>, release: (() => Promise<void>) | undefined;
  let watcher: FSWatcher | undefined, cleanEntry: (() => Promise<void>) | undefined;
  let live: NativePreviewSession | undefined, revision = randomUUID(), closed = false, boardCapturing = false;
  let bundle: Promise<void> | undefined, rebuild: string | undefined, refreshError: unknown, marker: string;
  let sourceGeneration = new AbortController();
  let writes: Promise<void> = Promise.resolve();
  function invalidate(file: string) {
    if (closed) return;
    sourceGeneration.abort(new PreviewFailure('STALE_RENDER', 'A newer Metro source revision superseded this bundle.'));
    sourceGeneration = new AbortController();
    bridge.invalidate();
    revision = randomUUID();
    bundle = undefined;
    const next = revision;
    writes = writes.then(async () => {
      try {
        if (rebuild) await atomicWrite(marker, JSON.stringify({ installed: device.installed, file: rebuild }));
        else cleanEntry = await writeEntry(context.root, platform, next, bridge.endpoint, bridge.token);
        refreshError = undefined;
      } catch (error) { refreshError = error; }
      if (!closed) context.changed(file);
    });
  }
  async function dispose() {
    if (closed) return;
    closed = true;
    sourceGeneration.abort();
    await watcher?.close();
    await writes;
    bridge?.close();
    try { await metro?.close(); }
    finally {
      try { await device?.close(); await cleanEntry?.(); }
      finally { await release?.(); release = undefined; }
    }
  }
  async function prepare(input: ProjectContext) {
    context = input;
    if ((input.platform !== 'ios' && input.platform !== 'android') || !input.device) {
      throw new PreviewFailure('NATIVE_DEVICE_REQUIRED', 'Pass --device with an explicit iOS Simulator UDID or Android Emulator serial.');
    }
    platform = input.platform;
    const configFile = path.join(input.root, 'prevue.native.json');
    const text = await readFile(configFile, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error;
      throw new PreviewFailure('NATIVE_HOST_REQUIRED', 'Set up an opted-in Debug host and prevue.native.json before rendering natively.');
    });
    config = parseConfig(JSON.parse(text), platform);
    try {
      release = await acquireDevice(platform, input.device);
      device = await openDevice(platform, input.device, config);
      capabilities.interactiveInput = capabilities.uiTree = device.input;
      const store = location(input.root, platform).dir;
      await mkdir(store, { recursive: true, mode: 0o700 });
      marker = path.join(store, 'native-build-' + encodeURIComponent(input.device) + '.json');
      const pending = await readFile(marker, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (pending) {
        const stamp = JSON.parse(pending);
        if (stamp.installed === device.installed) throw new PreviewFailure('NATIVE_BUILD_REQUIRED', 'Rebuild and reinstall the debug host after changing ' + stamp.file);
        await rm(marker);
      }
      bridge = await startBridge(platform);
      cleanEntry = await writeEntry(input.root, platform, revision, bridge.endpoint, bridge.token);
      metro = await startMetro(input.root, path.join(store, 'metro-cache'), file => {
        if (/\.[mc]?[jt]sx?$|\.(?:png|jpe?g|svg|webp|json|ttf|otf)$/.test(file) && !nativeBuildInput(path.relative(input.root, file), platform)) invalidate(file);
      });
      watcher = watch(input.root, { ignoreInitial: true, ignored: (file, info) =>
        file.split(path.sep).some(part => buildOutputs.has(part)) ||
        !!info?.isFile() && !nativeBuildInput(path.relative(input.root, file), platform) });
      watcher.on('all', (event, file) => {
        const relative = path.relative(input.root, file);
        if (event !== 'addDir' && event !== 'unlinkDir' && nativeBuildInput(relative, platform)) { rebuild = relative; invalidate(file); }
      });
      await new Promise<void>((resolve, reject) => watcher!.once('ready', resolve).once('error', reject));
      await device.launch(metro.port, bridge.port);
    } catch (error) { await dispose(); throw error; }
  }

  function session(initial: RenderRequest): NativePreviewSession {
    const id = randomUUID();
    let request = initial, mounted = false, active = true;
    let frame: { width: number; height: number; screen: Screen } | undefined;
    let tail: Promise<unknown> = Promise.resolve();
    let closing: Promise<void> | undefined;
    function run<T>(work: () => Promise<T>): Promise<T> {
      if (closing) return Promise.reject(new PreviewFailure('NATIVE_DISCONNECTED', 'Native session is closing.'));
      const result = tail.then(() => {
        if (!active || closed) throw new PreviewFailure('NATIVE_DISCONNECTED', 'Native session closed.');
        return work();
      });
      tail = result.catch(() => {});
      return result;
    }
    async function commit(action: NativeCommand['action'], args?: Record<string, unknown>) {
      await writes;
      if (rebuild) throw new PreviewFailure('NATIVE_BUILD_REQUIRED', 'Rebuild and reinstall the debug host after changing ' + rebuild);
      if (refreshError) throw refreshError;
      if (closed || !active) throw new PreviewFailure('NATIVE_DISCONNECTED', 'Native session closed.');
      const target = revision;
      bundle ??= requireBundle(metro.port, platform, config.entry ?? 'index', target, sourceGeneration.signal);
      await bundle;
      if (target !== revision) throw new PreviewFailure('STALE_RENDER', 'Native source changed before capture.');
      if (action === 'open' || action === 'reset') device.clearInputHistory();
      const screen = await bridge.request({ action, args, generation: request.generation, sessionId: id,
        previewId: request.preview.id, revision: target });
      if (target !== revision) throw new PreviewFailure('STALE_RENDER', 'Native source changed during the React commit.');
      return { screen, target };
    }
    async function capture(): Promise<RenderResult> {
      const start = performance.now();
      const { screen, target } = await commit(mounted ? 'capture' : 'open');
      mounted = true;
      const prefix = path.join(context.artifacts, randomUUID());
      const imagePath = prefix + '.png';
      const size = await device.screenshot(imagePath);
      const warnings: string[] = [];
      const treePath = capabilities.uiTree ? prefix + '.json' : undefined;
      if (treePath) {
        const tree = await device.inspect(size, screen);
        await writeFile(treePath, JSON.stringify(tree), { flag: 'wx', mode: 0o600 });
      } else warnings.push('Install idb and idb_companion for iOS input and accessibility hierarchy.');
      if (request.preview.viewport) warnings.push('Native screenshot uses the selected device’s physical viewport.');
      if (request.preview.theme) warnings.push('Native system appearance is determined by the selected device.');
      if (target !== revision) throw new PreviewFailure('STALE_RENDER', 'Native source changed while reading the device.');
      frame = { ...size, screen };
      return { previewId: request.preview.id, sessionId: id, generation: request.generation, imageGeneration: request.generation,
        platform, status: 'ready', imagePath, treePath, ...size, durationMs: Math.round(performance.now() - start), warnings };
    }
    return { id, capture: () => run(capture),
      update: next => run(() => { request = next; return capture(); }),
      dispatch: action => run(async () => {
        if (!frame) throw new PreviewFailure('NO_CURRENT_FRAME', 'Capture this native session before sending input.');
        await device.dispatch(action, frame, frame.screen);
      }),
      inspect: () => run(async () => {
        if (!frame || !capabilities.uiTree) throw new PreviewFailure('NATIVE_TREE_UNAVAILABLE', 'No current accessibility hierarchy.');
        return device.inspect(frame, frame.screen);
      }),
      reset: () => run(async () => { await commit('reset'); mounted = true; }),
      setArgs: props => run(async () => {
        if (!mounted) { await commit('open'); mounted = true; }
        await commit('args', props);
      }),
      close() {
        closing ??= tail.then(async () => {
          try {
            if (live?.id === id && mounted && !closed && !rebuild && !refreshError) await commit('close');
          } finally {
            if (live?.id === id) live = undefined;
            active = false;
          }
        });
        return closing;
      },
    };
  }
  return { capabilities: () => capabilities, prepare, dispose,
    async render(request) {
      if (live || boardCapturing) throw new PreviewFailure('NATIVE_DEVICE_BUSY', 'The device is already capturing another native preview.');
      boardCapturing = true;
      const board = session(request);
      try { return await board.capture(); } finally { await board.close(); boardCapturing = false; }
    },
    async openSession(request) {
      if (live || boardCapturing) throw new PreviewFailure('NATIVE_DEVICE_BUSY', 'The device already has an active native session.');
      live = session(request); return live;
    },
  };
}
