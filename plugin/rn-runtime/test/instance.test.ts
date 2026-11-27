import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { location } from '../src/instance.ts';

const moduleUrl = new URL('../src/instance.ts', import.meta.url).href;
const cwd = fileURLToPath(new URL('../', import.meta.url));
const nodeFlags = [...(process.allowedNodeEnvironmentFlags.has('--experimental-sqlite') ? ['--experimental-sqlite'] : []), '--import', import.meta.resolve('tsx')];

function contender(root: string, state: string, wait: boolean) {
  const code = `
    const { tryOwnership, ownOrJoin, location } = await import(process.argv[1]);
    const loc = location(process.argv[2], 'web');
    const claim = process.argv[3] === 'true' ? await ownOrJoin(loc) : { release: await tryOwnership(loc.lock) };
    const held = typeof claim.release === 'function';
    process.send({ held });
    if (held) process.on('message', () => { claim.release(); process.exit(0); });
    else process.disconnect();
  `;
  return spawn(process.execPath, [...nodeFlags, '--input-type=module', '-e', code, moduleUrl, root, String(wait)],
    { cwd, env: { ...process.env, PREVUE_HOME: state }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
}

async function acquired(child: ChildProcess) {
  const [message] = await once(child, 'message', { signal: AbortSignal.timeout(10000) });
  return (message as { held: boolean }).held;
}

function terminate(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

test('a stalled owner retains its kernel lock and a waiter recovers after an abrupt exit', { timeout: 15000 }, async t => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-ownership-')));
  const state = path.join(temp, 'state');
  const dir = path.join(state, 'rn', path.basename(location(temp, 'web').parent), 'web');
  await mkdir(dir, { recursive: true });
  t.after(() => rm(temp, { recursive: true, force: true }));
  const holder = contender(temp, state, false);
  t.after(() => terminate(holder));
  assert.equal(await acquired(holder), true);
  if (process.platform !== 'win32') holder.kill('SIGSTOP');
  const challenger = contender(temp, state, false);
  t.after(() => terminate(challenger));
  assert.equal(await acquired(challenger), false);
  const waiter = contender(temp, state, true);
  t.after(() => terminate(waiter));
  const replacement = acquired(waiter);
  const exit = once(holder, 'exit');
  holder.kill('SIGKILL');
  await exit;
  assert.equal(await replacement, true);
  const waiterExit = once(waiter, 'exit');
  waiter.send('release');
  await waiterExit;
});

test('concurrent startup failures release ownership and remove incomplete captures', { timeout: 20000 }, async t => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-failed-start-')));
  const state = path.join(temp, 'state');
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, 'package.json'), '{"name":"incomplete","dependencies":{"react-native":"*"}}');
  await writeFile(path.join(temp, 'Broken.preview.tsx'), 'export {};');
  const dir = path.join(state, 'rn', path.basename(location(temp, 'web').parent), 'web');
  const interrupted = '1234567890abcdef';
  await mkdir(path.join(dir, 'captures', interrupted), { recursive: true });
  await mkdir(path.join(dir, 'captures', 'published'));
  await writeFile(path.join(dir, 'starting-capture'), interrupted);
  async function show() {
    const child = spawn(process.execPath, [...nodeFlags, path.join(cwd, 'src/cli.ts'), 'show', 'Broken.preview.tsx'], {
      cwd: temp, env: { ...process.env, PREVUE_HOME: state },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    t.after(() => terminate(child));
    let out = '';
    child.stdout.on('data', value => { out += String(value); });
    const [exit] = await once(child, 'exit');
    assert.notEqual(exit, 0);
    const result = JSON.parse(out);
    assert.equal(result.ok, false);
    assert.ok(['ADAPTER_UNAVAILABLE', 'WEB_DEPENDENCY_MISSING'].includes(result.error.code), result.error.code);
  }
  await Promise.all([show(), show()]);
  assert.deepEqual(await readdir(path.join(dir, 'captures')), ['published']);
  await assert.rejects(readFile(path.join(dir, 'starting-capture')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(dir, 'instance.json')), { code: 'ENOENT' });
  const next = contender(temp, state, false);
  t.after(() => terminate(next));
  assert.equal(await acquired(next), true);
  const exit = once(next, 'exit');
  next.send('release'); await exit;
});

test('joins a verified running instance recorded before kernel ownership was introduced', { timeout: 10000 }, async t => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-legacy-owner-')));
  const state = path.join(temp, 'state');
  t.after(() => rm(temp, { recursive: true, force: true }));
  const { key, parent } = location(temp, 'web');
  const dir = path.join(state, 'rn', path.basename(parent), 'web');
  await mkdir(dir, { recursive: true });
  const peer = createServer((req, res) => {
    const ok = req.url === '/identity' || req.url === '/health' && req.headers.authorization === 'Bearer test-value';
    res.writeHead(ok ? 200 : 401).end(JSON.stringify({ key }));
  });
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { peer.close(() => resolve()); peer.closeAllConnections(); }));
  const address = peer.address();
  assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(dir, 'instance.json'), JSON.stringify({ key, root: temp, platform: 'web', pid: process.pid,
    token: 'test-value', url: 'http://127.0.0.1:' + address.port }));
  const joining = contender(temp, state, true);
  t.after(() => terminate(joining));
  assert.equal(await acquired(joining), false);
});
