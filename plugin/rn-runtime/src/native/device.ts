import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { SaxesParser } from 'saxes';
import { PreviewFailure } from '../errors.ts';
import type { Interaction, UINode, UITree } from '../protocol.ts';
import type { Screen } from './bridge.ts';

const exec = promisify(execFile);
async function run(tool: string, args: string[], env = process.env): Promise<Buffer> {
  try {
    return (await exec(tool, args, { encoding: 'buffer', env, timeout: 25_000, maxBuffer: 24 * 1024 * 1024 })).stdout;
  } catch (error) {
    throw new PreviewFailure('NATIVE_TOOL_FAILED', error instanceof Error ? error.message : String(error));
  }
}

export interface NativeConfig { appId: string; activity?: string; display?: number; entry?: string }
export function parseConfig(json: unknown, platform: 'ios' | 'android'): NativeConfig {
  const config = json && typeof json === 'object' ? (json as Record<string, NativeConfig>)[platform] : undefined;
  if (!config || typeof config.appId !== 'string' || !/^[\w-]+(?:\.[\w-]+)+$/.test(config.appId) ||
      (config.activity !== undefined && !/^[.\w$]+$/.test(config.activity)) ||
      (config.entry !== undefined && (!/^[\w./-]+$/.test(config.entry) || config.entry.includes('..') || config.entry.startsWith('/'))) ||
      (config.display !== undefined && (!Number.isInteger(config.display) || config.display < 0))) {
    throw new PreviewFailure('NATIVE_HOST_REQUIRED', `Configure the installed Debug host's ${platform}.appId in prevue.native.json.`);
  }
  return config;
}

export function pngSize(png: Buffer) {
  if (png.length < 24 || !png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      png.toString('ascii', 12, 16) !== 'IHDR') throw new PreviewFailure('NATIVE_CAPTURE_FAILED', 'Device returned an invalid PNG.');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}
type Size = { width: number; height: number };
type EditingField = {
  AXUniqueId?: string; AXLabel?: string; AXValue?: string; AXPlaceholderValue?: string;
  type?: string; traits?: string[]; frame?: UINode['bounds'];
};
export function iosInputValue(data: unknown, input: string, previous?: { key: string; value: string }) {
  const rows: EditingField[] = Array.isArray(data) ? data : [];
  const focused = rows.filter(row => row.traits?.includes('TextEntry') && row.traits.includes('IsEditing'));
  const field = focused[0], frame = field?.frame;
  if (focused.length !== 1 || !frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) ||
      field.type?.toLowerCase().includes('secure') || field.traits?.some(trait => trait.toLowerCase().includes('secure'))) {
    throw new PreviewFailure('UNSUPPORTED_INPUT', 'Focus one accessible, non-secure iOS text field before typing.');
  }
  const key = field.AXUniqueId || JSON.stringify([field.AXLabel, frame]);
  const current = field.AXValue ?? '';
  // UIKit can surface an empty field's placeholder as its AX value; idb versions without
  // AXPlaceholderValue report the placeholder as the accessible label on these native fields.
  const placeholder = field.AXPlaceholderValue ?? field.AXLabel;
  const prefix = current === placeholder && !(previous?.key === key && previous.value === current) ? '' : current;
  return { key, value: prefix + input, x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

export function iosTree(data: unknown, image: Size, points: Screen): UITree {
  let count = 0;
  const sx = image.width / points.width, sy = image.height / points.height;
  function convert(item: unknown): UINode[] {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const children = Array.isArray(row.children) ? row.children.flatMap(convert) : [];
    const frame = row.frame as UINode['bounds'] | undefined;
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite)) return children;
    const text = (key: string) => typeof row[key] === 'string' ? row[key] as string : undefined;
    return [{ id: 'ax-' + count++, name: text('type') ?? text('role') ?? 'View', source: null, children,
      bounds: { x: frame.x * sx, y: frame.y * sy, width: frame.width * sx, height: frame.height * sy },
      accessibilityRole: text('role') ?? text('type'), accessibilityLabel: text('AXLabel') ?? text('label'),
      testId: text('AXUniqueId') ?? text('identifier'), text: text('AXValue') ?? text('value') ?? text('AXLabel') ?? text('label') }];
  }
  const nodes = (Array.isArray(data) ? data : [data]).flatMap(convert);
  if (!nodes.length) throw new PreviewFailure('NATIVE_TREE_UNAVAILABLE', 'idb returned no screen elements with measured frames.');
  return { ...image, nodes };
}

