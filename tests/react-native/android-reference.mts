import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, watch } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { loadInstance, location } from '../../plugin/rn-runtime/src/instance.ts';
import { androidTree } from '../../plugin/rn-runtime/src/native/device.ts';
import { findProject } from '../../plugin/rn-runtime/src/registry.ts';

const [serial, project] = process.argv.slice(2);
assert(serial && project, 'Usage: tsx tests/react-native/android-reference.mts <adb serial> <focused RN project>');
const root = await findProject(path.resolve(project));
const instance = await loadInstance(location(root, 'android').record);
assert.equal(instance?.device, serial, 'Focus a preview on the selected emulator first.');
const bin = fileURLToPath(new URL('../../plugin/bin/prevue', import.meta.url));
const exec = promisify(execFile);
const adb = async (...args: string[]) => (await exec('adb', ['-s', serial, ...args],
  { encoding: 'buffer', timeout: 25_000, maxBuffer: 24 * 1024 * 1024 })).stdout;
async function render() {
  const { stdout } = await exec(bin, ['rn', 'render', '--platform', 'android'], { cwd: root, timeout: 45_000 });
  const frame = JSON.parse(stdout);
  assert(frame.ok && frame.status === 'ready' && frame.generation === frame.imageGeneration);
  return frame;
}

const settled = await render();
const stop = new AbortController();
const signal = AbortSignal.any([stop.signal, AbortSignal.timeout(30_000)]);
async function referencePng() {
  // Capture at the moment the renderer writes its PNG so clock and scrollbar
  // animations have as little time as possible to advance between the two reads.
  for await (const { filename } of watch(path.dirname(settled.imagePath), { signal })) {
    if (filename?.endsWith('.png')) return { filename, bytes: await adb('exec-out', 'screencap', '-p') };
  }
  throw new Error('The renderer did not write a PNG.');
}

try {
  const [reference, frame] = await Promise.all([referencePng(), render()]);
  assert.equal(frame.generation, settled.generation);
  assert.equal(frame.previewId, settled.previewId);
  assert.equal(reference.filename, path.basename(frame.imagePath));
  const image = await readFile(frame.imagePath);
  assert(image.equals(reference.bytes), 'The framebuffer pixels or PNG encoding changed between captures.');

  const remote = '/data/local/tmp/prevue-reference-' + randomUUID() + '.xml';
  try {
    await adb('shell', 'uiautomator', 'dump', remote);
    const xml = await adb('exec-out', 'cat', remote);
    const tree = await readFile(frame.treePath);
    const native = androidTree(xml.toString('utf8'), { width: frame.width, height: frame.height });
    assert.deepEqual(JSON.parse(tree.toString('utf8')), JSON.parse(JSON.stringify(native)));
    const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    console.log(JSON.stringify({ previewId: frame.previewId, generation: frame.generation, width: frame.width,
      height: frame.height, pngSha256: hash(image), treeSha256: hash(tree), referenceXmlSha256: hash(xml) }));
  } finally { await adb('shell', 'rm', '-f', remote); }
} finally { stop.abort(); }
