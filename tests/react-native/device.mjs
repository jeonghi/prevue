import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  refresh: { type: 'boolean' }, 'build-change': { type: 'boolean' }, output: { type: 'string' },
  'warm-runs': { type: 'string', default: '5' }, 'max-warm-p50-ms': { type: 'string' },
} });
const [platform, device] = positionals;
assert(positionals.length === 2 && ['ios', 'android'].includes(platform) && device,
  'Usage: node tests/react-native/device.mjs ios|android <explicit device> [--output directory] [--refresh|--build-change] [--warm-runs N] [--max-warm-p50-ms N]');
assert(!(values.refresh && values['build-change']), 'Choose one check per invocation.');
const warmRuns = Number(values['warm-runs']);
const budget = values['max-warm-p50-ms'] === undefined ? undefined : Number(values['max-warm-p50-ms']);
assert(Number.isSafeInteger(warmRuns) && warmRuns > 0, '--warm-runs must be a positive integer');
if (budget !== undefined) assert(Number.isFinite(budget) && budget > 0 && !values.refresh && !values['build-change'],
  '--max-warm-p50-ms requires a positive budget and a warm render run');
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = path.join(root, 'fixtures/react-native-bare');
const bin = process.env.PREVUE_BIN ?? path.join(root, 'plugin/bin/prevue');
const output = path.resolve(values.output ?? path.join(root, '.cache/react-native-device', platform));
const exec = promisify(execFile);
await mkdir(output, { recursive: true });

async function rn(args, expectedFailure = false) {
  const started = performance.now();
  let result;
  try {
    const { stdout } = await exec(bin, ['rn', ...args, '--platform', platform], { cwd: fixture, timeout: 210000 });
    result = JSON.parse(stdout);
  } catch (error) {
    if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw error;
    result = JSON.parse(error.stdout);
  }
  assert.equal(result.ok, !expectedFailure, `${args[0]}: ${JSON.stringify(result.error ?? 'unexpected success')}`);
  return { result, elapsedMs: Math.round(performance.now() - started) };
}

function allNodes(tree) {
  const nodes = [];
  function visit(node) { nodes.push(node); node.children.forEach(visit); }
  tree.nodes.forEach(visit);
  return nodes;
}
function findNode(nodes, predicate, description) {
  const node = nodes.find(predicate);
  assert(node, `Missing native accessibility node '${description}'`);
  return node;
}
function center(node) {
  return [node.bounds.x + node.bounds.width / 2, node.bounds.y + node.bounds.height / 2].map(v => String(Math.round(v)));
}
function hasText(nodes, value) {
  return nodes.some(node => node.text === value || node.accessibilityLabel === value);
}
async function frame(result, name) {
  assert.equal(result.status, 'ready');
  assert.equal(result.platform, platform);
  assert.equal(result.generation, result.imageGeneration);
  const png = await readFile(result.imagePath);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [result.width, result.height]);
  const tree = JSON.parse(await readFile(result.treePath, 'utf8'));
  assert.deepEqual([tree.width, tree.height], [result.width, result.height]);
  if (name) {
    await copyFile(result.imagePath, path.join(output, name + '.png'));
    await copyFile(result.treePath, path.join(output, name + '.json'));
  }
  return allNodes(tree);
}

const shown = await rn(['show', 'Shipment.preview.tsx', '--device', device]);
const board = shown.result.cards[0];
let nodes = await frame(board, 'initial');
assert(hasText(nodes, '부산 → 서울'));
const report = { platform, device, width: board.width, height: board.height,
  reactNative: JSON.parse(await readFile(path.join(fixture, 'node_modules/react-native/package.json'), 'utf8')).version,
  show: { ...shown.result.timings, elapsedMs: shown.elapsedMs }, warm: [], checks: [] };

