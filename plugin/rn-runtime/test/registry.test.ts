import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { definePreview } from '@prevue/react-native';
import { discover, findProject } from '../src/registry.ts';

async function project(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'prevue-discovery-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function write(file: string, contents: string) {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
    return target;
  }
  return { root, write };
}

const preview = "import { definePreview } from '@prevue/react-native';\nexport const Default = definePreview({ render: () => null });";

test('SDK preserves initial props, providers and component identity without invoking callbacks', () => {
  const definition = {
    props: { count: 3 },
    render: (_props: { count: number }) => { throw new Error('rendered during declaration'); },
    provider: () => { throw new Error('mounted during declaration'); },
  };
  assert.equal(definePreview(definition), definition);
});

test('discovers aliased SDK imports, namespace calls and local exports without executing project code', async t => {
  const { root, write } = await project(t);
  const sentinel = path.join(root, 'executed');
  await write('Cart.preview.tsx', [
    "import { definePreview as make, type definePreview as TypeOnly } from '@prevue/react-native';",
    "import * as sdk from '@prevue/react-native';",
    "import { definePreview } from 'other-sdk';",
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(sentinel)}, 'side effect');`,
    "throw new Error('preview module executed');",
    "const viewport = { width: 320, height: 400, pixelRatio: 1.5 } as const;",
    "const common = { viewport, theme: 'dark', platforms: ['web', 'ios', 'web'] } as const;",
    "export const Primary = make({ ...common, name: 'Cart', render: () => <form /> });",
    "const variant = sdk.definePreview({ render() { return null; } });",
    "export { variant as Compact };",
    "export const WrongSDK = definePreview({});",
    "export const JustAType = TypeOnly({});",
    "function nested() { const Hidden = make({}); }",
    "export default sdk.definePreview({ render: () => null });",
  ].join('\n'));
  await write('nested/Cart.preview.jsx', preview);
  await write('unused.tsx', preview);
  await write('deps/side-effect.preview.ts', preview);
  const items = await discover(root);
  assert.deepEqual(items.map(item => item.source.exportName), ['Primary', 'Compact', 'default', 'Default']);
  assert.equal(items[0].name, 'Cart');
  assert.deepEqual(items[0].source, { file: 'Cart.preview.tsx', line: 9, column: 14, exportName: 'Primary' });
  assert.deepEqual(items[0].viewport, { width: 320, height: 400, pixelRatio: 1.5 });
  assert.equal(items[0].theme, 'dark');
  assert.deepEqual(items[0].platforms, ['web', 'ios']);
  assert.equal(items[1].name, 'Compact');
  assert.deepEqual(items[1].platforms, ['web', 'ios', 'android']);
  assert.equal(items[3].source.file, 'nested/Cart.preview.jsx');
  await assert.rejects(access(sentinel), { code: 'ENOENT' });
});

test('IDs depend on project-relative source and export, across edits and independent checkouts', async t => {
  const a = await project(t);
  const b = await project(t);
  await a.write('ui/Card.preview.tsx', preview);
  await a.write('detail/Card.preview.tsx', preview);
  await b.write('ui/Card.preview.tsx', preview);
  const [detail, first] = await discover(a.root);
  assert.notEqual(first.id, detail.id);
  assert.equal((await discover(b.root))[0].id, first.id);
  await a.write('ui/Card.preview.tsx', '\n\n' + preview.replace('() => null', '() => <hr />'));
  const [, updated] = await discover(a.root);
  assert.equal(updated.id, first.id);
  assert.equal(updated.source.line, first.source.line + 2);
  await a.write('ui/Card.preview.tsx', preview.replace('const Default', 'const Renamed'));
  assert.notEqual((await discover(a.root))[1].id, first.id);
});

test('temporary syntax errors keep a diagnostic until the source is repaired', async t => {
  const { root, write } = await project(t);
  await write('Order.preview.tsx', preview);
  const [good] = await discover(root);
  await write('Order.preview.tsx', preview.replace('null', '<Text>'));
  await assert.rejects(discover(root), /Order\.preview\.tsx:2:\d+:/);
  await write('Order.preview.tsx', preview);
  assert.deepEqual(await discover(root), [good]);
});

test('computed metadata reports an actionable error without invoking expressions', async t => {
  const { root, write } = await project(t);
  await write('Order.preview.tsx', preview.replace('render:', 'theme: sideEffect(), render:'));
  await assert.rejects(discover(root), /Order\.preview\.tsx:2:\d+: Preview theme needs a static string/);
  await write('Order.preview.tsx', preview.replace('render:', 'viewport: { width: 0, height: 120 }, render:'));
  await assert.rejects(discover(root), /Invalid preview viewport\.width/);
});

test('discovery skips dependencies, output directories, linked folders and nested worktrees', async t => {
  const { root, write } = await project(t);
  for (const ignored of ['node_modules/lib', 'ios/Pods/lib', 'android/app/build', '.cache', 'other-worktree', 'dist']) {
    await write(ignored + '/File.preview.jsx', preview);
  }
  await write('other-worktree/.git', 'gitdir: /elsewhere');
  await write('src/File.preview.tsx', preview);
  await symlink(path.join(root, 'src'), path.join(root, 'link'), 'dir');
  assert.deepEqual((await discover(root)).map(item => item.source.file), ['src/File.preview.tsx']);
});

test('nearest native package owns the file even inside another app; real paths identify the checkout', async t => {
  const { root, write } = await project(t);
  await write('package.json', JSON.stringify({ dependencies: { 'react-native': '0.82.1' } }));
  await write('apps/mobile/package.json', JSON.stringify({ dependencies: { 'react-native': 'catalog:' } }));
  await write('apps/mobile/src/package.json', JSON.stringify({ name: 'screen-tools' }));
  const file = await write('apps/mobile/src/views/Card.preview.tsx', preview);
  const app = path.join(root, 'apps/mobile');
  assert.equal(await findProject(file), app);
  await symlink(app, path.join(root, 'mobile-link'), 'dir');
  assert.equal(await findProject(path.join(root, 'mobile-link/src/views')), app);
  await write('other-worktree/.git', 'gitdir: /elsewhere');
  const unrelated = await write('other-worktree/package.json', '{}');
  await assert.rejects(findProject(unrelated), /No React Native or Expo package/);
});

test('npm workspace root resolves exactly one RN member and reports ambiguous choices', async t => {
  const { root, write } = await project(t);
  await write('package.json', JSON.stringify({ workspaces: { packages: ['apps/*', 'packages/*'] } }));
  await write('apps/mobile/package.json', JSON.stringify({ dependencies: { expo: '^54' } }));
  await write('apps/site/package.json', JSON.stringify({ dependencies: { react: '19' } }));
  await write('unlisted/package.json', JSON.stringify({ dependencies: { 'react-native': '*' } }));
  await write('apps/other-checkout/.git', 'gitdir: /another/checkout');
  await write('apps/other-checkout/package.json', JSON.stringify({ dependencies: { 'react-native': '*' } }));
  assert.equal(await findProject(root), path.join(root, 'apps/mobile'));
  await write('packages/design/package.json', JSON.stringify({ peerDependencies: { 'react-native': '*' } }));
  await assert.rejects(findProject(root), /apps\/mobile, packages\/design/);
});

test('pnpm workspace package patterns respect exclusions', async t => {
  const { root, write } = await project(t);
  await write('pnpm-workspace.yaml', "packages:\n  - 'apps/**'\n  - '!apps/examples/**'\n");
  const manifest = JSON.stringify({ dependencies: { 'react-native': 'catalog:' } });
  await write('apps/shop/package.json', manifest);
  await write('apps/examples/demo/package.json', manifest);
  assert.equal(await findProject(root), path.join(root, 'apps/shop'));
});

test('shipped fixtures expose the three order states and all interactive examples', async () => {
  const root = fileURLToPath(new URL('../../../fixtures/react-native-web/', import.meta.url));
  const descriptors = await discover(root);
  const variants = descriptors.filter(item => item.source.file === 'OrderCard.preview.tsx');
  assert.deepEqual(variants.map(item => item.name), ['Default', 'Loading', 'Error']);
  assert.deepEqual(variants[0].viewport, { width: 360, height: 320 });
  assert.deepEqual(descriptors.slice(3).map(item => item.name),
    ['Button', 'TextInput', 'List', 'ScrollView', 'Modal', 'Empty', 'Dark', 'Navigation']);
  assert.equal(descriptors.find(item => item.name === 'Dark')?.theme, 'dark');
  assert.equal(await findProject(path.join(root, 'examples')), await realpath(root));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.match(manifest.devDependencies['@prevue/react-native'], /^file:/);
});