export function androidTree(xml: string, image: Size): UITree {
  const parser = new SaxesParser();
  const nodes: UINode[] = [], parents: UINode[] = [];
  let count = 0;
  parser.on('opentag', tag => {
    if (tag.name !== 'node') return;
    const a = tag.attributes;
    const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(a.bounds);
    if (!match) throw new PreviewFailure('NATIVE_TREE_UNAVAILABLE', 'Invalid Android accessibility bounds.');
    const [, x, y, right, bottom] = match.map(Number);
    const node: UINode = { id: 'uia-' + count++, name: a.class, bounds: { x, y, width: right - x, height: bottom - y }, source: null, children: [],
      text: a.text || undefined, testId: a['resource-id'] || undefined, accessibilityLabel: a['content-desc'] || undefined, accessibilityRole: a.class };
    (parents.at(-1)?.children ?? nodes).push(node);
    parents.push(node);
  });
  parser.on('closetag', tag => { if (tag.name === 'node') parents.pop(); });
  parser.write(xml).close();
  if (!nodes.length) throw new PreviewFailure('NATIVE_TREE_UNAVAILABLE', 'Android returned an empty accessibility hierarchy.');
  return { ...image, nodes };
}

export async function openDevice(platform: 'ios' | 'android', serial: string, config: NativeConfig) {
  const adb = (...args: string[]) => run('adb', ['-s', serial, ...args]);
  const idb = (...args: string[]) => run('idb', ['ui', ...args, '--udid', serial]);
  const sim = (...args: string[]) => run('xcrun', ['simctl', ...args]);
  let installed: string, input = true;
  if (platform === 'ios') {
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(serial)) throw new PreviewFailure('NATIVE_DEVICE_REQUIRED', 'Pass an explicit iOS Simulator UDID.');
    const inventory = JSON.parse(String(await sim('list', 'devices', 'booted', '-j'))) as { devices: Record<string, { udid: string }[]> };
    if (!Object.values(inventory.devices).flat().some(device => device.udid.toLowerCase() === serial.toLowerCase())) {
      throw new PreviewFailure('NATIVE_DEVICE_UNAVAILABLE', 'The selected iOS Simulator is not booted.');
    }
    const app = String(await sim('get_app_container', serial, config.appId, 'app')).trim();
    installed = app + '/' + (await stat(app + '/Info.plist')).mtimeMs;
    input = await run('idb', ['ui', 'describe-all', '--help']).then(() => true, () => false);
  } else {
    if (!/^[\w.:\-]+$/.test(serial) || (await adb('get-state')).toString().trim() !== 'device' ||
        (await adb('shell', 'getprop', 'ro.kernel.qemu')).toString().trim() !== '1') {
      throw new PreviewFailure('NATIVE_DEVICE_UNAVAILABLE', 'Pass the explicit serial of a running Android Emulator.');
    }
    const pkg = String(await adb('shell', 'dumpsys', 'package', config.appId));
    const stamp = /lastUpdateTime=([^\r\n]+)/.exec(pkg)?.[1];
    if (!stamp || !/\bDEBUGGABLE\b/.test(pkg)) throw new PreviewFailure('NATIVE_HOST_REQUIRED', 'Install the debuggable Android host for ' + config.appId);
    installed = stamp;
  }
  const forwards: number[] = [];
  let lastInput: { key: string; value: string } | undefined;
  return {
    input, installed,
    clearInputHistory() { lastInput = undefined; },
    async launch(metro: number, bridge: number) {
      if (platform === 'ios') {
        await run('xcrun', ['simctl', 'launch', '--terminate-running-process', serial, config.appId],
          { ...process.env, SIMCTL_CHILD_PREVUE_METRO_PORT: String(metro) });
      } else {
        for (const port of [metro, bridge]) {
          await adb('reverse', '--no-rebind', 'tcp:' + port, 'tcp:' + port);
          forwards.push(port);
        }
        const output = String(await adb('shell', 'am', 'start', '-S', '-W', '-n', config.appId + '/' + (config.activity ?? '.MainActivity'),
          '--es', 'prevueMetroHost', '127.0.0.1:' + metro));
        if (/Error|Exception/.test(output)) throw new PreviewFailure('NATIVE_LAUNCH_FAILED', output);
      }
    },
    async screenshot(file: string) {
      if (platform === 'ios') {
        const capture = (display?: number) => sim('io', serial, 'screenshot', ...(display === undefined ? [] : ['--display=' + display]), file);
        try { await capture(config.display); }
        catch (error) {
          const primary = error instanceof Error && /(?:displayID\s*[=:]\s*|^\s*)(\d+)[^\n]*primary/im.exec(error.message);
          if (config.display !== undefined || !primary) throw error;
          await capture(Number(primary[1]));
        }
      } else await writeFile(file, await adb('exec-out', 'screencap', '-p'), { mode: 0o600, flag: 'wx' });
      return pngSize(await readFile(file));
    },
    async inspect(image: Size, screen: Screen): Promise<UITree> {
      if (platform === 'ios') return iosTree(JSON.parse(String(await idb('describe-all', '--json', '--nested'))), image, screen);
      const temporary = '/data/local/tmp/prevue-' + randomUUID() + '.xml';
      try {
        await adb('shell', 'uiautomator', 'dump', temporary);
        return androidTree(String(await adb('exec-out', 'cat', temporary)), image);
      } finally { await adb('shell', 'rm', '-f', temporary).catch(() => {}); }
    },
    async dispatch(action: Interaction, image: Size, screen: Screen) {
      if (!input) throw new PreviewFailure('UNSUPPORTED_INPUT', 'Install idb and idb_companion to use iOS input.');
      if (action.type === 'text') {
        if (platform === 'ios') {
          const field = iosInputValue(JSON.parse(String(await idb('describe-all', '--json'))), action.text, lastInput);
          await idb('set-value', String(field.x), String(field.y), '--value=' + field.value);
          lastInput = field;
          return;
        }
        if (!/^[\x20-\x7E]*$/.test(action.text)) throw new PreviewFailure('UNSUPPORTED_INPUT', 'Android adb text input accepts printable ASCII.');
        // adb shell joins arguments on the device. Quote input for that shell, including literal percent sequences.
        for (const part of action.text.match(/%|[^%]+/g) ?? []) {
          const escaped = "'" + part.replaceAll("'", "'\\''").replaceAll(' ', '%s') + "'";
          await adb('shell', 'input', 'text', escaped);
        }
        return;
      }
      const point = (x: number, y: number) => {
        if (!(x >= 0 && x < image.width && y >= 0 && y < image.height)) throw new PreviewFailure('UNSUPPORTED_INPUT', 'Touch falls outside the device screenshot.');
        return [Math.round(platform === 'ios' ? x * screen.width / image.width : x), Math.round(platform === 'ios' ? y * screen.height / image.height : y)].map(String);
      };
      if (action.type === 'scroll') {
        const x = action.x ?? image.width * (action.dx > 0 ? 0.75 : 0.5), y = action.y ?? image.height * (action.dy > 0 ? 0.75 : 0.5);
        const end = point(Math.max(image.width * 0.1, Math.min(image.width * 0.9, x - action.dx)), Math.max(image.height * 0.1, Math.min(image.height * 0.9, y - action.dy)));
        if (platform === 'ios') await idb('swipe', ...point(x, y), ...end, '--duration', '0.35');
        else await adb('shell', 'input', 'swipe', ...point(x, y), ...end, '350');
      } else if (action.type === 'tap') {
        if (platform === 'ios') await idb('tap', ...point(action.x, action.y));
        else await adb('shell', 'input', 'tap', ...point(action.x, action.y));
      } else if (platform === 'android') {
        await adb('shell', 'input', 'motionevent', { press: 'DOWN', drag: 'MOVE', release: 'UP' }[action.type], ...point(action.x, action.y));
      } else throw new PreviewFailure('UNSUPPORTED_INPUT', 'iOS idb supports tap and scroll gestures; split press/drag/release is unavailable.');
    },
    async close() {
      for (const port of forwards) await adb('reverse', '--remove', 'tcp:' + port).catch(() => {});
    },
  };
}
