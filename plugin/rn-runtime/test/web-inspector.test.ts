import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { PreviewDescriptor, UINode, UITree } from '../src/protocol.ts';
import { createWebRenderer } from '../src/web/index.ts';

function flatten(nodes: UINode[]): UINode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children)]);
}

const fixture = process.env.PREVUE_TEST_FIXTURE ?? fileURLToPath(new URL('../../../fixtures/react-native-web', import.meta.url));

test('maps only rendered RN host bindings to exact TSX positions and image pixels', { timeout: 45000 }, async t => {
  const workspace = await realpath(await mkdtemp(path.join(tmpdir(), 'prevue-inspector-')));
  const root = path.join(workspace, 'app');
  const components = path.join(root, 'src');
  await mkdir(components, { recursive: true });
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await symlink(path.join(fixture, 'node_modules'), path.join(workspace, 'node_modules'), 'dir');
  await writeFile(path.join(workspace, 'package.json'), '{"private":true,"workspaces":["app"]}');
  await writeFile(path.join(root, 'package.json'), '{"name":"inspect-app"}');
  await writeFile(path.join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['src/*'] }, jsx: 'react-jsx' } }));
  await writeFile(path.join(workspace, 'Outside.tsx'), "import {Text} from 'react-native'; export function Outside() { return <Text testID='external'>Shared</Text>; }");
  const relative = 'src/Scene.web.tsx';
  const authored = `import { useLayoutEffect, useState } from 'react';
import { View as Frame, Text as Label, TextInput } from 'react-native';
import * as RN from 'react-native';
import { Outside } from '../../Outside';

function Custom({ Label }) { return <Label />; }
function Opaque() { return <span data-testid="opaque">plain DOM wrapper</span>; }
function Inner() { return <Label testID="implemented">Inner implementation</Label>; }
export function Scene() {
  const [touched, setTouched] = useState(false);
  const [readback, setReadback] = useState('');
  useLayoutEffect(() => {
    const element = document.querySelector('[data-testid="card"]');
    setReadback([element.dataset.userFlag, element.dataset.prevueSource, window.datasetReads].join('|'));
  }, []);
  const attrs = {
    get dataSet() {
      window.datasetReads = (window.datasetReads ?? 0) + 1;
      return {userFlag:'last', prevueSource:'user-content'};
    },
  };
  return <Frame testID="card" dataSet={{userFlag:'first'}} {...attrs} style={{ padding:10 }}>
    <RN.Pressable testID="press" accessibilityRole="button" accessibilityLabel="Select order" onPress={() => setTouched(true)} style={{height:26}}>
      <Label testID="outer">Status <RN.Text testID="nested">{touched ? 'selected' : 'pending'}</RN.Text></Label>
    </RN.Pressable>
    <TextInput testID="field" accessibilityLabel="Order note" />
    <RN.ScrollView testID="scroller" style={{height:16}}><Label>Scroll content</Label></RN.ScrollView>
    <RN.Image testID="picture" style={{width:8,height:8}} source={{uri:'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4='}} />
    <Inner />
    <Custom Label={Opaque} />
    <Outside />
    <Label>{'Attributes ' + readback}</Label>
  </Frame>;
}`;
  await writeFile(path.join(root, relative), authored);
  await writeFile(path.join(root, 'Board.preview.tsx'), "import { definePreview } from '@prevue/react-native'; import {Scene} from '@app/Scene'; export const Default = definePreview({render: () => <Scene/>});");
  const preview: PreviewDescriptor = {
    id: 'inspect', name: 'Default', source: { file: 'Board.preview.tsx', exportName: 'Default', line: 1 },
    framework: 'react-native', platforms: ['web'], viewport: { width: 240, height: 250, pixelRatio: 1.5 },
  };
  const changed = new EventEmitter();
  const renderer = createWebRenderer();
  assert.equal(renderer.capabilities().sourceLocation, true);
  t.after(() => renderer.dispose());
  await renderer.prepare({ root, artifacts: path.join(root, '.cache'), platform: 'web', changed: file => { changed.emit(file); } });
  const session = await renderer.openSession({ preview, generation: 1 });
  t.after(() => session.close());
  const result = await session.capture();
  assert.equal(result.status, 'ready', JSON.stringify(result.error));
  const rawTree = await readFile(result.treePath!, 'utf8');
  assert.ok(!rawTree.includes('sourceToken'));
  const tree: UITree = JSON.parse(rawTree);
  assert.deepEqual([tree.width, tree.height], [360, 375]);
  const nodes = flatten(tree.nodes);
  const byId = (id: string) => nodes.find(node => node.testId === id)!;
  function position(source: string, text: string) {
    const index = source.indexOf(text);
    assert.ok(index >= 0);
    return { file: relative, line: source.slice(0, index).split('\n').length, column: index - source.lastIndexOf('\n', index - 1) };
  }
  for (const [id, name, jsx] of [
    ['card', 'View', '<Frame testID="card"'], ['press', 'Pressable', '<RN.Pressable testID="press"'],
    ['outer', 'Text', '<Label testID="outer"'], ['nested', 'Text', '<RN.Text testID="nested"'],
    ['scroller', 'ScrollView', '<RN.ScrollView testID="scroller"'], ['picture', 'Image', '<RN.Image testID="picture"'],
    ['field', 'TextInput', '<TextInput testID="field"'], ['implemented', 'Text', '<Label testID="implemented"'],
  ]) {
    assert.equal(byId(id).name, name);
    assert.deepEqual(byId(id).source, position(authored, jsx));
  }
  assert.equal(byId('opaque').source, null);
  assert.equal(byId('external').source, null);
  assert.equal(byId('press').accessibilityRole, 'button');
  assert.equal(byId('press').accessibilityLabel, 'Select order');
  assert.equal(byId('field').accessibilityRole, 'textbox');
  assert.ok(nodes.some(node => node.text === 'Attributes last|user-content|1'), 'JSX spread order, existing dataset and getter evaluation are preserved');
  const bounds = byId('press').bounds;
  assert.deepEqual([bounds.x, bounds.y, bounds.height], [15, 15, 39]);
  await session.dispatch({ type: 'tap', x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 });
  assert.equal(flatten((await session.inspect()).nodes).find(node => node.testId === 'nested')?.text, 'selected');
  const revised = '// New line before the component.\n' + authored;
  const invalidated = once(changed, path.join(root, relative), { signal: AbortSignal.timeout(10000) });
  await writeFile(path.join(root, relative), revised);
  await invalidated;
  const updated = await session.update({ preview, generation: 2 });
  assert.equal(updated.status, 'ready', JSON.stringify(updated.error));
  const live = flatten((await session.inspect()).nodes).find(node => node.testId === 'nested');
  assert.deepEqual(live?.source, position(revised, '<RN.Text testID="nested"'));
  assert.equal(live?.text, 'selected');
});
