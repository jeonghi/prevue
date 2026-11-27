import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PreviewDescriptor, UINode, UITree } from '../src/protocol.ts';
import { createWebRenderer } from '../src/web/index.ts';

function all(nodes: UINode[]): UINode[] {
  return nodes.flatMap(node => [node, ...all(node.children)]);
}

const fixture = process.env.PREVUE_TEST_FIXTURE ?? fileURLToPath(new URL('../../../fixtures/react-native-web', import.meta.url));

test('real RN Web commits, interaction, shared module refresh, failed generation and recovery', { timeout: 90000 }, async t => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-web-')));
  const root = path.join(workspace, 'app');
  const shared = path.join(workspace, 'ui');
  const artifacts = path.join(workspace, 'artifacts');
  await Promise.all([mkdir(root), mkdir(shared)]);
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await writeFile(path.join(workspace, 'package.json'), JSON.stringify({ private: true, workspaces: ['app', 'ui'] }));
  await symlink(path.join(fixture, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"name":"test-app","type":"module"}');
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@ui/*': ['../ui/*'] }, jsx: 'react-jsx' },
  }));
  await writeFile(path.join(shared, 'package.json'), '{"name":"test-ui","type":"module"}');
  await writeFile(path.join(shared, 'theme.ts'), "import { createContext } from 'react'; export const Label = createContext('missing');");
  await writeFile(path.join(root, 'prevue.providers.tsx'), "import { Label } from '@ui/theme'; export default function Provider({children}) { return <Label.Provider value='global'>{children}</Label.Provider>; }");
  await writeFile(path.join(shared, 'Counter.tsx'), "throw new Error('Expected .web.tsx resolution');");
  const component = path.join(shared, 'Counter.web.tsx');
  const source = (label: string, color: string) => `
    import { useContext, useState } from 'react';
    import { View, Pressable, TextInput, Text, useColorScheme } from 'react-native';
    import { Label } from './theme';
    export function Counter({title}) {
      const [count, setCount] = useState(0);
      const [value, setValue] = useState('');
      const theme = useColorScheme();
      return <View style={{backgroundColor:'${color}', padding:12}}>
        <Text>{useContext(Label) + '-' + title + '-' + theme + '-${label}'}</Text>
        <Pressable testID="add" onPress={() => setCount(n => n + 1)}><Text>{'Count ' + count}</Text></Pressable>
        <TextInput testID="input" value={value} onChangeText={setValue} />
        <Text>{'Typed ' + value}</Text>
      </View>;
    }`;
  await writeFile(component, source('first', '#dfebff'));
  const previewFile = 'Counter.preview.tsx';
  await writeFile(path.join(root, previewFile), `
    import { definePreview } from '@prevue/react-native';
    import { Counter } from '@ui/Counter';
    export const Default = definePreview({
      props:{title:'counter'}, provider: ({ children }) => <div aria-label="local">{children}</div>,
      render: props => <Counter {...props} />,
    });`);
  const preview: PreviewDescriptor = {
    id: 'counter', framework: 'react-native', source: { file: previewFile, line: 4, exportName: 'Default' },
    name: 'Default', platforms: ['web'], viewport: { width: 220, height: 180, pixelRatio: 2 }, theme: 'dark',
  };
  const changed = new EventEmitter();
  const renderer = createWebRenderer();
  t.after(() => renderer.dispose());
  await renderer.prepare({ root, artifacts, platform: 'web', changed(file) { changed.emit(file); } });
  const session = await renderer.openSession({ preview, generation: 1 });
  t.after(() => session.close());
  const first = await session.capture();
  assert.equal(first.status, 'ready', JSON.stringify(first.error));
  const firstImage = await readFile(first.imagePath!);
  assert.deepEqual([...firstImage.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual([first.width, first.height], [440, 360]);
  const tree: UITree = JSON.parse(await readFile(first.treePath!, 'utf8'));
  assert.deepEqual([tree.width, tree.height], [440, 360]);
  const nodes = all(tree.nodes);
  assert.ok(nodes.some(n => n.accessibilityLabel === 'local'));
  assert.ok(nodes.some(n => n.text === 'global-counter-dark-first'));
  for (const testId of ['add', 'input']) {
    const { bounds } = nodes.find(n => n.testId === testId)!;
    await session.dispatch({ type: 'tap', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  }
  await session.dispatch({ type: 'text', text: 'hello' });
  const live = await session.capture();
  assert.notEqual(live.imagePath, first.imagePath);
  const liveNodes = all((await session.inspect()).nodes);
  assert.ok(liveNodes.some(n => n.text === 'Count 1'));
  assert.ok(liveNodes.some(n => n.text === 'Typed hello'));
  const board = await renderer.render({ preview, generation: 1 });
  assert.equal(board.status, 'ready', JSON.stringify(board.error));
  assert.ok(all(JSON.parse(await readFile(board.treePath!, 'utf8')).nodes).some(n => n.text === 'Count 0'));

  async function edit(file: string, text: string) {
    const invalidated = once(changed, file, { signal: AbortSignal.timeout(10000) });
    await writeFile(file, text);
    await invalidated;
  }
  await edit(component, source('second', '#ffcc55'));
  const [old, second] = await Promise.all([session.capture(), session.update({ preview, generation: 2 })]);
  assert.equal(old.status, 'stale');
  assert.equal(second.status, 'ready', JSON.stringify(second.error));
  const updated = all(JSON.parse(await readFile(second.treePath!, 'utf8')).nodes);
  assert.ok(updated.some(n => n.text === 'global-counter-dark-second'));
  assert.ok(updated.some(n => n.text === 'Count 1'), 'Fast Refresh retains component state');
  assert.ok(updated.some(n => n.text === 'Typed hello'), 'the same provider preserves TextInput state');
  assert.notDeepEqual(await readFile(second.imagePath!), await readFile(live.imagePath!));

  await edit(component, 'export function Counter( {');
  const broken = await session.update({ preview, generation: 3 });
  assert.equal(broken.status, 'error');
  assert.equal(broken.error?.code, 'WEB_BUNDLE_FAILED');
  assert.equal(broken.imagePath, undefined);
  await edit(component, source('recovered', '#c3ffbb'));
  const recovered = await session.update({ preview, generation: 4 });
  assert.equal(recovered.status, 'ready', JSON.stringify(recovered.error));
  assert.ok(all((await session.inspect()).nodes).some(n => n.text === 'global-counter-dark-recovered'));
  await session.reset();
  assert.ok(all((await session.inspect()).nodes).some(n => n.text === 'Count 0'));
  const staged = component + '.tmp';
  await writeFile(staged, source('renamed', '#aaffbb'));
  const replaced = once(changed, component, { signal: AbortSignal.timeout(10000) });
  await rename(staged, component);
  await replaced;
  const atomic = await session.update({ preview, generation: 5 });
  assert.equal(atomic.status, 'ready', JSON.stringify(atomic.error));
  assert.ok(all((await session.inspect()).nodes).some(n => n.text === 'global-counter-dark-renamed'));
  await edit(component, source('after-rename', '#abcabc'));
  const subsequent = await session.update({ preview, generation: 6 });
  assert.equal(subsequent.status, 'ready', JSON.stringify(subsequent.error));
  assert.ok(all((await session.inspect()).nodes).some(n => n.text === 'global-counter-dark-after-rename'));
  const extra = path.join(root, 'New.preview.jsx');
  await edit(extra, 'export {}');
  const deleted = once(changed, extra, { signal: AbortSignal.timeout(10000) });
  await rm(extra);
  await deleted;
});

test('Metro image require, JSX in .web.js, project-only network and native module errors', { timeout: 45000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-assets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const api = createServer((_req, res) => { requests++; res.end('unexpected'); });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => api.close(() => resolve())));
  const address = api.address();
  assert.ok(address && typeof address !== 'string');
  await symlink(path.join(fixture, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  await writeFile(path.join(root, 'package.json'), '{"name":"asset-test"}');
  await writeFile(path.join(root, 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle fill="tomato" cx="8" cy="8" r="8"/></svg>');
  await writeFile(path.join(root, 'Badge.web.js'), `
    import { useState, useEffect } from 'react';
    import { Image, View, Text } from 'react-native';
    export function Badge() {
      const [network, setNetwork] = useState('loading');
      useEffect(() => {
        fetch('http://127.0.0.1:${address.port}/orders').then(() => setNetwork('unexpected'), () => setNetwork('isolated'));
      }, []);
      return <View><Image source={require('./mark.svg')} style={{width:16,height:16}}/><Text>{network}</Text></View>;
    }`);
  const file = 'Asset.preview.jsx';
  await writeFile(path.join(root, file), `
    import { definePreview } from '@prevue/react-native';
    import { Badge } from './Badge';
    export const Default = definePreview({render: () => <Badge/>});`);
  const preview: PreviewDescriptor = { id: 'asset', framework: 'react-native', name: 'Default', source: { file, line: 1, exportName: 'Default' }, platforms: ['web'] };
  const renderer = createWebRenderer();
  t.after(() => renderer.dispose());
  const changed = new EventEmitter();
  await renderer.prepare({ root, artifacts: path.join(root, '.cache'), platform: 'web', changed: file => { changed.emit(file); } });
  const result = await renderer.render({ preview, generation: 1 });
  assert.equal(result.status, 'ready', JSON.stringify(result.error));
  const nodes = all(JSON.parse(await readFile(result.treePath!, 'utf8')).nodes);
  assert.ok(nodes.some(node => node.text === 'isolated'));
  assert.equal(requests, 0);
  const change = once(changed, path.join(root, file), { signal: AbortSignal.timeout(10000) });
  await writeFile(path.join(root, file), "import 'react-native-missing-test-module'; export const Default = {};");
  await change;
  const broken = await renderer.render({ preview, generation: 2 });
  assert.equal(broken.status, 'error');
  assert.equal(broken.error?.code, 'WEB_NATIVE_MODULE_UNAVAILABLE', broken.error?.message);
  assert.match(broken.error.message, /react-native-missing-test-module/);
});
