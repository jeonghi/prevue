import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  release: { type: 'boolean' }, output: { type: 'string' },
} });
const [platform, device] = positionals;
assert(positionals.length === 2 && ['ios', 'android'].includes(platform) && device,
  'Usage: node tests/react-native/device-brownfield.mjs ios|android <explicit device> [--release] [--output directory]');
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(root, 'fixtures/react-native-bare');
const output = path.resolve(values.output ?? path.join(root, '.cache/brownfield', platform, values.release ? 'release' : 'debug'));
const { SaxesParser } = createRequire(path.join(root, 'plugin/rn-runtime/package.json'))('saxes');
const exec = promisify(execFile);
const appId = 'com.prevue.nativefixture';
await mkdir(output, { recursive: true });
async function run(command, args, options) {
  const { stdout } = await exec(command, args, { cwd: fixture, maxBuffer: 16 * 1024 * 1024, timeout: 120000, ...options });
  return stdout;
}
const adb = (...args) => run('adb', ['-s', device, ...args]);
const sim = (...args) => run('xcrun', ['simctl', ...args]);
const idb = (...args) => run('idb', ['ui', ...args, '--udid', device]);
async function readScreen() {
  if (platform === 'ios') {
    const raw = await idb('describe-all', '--json');
    const rows = JSON.parse(raw).map(n => ({ text: n.AXLabel, bounds: n.frame }));
    return { raw, rows };
  }
  const tmp = '/data/local/tmp/prevue-brownfield-' + randomUUID() + '.xml';
  try {
    await adb('shell', 'uiautomator', 'dump', tmp);
    const raw = await adb('exec-out', 'cat', tmp);
    const rows = [];
    const parser = new SaxesParser();
    parser.on('opentag', ({ name, attributes }) => {
      if (name !== 'node') return;
      const [left, top, right, bottom] = attributes.bounds.match(/-?\d+/g).map(Number);
      rows.push({ text: attributes.text, bounds: { x: left, y: top, width: right - left, height: bottom - top } });
    });
    parser.write(raw).close();
    return { rows, raw };
  } finally { await adb('shell', 'rm', '-f', tmp); }
}
async function expectScreen(label, name) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const { rows, raw } = await readScreen();
    const row = rows.find(n => n.text === label);
    if (row && rows.some(n => n.text === '운송 현황')) {
      await writeFile(path.join(output, name + (platform === 'ios' ? '.json' : '.xml')), raw);
      const png = path.join(output, name + '.png');
      if (platform === 'ios') {
        const config = JSON.parse(await readFile(path.join(fixture, 'prevue.native.json'), 'utf8'));
        await sim('io', device, 'screenshot', ...(config.ios.display == null ? [] : ['--display=' + config.ios.display]), png);
      } else await writeFile(png, await run('adb', ['-s', device, 'exec-out', 'screencap', '-p'], { encoding: 'buffer' }));
      return row.bounds;
    }
    await delay(200);
  }
  throw new Error(`Expected native heading and '${label}' together on ${device}`);
}
async function rn(...args) {
  const value = JSON.parse(await run(process.env.PREVUE_BIN ?? path.join(root, 'plugin/bin/prevue'), ['rn', ...args, '--platform', platform]));
  assert(value.ok, JSON.stringify(value.error));
  return value;
}

// A release build must ignore even an explicit debug-only launch input.
if (platform === 'ios') {
  const env = { ...process.env };
  if (values.release) env.SIMCTL_CHILD_PREVUE_METRO_PORT = '9';
  else delete env.SIMCTL_CHILD_PREVUE_METRO_PORT;
  await run('xcrun', ['simctl', 'launch', '--terminate-running-process', device, appId], { env });
} else {
  await adb('shell', 'am', 'start', '-S', '-W', '-n', appId + '/.MainActivity',
    ...(values.release ? ['--es', 'prevueMetroHost', '127.0.0.1:9'] : []));
}
const button = await expectScreen('운송 화면 열기', 'landing');
if (values.release) {
  const point = [button.x + button.width / 2, button.y + button.height / 2].map(n => String(Math.round(n)));
  if (platform === 'ios') await idb('tap', ...point);
  else await adb('shell', 'input', 'tap', ...point);
  await expectScreen('일반 운송 화면', 'ordinary');
} else {
  try {
    await rn('show', 'Shipment.preview.tsx', '--device', device);
    const card = (await rn('render')).cards[0];
    assert.equal(card.status, 'ready');
    assert.equal(card.generation, card.imageGeneration);
    const tree = await readFile(card.treePath, 'utf8');
    assert(tree.includes('운송 현황') && tree.includes('부산 → 서울') && tree.includes('dispatch-button'),
      'Expected native landing and the embedded RN preview in the same device accessibility hierarchy');
    await copyFile(card.imagePath, path.join(output, 'embedded.png'));
    await writeFile(path.join(output, 'embedded.json'), tree);
  } finally { await rn('stop'); }
}
console.log(JSON.stringify({ platform, device, build: values.release ? 'Release' : 'Debug',
  screens: values.release ? ['landing', 'ordinary'] : ['landing', 'embedded'], output }));
