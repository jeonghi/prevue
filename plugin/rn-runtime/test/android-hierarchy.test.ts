import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { startAndroidHierarchyDump } from '../src/native/android-hierarchy.ts';
import { androidTree, openDevice } from '../src/native/device.ts';

const xml = '<hierarchy rotation="0"><node class="Text" text="부산 &amp; 서울" bounds="[1,2][21,12]"/></hierarchy>';
const footer = 'UI hierchary dumped to: /dev/fd/1\n';

test('Android publishes a complete native dump after the tool confirms it and drains the exiting process', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prevue-android-dump-'));
  const executable = path.join(root, 'adb');
  const gate = path.join(root, 'release');
  const confirmed = path.join(root, 'confirmed');
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.slice(2).join(' ') !== '-s emulator-5564 exec-out uiautomator dump /dev/fd/1') process.exit(2);
const bytes = Buffer.from(${JSON.stringify(xml)});
const split = bytes.indexOf(Buffer.from('부')) + 1;
process.stdout.write(bytes.subarray(0, split));
setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
setTimeout(() => process.stdout.write('UI hierchary dump'), 15);
setTimeout(() => {
  fs.writeFileSync(${JSON.stringify(confirmed)}, 'disconnected');
  process.stdout.write('ed to: /dev/fd/1\\n');
}, 30);
const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(gate)})) clearInterval(timer); }, 10);
`, { mode: 0o755 });
  const dump = startAndroidHierarchyDump('emulator-5564', executable);
  let closed = false;
  void dump.closed.then(() => { closed = true; });
  t.after(async () => {
    try { await writeFile(gate, ''); await dump.closed; }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  const result = await dump.xml;
  assert.equal(result, xml);
  assert.equal(androidTree(result, { width: 100, height: 100 }).nodes[0].text, '부산 & 서울');
  assert.equal(await readFile(confirmed, 'utf8'), 'disconnected');
  assert.equal(closed, false, 'The final process teardown must be outside frame latency');
  await writeFile(gate, '');
  await dump.closed;
  assert.equal(closed, true);
});

test('Android rejects partial or failed dumps and recognizes unsupported stdout transports', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prevue-android-dump-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function command(output: string, status: number) {
    const executable = path.join(root, 'adb');
    await writeFile(executable, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)}); process.exitCode=${status};\n`, { mode: 0o755 });
    return startAndroidHierarchyDump('emulator-5564', executable);
  }
  const failed = [
    [xml, 1, 'NATIVE_TOOL_FAILED'],
    ['<hierarchy><node/>' + footer, 0, 'NATIVE_TREE_UNAVAILABLE'],
    ['ERROR: null root node returned\n', 0, 'NATIVE_TREE_UNAVAILABLE'],
  ] as const;
  for (const [output, status, code] of failed) {
    const dump = await command(output, status);
    await assert.rejects(dump.xml, { code });
    await dump.closed;
  }
  for (const [output, status] of [[footer, 0], [xml, 0], ['/dev/fd/1: Permission denied', 1]] as const) {
    const unsupported = await command(output, status);
    assert.equal(await unsupported.xml, null);
    await unsupported.closed;
  }
});

test('images without stdout dump support get a fresh regular file and cleanup for every inspection', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'prevue-android-file-'));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(root, { recursive: true, force: true });
  });
  const log = path.join(root, 'commands');
  await writeFile(path.join(root, 'adb'), `#!${process.execPath}
const fs = require('node:fs');
const [option, serial, ...args] = process.argv.slice(2);
if (option !== '-s' || serial !== 'emulator-5564') process.exit(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'get-state') console.log('device');
else if (args[1] === 'getprop') console.log('1');
else if (args[1] === 'dumpsys') console.log('DEBUGGABLE lastUpdateTime=fixture');
else if (args.at(-1) === '/dev/fd/1') process.stdout.write(${JSON.stringify(footer)});
else if (args[1] === 'cat') process.stdout.write(${JSON.stringify(xml)});
`, { mode: 0o755 });
  process.env.PATH = root + path.delimiter + oldPath;
  const device = await openDevice('android', 'emulator-5564', { appId: 'com.prevue.fixture' });
  const image = { width: 100, height: 100 };
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await device.inspect(image, { ...image, scale: 1 }), androidTree(xml, image));
  }
  await device.close();
  const calls: string[][] = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls.filter(args => args.at(-1) === '/dev/fd/1').length, 1);
  const files = calls.filter(args => args[0] === 'shell' && args[1] === 'uiautomator').map(args => args[3]);
  assert.equal(files.length, 2);
  assert.notEqual(files[0], files[1]);
  assert.deepEqual(calls.filter(args => args[1] === 'cat').map(args => args.at(-1)), files);
  assert.deepEqual(calls.filter(args => args[1] === 'rm').map(args => args.at(-1)), files);
});
