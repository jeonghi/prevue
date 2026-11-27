import { execFile } from 'node:child_process';
import { access, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createConnection, type NetConnectOpts } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { errorInfo } from '../errors.ts';
import { location } from '../instance.ts';
import { openDevice, parseConfig, type NativeConfig } from './device.ts';

const exec = promisify(execFile);

async function adbServerRunning(): Promise<boolean> {
  const configured = process.env.ADB_SERVER_SOCKET;
  let address: NetConnectOpts;
  if (configured?.startsWith('localfilesystem:')) address = { path: configured.slice('localfilesystem:'.length) };
  else {
    const match = configured && /^tcp:([^:]*):(\d+)$/.exec(configured);
    if (configured && !match) return false;
    address = { host: match?.[1] || process.env.ANDROID_ADB_SERVER_ADDRESS || '127.0.0.1',
      port: Number(match?.[2] || process.env.ANDROID_ADB_SERVER_PORT || 5037) };
  }
  return new Promise(resolve => {
    const socket = createConnection(address);
    const finish = (ok: boolean) => { socket.destroy(); resolve(ok); };
    socket.once('connect', () => finish(true)).once('error', () => finish(false)).setTimeout(800, () => finish(false));
  });
}

/** Resolve dependencies and inspect a running device without evaluating the app, starting Metro or taking its lease. */
export async function nativeDoctor(root: string, platform: 'ios' | 'android', device?: string) {
  const require = createRequire(path.join(root, 'package.json'));
  const missing: string[] = [], warnings: string[] = [];
  for (const dependency of ['react', 'react-native', '@prevue/native-host', '@prevue/react-native', 'metro']) {
    try { require.resolve(dependency); } catch { missing.push(dependency); }
  }
  let config: NativeConfig | undefined;
  try {
    config = parseConfig(JSON.parse(await readFile(path.join(root, 'prevue.native.json'), 'utf8')), platform);
  } catch (error) { missing.push('prevue.native.json with ' + platform + '.appId'); warnings.push(errorInfo(error).message); }
  if (config) {
    const prefix = path.join(root, config.entry ?? 'index');
    const candidates = ['js', 'jsx', 'ts', 'tsx', 'mjs'].flatMap(ext => [
      prefix + '.' + platform + '.' + ext, prefix + '.native.' + ext, prefix + '.' + ext,
    ]);
    if (!(await Promise.all(candidates.map(file => stat(file).then(s => s.isFile(), () => false)))).some(Boolean)) {
      missing.push('Metro Debug entry ' + (config.entry ?? 'index'));
    }
  }
  let hasTool = true;
  try {
    if (platform === 'ios') await exec('xcrun', ['--find', 'simctl'], { timeout: 8000 });
    else await exec('adb', ['version'], { timeout: 8000 });
  } catch { hasTool = false; missing.push(platform === 'ios' ? 'Xcode simctl' : 'Android platform-tools adb'); }
  if (!device) missing.push('explicit --device ' + (platform === 'ios' ? 'Simulator UDID' : 'Emulator serial'));
  let installed = false;
  if (device && hasTool && config) {
    if (platform === 'android' && !await adbServerRunning()) missing.push('running adb server');
    else {
      try {
        // openDevice only probes the selected device/install. launch performs the state-changing operations.
        const probe = await openDevice(platform, device, config);
        installed = true;
        if (!probe.input) warnings.push('Install idb and idb_companion for iOS input and accessibility inspection.');
        const marker = path.join(location(root, platform).dir, 'native-build-' + encodeURIComponent(device) + '.json');
        if (await access(marker).then(() => true, () => false)) {
          const previous = JSON.parse(await readFile(marker, 'utf8'));
          if (previous.installed === probe.installed) missing.push('reinstalled Debug host after changing ' + previous.file);
        }
      } catch (error) { missing.push('available selected device and installed Debug host ' + config.appId); warnings.push(errorInfo(error).message); }
    }
  }
  return { missing, warnings, device: device ?? null, appId: config?.appId ?? null, installedHost: installed,
    hostCheck: installed ? (platform === 'ios' ? 'installed simulator bundle' : 'installed debuggable application') : null,
    commitVerified: false };
}
