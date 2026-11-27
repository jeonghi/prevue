import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { startBridge } from '../src/native/bridge.ts';
import { nativeDoctor } from '../src/native/doctor.ts';
import { parse } from '../src/commands.ts';
import { androidTree, iosInputValue, iosTree, parseConfig, pngSize } from '../src/native/device.ts';
import { acquireDevice } from '../src/native/lease.ts';
import { createNativeRenderer, nativeBuildInput } from '../src/native/index.ts';
import { writeEntry } from '../src/native/metro.ts';

test('only one owner can select a device until the process releases its lease', async () => {
  const release = await acquireDevice('ios', 'EE010000-ABCD-0000-0000-000000000001');
  try {
    await assert.rejects(acquireDevice('ios', 'ee010000-abcd-0000-0000-000000000001'), { code: 'NATIVE_DEVICE_BUSY' });
    const module = new URL('../src/native/lease.ts', import.meta.url).href;
    const script = `import {acquireDevice} from ${JSON.stringify(module)}; try { await (await acquireDevice('ios', 'ee010000-abcd-0000-0000-000000000001'))(); } catch (error) { console.log(error.code); }`;
    const other = await promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', script],
      { cwd: os.tmpdir(), env: { ...process.env, PREVUE_HOME: path.join(os.tmpdir(), 'different-prevue-home') } });
    assert.equal(other.stdout.trim(), 'NATIVE_DEVICE_BUSY');
  } finally { await release(); }
  await (await acquireDevice('ios', 'EE010000-ABCD-0000-0000-000000000001'))();
});

test('bridge accepts only the authenticated device commit for the requested revision and generation', async t => {
  const bridge = await startBridge('android');
  t.after(() => bridge.close());
  const headers = { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' };
  assert.equal((await fetch(bridge.endpoint + '/next')).status, 403);
  const result = bridge.request({ action: 'open', previewId: 'card', revision: 'bundle-a', generation: 6, sessionId: 'fixture' });
  const command = await (await fetch(bridge.endpoint + '/next?revision=bundle-a', { headers })).json();
  assert.equal(command.previewId, 'card');
  const screen = { width: 360, height: 720, scale: 3 };
  const ack = (body: object) => fetch(bridge.endpoint + '/ack', { method: 'POST', headers, body: JSON.stringify({ ...command, platform: 'android', screen, ...body }) });
  for (const wrong of [{ id: 'other' }, { generation: 5 }, { revision: 'bundle-b' }, { platform: 'ios' }, { previewId: 'old' }, { sessionId: 'foreign' }]) {
    assert.equal((await ack(wrong)).status, 409);
  }
  assert.equal((await ack({})).status, 200);
  assert.deepEqual(await result, screen);
  assert.equal((await ack({})).status, 409);
});

test('native errors and absent acknowledgments cannot become ready screenshots', async t => {
  const bridge = await startBridge('ios');
  t.after(() => bridge.close());
  const headers = { authorization: 'Bearer ' + bridge.token, 'content-type': 'application/json' };
  const request = { action: 'reset', previewId: 'example', revision: 'test', generation: 2, sessionId: 'one' } as const;
  const failed = assert.rejects(bridge.request(request), { code: 'NATIVE_RENDER_FAILED', message: 'Fixture failed' });
  const command = await (await fetch(bridge.endpoint + '/next?revision=test', { headers })).json();
  await fetch(bridge.endpoint + '/ack', { headers, method: 'POST', body: JSON.stringify({ ...command, platform: 'ios', error: 'Fixture failed' }) });
  await failed;
  const superseded = assert.rejects(bridge.request(request), { code: 'STALE_RENDER' });
  bridge.invalidate();
  await superseded;
  await assert.rejects(bridge.request(request, 10), { code: 'NATIVE_ACK_TIMEOUT' });
});

test('Metro sees static project imports, platform-specific entries and the optional default provider', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'prevue-native-registry-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'Card.preview.tsx'), "import {definePreview as preview} from '@prevue/react-native'; export const Ready = preview({render: () => null});");
  await writeFile(path.join(root, 'prevue.providers.tsx'), 'export default function Provider(){}');
  const ios = await writeEntry(root, 'ios', 'ios-v1', 'http://127.0.0.1:1111', 'ios-key');
  const android = await writeEntry(root, 'android', 'android-v1', 'http://127.0.0.1:2222', 'android-key');
  const iosFile = path.join(root, '.prevue/entry.ios.js');
  const entry = await readFile(iosFile, 'utf8');
  assert.ok(entry.includes('require("../Card.preview.tsx")["Ready"]'));
  assert.ok(entry.includes("require('../prevue.providers.tsx').default"));
  assert.ok(!entry.includes('android-key'));
  await android(); await access(iosFile); await ios();
  await writeFile(iosFile, 'user entry');
  await assert.rejects(writeEntry(root, 'ios', 'v2', 'http://127.0.0.1:1', 'x'), { code: 'UNSAFE_NATIVE_ENTRY' });
  assert.equal(await readFile(iosFile, 'utf8'), 'user entry');
});