async function exercise() {
  const focused = await rn(['focus', '0', '--on']);
  nodes = await frame(focused.result);
  const images = new Set([focused.result.imagePath]);
  const trees = new Set([focused.result.treePath]);
  for (let i = 0; i < warmRuns; i++) {
    const captured = await rn(['render']);
    const current = await frame(captured.result);
    assert.equal(captured.result.previewId, board.previewId);
    assert.equal(captured.result.generation, focused.result.generation);
    assert(hasText(current, '부산 → 서울'));
    assert(current.some(node => node.testId === 'dispatch-button'));
    assert(!images.has(captured.result.imagePath) && !trees.has(captured.result.treePath), 'Each render must produce a fresh PNG and hierarchy');
    images.add(captured.result.imagePath);
    trees.add(captured.result.treePath);
    report.warm.push({ elapsedMs: captured.elapsedMs, captureMs: captured.result.durationMs });
  }
  const button = findNode(nodes, n => n.testId === 'dispatch-button', 'dispatch-button');
  const tap = center(button);
  const pointed = await rn(['point', ...tap, '--preview', board.previewId]);
  const selected = await rn(['selection']);
  assert.equal(selected.result.node.id, pointed.result.node.id);
  assert.equal(selected.result.previewId, board.previewId);
  const tapped = await rn(['touch', ...tap]);
  nodes = await frame(tapped.result, 'tapped');
  assert(hasText(nodes, '배차 요청 완료'), 'Tap must change the shipment status');
  report.checks.push('point', 'selection', 'tap');
  const input = findNode(nodes, n => n.testId === 'shipment-note', 'shipment-note');
  await rn(['touch', ...center(input)]);
  const text = platform === 'ios' ? '부산 Dock B' : 'Dock B';
  if (platform === 'ios') await rn(['type', '부산 ']);
  nodes = await frame((await rn(['type', 'Dock B'])).result, 'typed');
  assert.equal(nodes.find(n => n.testId === 'shipment-note')?.text, text);
  assert(nodes.some(n => n.testId !== 'shipment-note' && n.text === text), 'The React receipt must receive the native input value');
  const reset = await rn(['reset']);
  nodes = await frame(reset.result, 'reset');
  report.interaction = { tapToImageMs: tapped.elapsedMs, resetToImageMs: reset.elapsedMs };
  assert(hasText(nodes, '1톤 카고') && !hasText(nodes, text) && !hasText(nodes, '배차 요청 완료'), 'Reset must remount the shipment');
  report.checks.push('type', 'reset');
  const first = findNode(nodes, n => n.text === '경유지 1', 'first waypoint');
  nodes = await frame((await rn(['scroll', '1'])).result, 'scrolled');
  const next = nodes.find(n => n.text === '경유지 1');
  assert(!next || next.bounds.y < first.bounds.y - 10, 'Expected native scroll offset to change');
  report.checks.push('scroll');
}

async function exerciseRefresh() {
  const scratch = await mkdtemp(path.join(fixture, 'DeviceCheck-'));
  const file = path.join(scratch, 'Revision.preview.tsx');
  const relative = path.relative(fixture, file);
  const source = value => `import React from 'react';\nimport {Text} from 'react-native';\nimport {definePreview} from '@prevue/react-native';\nexport const Revision = definePreview({name: 'revision', platforms: ['${platform}'], render: () => <Text>${value}</Text>});\n`;
  try {
    await writeFile(file, source('Before edit'));
    await rn(['wait', relative, '--after', String(shown.result.generation), '--timeout', '90']);
    const before = (await rn(['show', relative, '--device', device])).result.cards[0];
    assert(hasText(await frame(before), 'Before edit'));
    const saved = performance.now();
    await writeFile(file, source('After edit'));
    const changed = (await rn(['wait', relative, '--after', String(before.generation), '--timeout', '90'])).result.cards[0];
    const editToImageMs = Math.round(performance.now() - saved);
    assert(hasText(await frame(changed, 'edited'), 'After edit'));
    assert(changed.generation > before.generation);
    await writeFile(file, source('Broken').replace('render: () =>', 'render: () @'));
    const broken = (await rn(['wait', relative, '--after', String(changed.generation), '--timeout', '90'], true)).result.cards[0];
    assert.equal(broken.status, 'stale');
    assert(broken.error?.code && broken.imageGeneration < broken.generation);
    await writeFile(file, source('Recovered'));
    const healthy = (await rn(['wait', relative, '--after', String(broken.generation), '--timeout', '90'])).result.cards[0];
    assert(hasText(await frame(healthy, 'recovered'), 'Recovered'));
    report.refresh = { editToImageMs, before: before.generation, edited: changed.generation, broken: broken.generation,
      recovered: healthy.generation, error: broken.error.code };
    report.checks.push('saved JS/TS/TSX edit', 'error retains previous image', 'recovery');
    await rn(['show', 'Shipment.preview.tsx', '--device', device]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function exerciseNativeChange() {
  const scratch = await mkdtemp(path.join(fixture, platform, 'DeviceCheck-'));
  const file = path.join(scratch, platform === 'ios' ? 'Changed.swift' : 'Changed.kt');
  try {
    await writeFile(file, '// Native build input changed during a running debug session.\n');
    const failed = await rn(['wait', path.relative(fixture, file), '--after', String(board.generation), '--timeout', '90'], true);
    assert.equal(failed.result.error.code, 'NATIVE_BUILD_REQUIRED');
    const previous = failed.result.cards[0];
    assert.equal(previous.status, 'stale');
    assert.equal(previous.imageGeneration, board.generation);
    report.checks.push('native source change requires reinstall');
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

try {
  if (values.refresh) await exerciseRefresh();
  else if (values['build-change']) await exerciseNativeChange();
  else await exercise();
  if (report.warm.length) {
    const times = report.warm.map(sample => sample.elapsedMs).sort((a, b) => a - b);
    report.warmCliMs = { p50: times[Math.ceil(times.length * 0.50) - 1], p95: times[Math.ceil(times.length * 0.95) - 1] };
  }
  const name = values.refresh ? 'refresh' : values['build-change'] ? 'build-change' : 'device';
  await writeFile(path.join(output, name + '-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (budget !== undefined) {
    assert(report.warmCliMs.p50 <= budget, `Warm render CLI P50 ${report.warmCliMs.p50} ms exceeds ${budget} ms`);
  }
} finally {
  await rn(['stop']);
}
