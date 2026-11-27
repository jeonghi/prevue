import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { discover } from '../src/registry.ts';
import { createWebRenderer } from '../src/web/index.ts';
import { createExpoRenderer } from '../src/expo/index.ts';
import { ProjectSession } from '../src/session.ts';
import type { RenderResult } from '../src/protocol.ts';

async function scratch(t: TestContext, name: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-adapter-')));
  const fixture = fileURLToPath(new URL('../../../fixtures/' + name + '/', import.meta.url));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, {
    recursive: true,
    filter: (f) => !['node_modules', '.expo', '.git'].includes(path.basename(f)),
  });
  await symlink(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const artifacts = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-adapter-images-')));
  t.after(() => rm(artifacts, { recursive: true, force: true }));
  return { root, artifacts };
}
test('CSF meta, args, custom render and explicit mocks; unsupported story features remain errors', async (t) => {
  const { root, artifacts } = await scratch(t, 'react-native-web');
  await mkdir(path.join(root, 'mocks'));
  await writeFile(path.join(root, 'mocks/device.ts'), "export default 'fixture-device'");
  await writeFile(
    path.join(root, 'prevue.web.json'),
    JSON.stringify({ mocks: { 'rn.device': './mocks/device.ts' } })
  );
  const file = 'Shipment.stories.tsx';
  await writeFile(
    path.join(root, file),
    `import React from 'react'; import {Text} from 'react-native'; import device from 'rn.device';
    function Label({city}){return <Text>{city} {device}</Text>}
    export default {title:'Shipment',component:Label,args:{city:'Seoul'}};
    export const Default = {};
    export const Other = {args:{city:'Busan'},render: args=><Text>Port {args.city}</Text>};
    export const Decorated = {decorators:[Story=><Story/>]};`
  );
  const descriptors = (await discover(root)).filter((p) => p.source.file === file);
  assert.equal(descriptors.length, 3);
  const renderer = createWebRenderer();
  await renderer.prepare({ root, artifacts, platform: 'web', changed() {} });
  t.after(() => renderer.dispose());
  for (const [i, expected] of ['Seoul fixture-device', 'Port Busan'].entries()) {
    const result = await renderer.render({ preview: descriptors[i], generation: 1 });
    assert.equal(result.status, 'ready', result.error?.message);
    assert.ok((await readFile(result.treePath!, 'utf8')).includes(expected));
  }
  const denied = await renderer.render({ preview: descriptors[2], generation: 1 });
  assert.equal(denied.status, 'error');
  assert.equal(denied.error?.code, 'UNSUPPORTED_STORY');
});
test(
  'Expo SDK 54 uses its own Metro config, a React commit and a fresh bundle after a save',
  { timeout: 90000 },
  async (t) => {
    const { root, artifacts } = await scratch(t, 'react-native-expo');
    const core = new ProjectSession(root, 'web', createExpoRenderer());
    await core.init(artifacts);
    t.after(() => core.dispose());
    const file = 'MetroCard.preview.tsx';
    const first = (await core.execute('show', { file })) as {
      ok: boolean;
      cards: RenderResult[];
      generation: number;
    };
    assert.ok(first.ok, JSON.stringify(first.cards[0].error));
    assert.ok((await readFile(first.cards[0].treePath!, 'utf8')).includes('Expo 배송 조회'));
    const source = await readFile(path.join(root, file), 'utf8');
    await writeFile(path.join(root, file), source.replace('Expo 배송 조회', 'Expo 저장 확인'));
    const saved = (await core.execute('wait', {
      file,
      after: first.generation,
      timeout: 45,
    })) as typeof first;
    assert.ok(saved.ok, JSON.stringify(saved.cards[0].error));
    assert.ok(saved.generation > first.generation);
    assert.ok((await readFile(saved.cards[0].treePath!, 'utf8')).includes('Expo 저장 확인'));
    assert.notDeepEqual(await readFile(saved.cards[0].imagePath!), await readFile(first.cards[0].imagePath!));
  }
);