test('accessibility frames map to physical screenshot pixels and preserve backend test IDs', () => {
  const size = { width: 900, height: 1800 };
  const ios = iosTree([{ type: 'Button', AXUniqueId: 'dispatch', AXLabel: '배차 요청', frame: { x: 5, y: 11, width: 22, height: 10 } }],
    size, { width: 300, height: 600, scale: 3 });
  assert.deepEqual(ios.nodes[0].bounds, { x: 15, y: 33, width: 66, height: 30 });
  assert.equal(ios.nodes[0].testId, 'dispatch');
  assert.equal(ios.nodes[0].source, null);
  const android = androidTree('<hierarchy><node class="Frame" bounds="[0,0][900,1800]"><node class="Button" resource-id="dispatch" text="A &amp; B" bounds="[10,20][110,60]"/></node></hierarchy>', size);
  assert.deepEqual(android.nodes[0].children[0].bounds, { x: 10, y: 20, width: 100, height: 40 });
  assert.equal(android.nodes[0].children[0].text, 'A & B');
  assert.equal(android.nodes[0].children[0].testId, 'dispatch');
  assert.throws(() => pngSize(Buffer.from('no image')), { code: 'NATIVE_CAPTURE_FAILED' });
});

test('native setup requires a device, explicit Debug host configuration and platform-specific rebuilds', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'prevue-native-optin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'artifacts'));
  const input = { root, artifacts: path.join(root, 'artifacts'), platform: 'ios' as const, changed() {} };
  await assert.rejects(createNativeRenderer().prepare(input), { code: 'NATIVE_DEVICE_REQUIRED' });
  await assert.rejects(createNativeRenderer().prepare({ ...input, device: 'chosen' }), { code: 'NATIVE_HOST_REQUIRED' });
  assert.throws(() => parseConfig({ ios: { appId: 'com.test.preview', entry: '../wrong' } }, 'ios'), { code: 'NATIVE_HOST_REQUIRED' });
  assert.equal(nativeBuildInput('ios/App/AppDelegate.swift', 'ios'), true);
  assert.equal(nativeBuildInput('ios/App/AppDelegate.swift', 'android'), false);
  assert.equal(nativeBuildInput('package-lock.json', 'android'), true);
  assert.equal(nativeBuildInput('ios/Pods/Sample/Bridge.m', 'ios'), false);
});

test('iOS appends Unicode through the focused accessibility field across keyboard layouts', () => {
  const row = { AXUniqueId: 'note', AXLabel: '화물 메모', AXValue: '화물 메모', type: 'TextField',
    traits: ['TextEntry', 'IsEditing'], frame: { x: 10, y: 20, width: 160, height: 40 } };
  const first = iosInputValue([row], '부산');
  assert.deepEqual(first, { key: 'note', value: '부산', x: 90, y: 40 });
  assert.equal(iosInputValue([{ ...row, AXValue: '부산' }], ' Dock B', first).value, '부산 Dock B');
  assert.equal(iosInputValue([row], '!', { key: 'note', value: '화물 메모' }).value, '화물 메모!');
  assert.throws(() => iosInputValue([{ ...row, type: 'SecureTextField' }], 'secret'), { code: 'UNSUPPORTED_INPUT' });
  assert.throws(() => iosInputValue([row, row], 'ambiguous'), { code: 'UNSUPPORTED_INPUT' });
});

test('doctor distinguishes the installed native adapter from host readiness without creating generated entries', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'prevue-native-doctor-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { 'react-native': '*' } }));
  const parsed = parse(['doctor', '--platform', 'ios', '--device', 'specific-id']);
  assert.equal('device' in parsed && parsed.device, 'specific-id');
  const result = await nativeDoctor(root, 'ios');
  assert.equal(result.installedHost, false);
  assert.ok(result.missing.includes('prevue.native.json with ios.appId'));
  assert.ok(result.missing.includes('explicit --device Simulator UDID'));
  assert.ok(result.missing.includes('@prevue/native-host'));
  await assert.rejects(access(path.join(root, '.prevue')), { code: 'ENOENT' });
});
