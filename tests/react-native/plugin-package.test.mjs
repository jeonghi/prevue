import assert from 'node:assert/strict';
import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checkout = fileURLToPath(new URL('../../', import.meta.url));
const read = file => readFileSync(file, 'utf8');
const json = file => JSON.parse(read(file));

for (const [host, marketplaceFile] of [
  ['codex', '.agents/plugins/marketplace.json'],
  ['claude', '.claude-plugin/marketplace.json'],
]) {
  test(host + ' installs the RN entry, runtime, viewer and setup guide from this checkout', () => {
    const { source } = json(path.join(checkout, marketplaceFile)).plugins.find(entry => entry.name === 'prevue');
    if (host === 'codex') assert.equal(source.source, 'local');
    const pluginPath = host === 'codex' ? source.path : source;
    assert.equal(pluginPath, './plugin');
    const pkg = path.join(checkout, pluginPath);
    for (const entry of ['bin/prevue', 'bin/prevue-rn']) accessSync(path.join(pkg, entry), constants.X_OK);
    for (const file of ['rn-runtime/src/cli.ts', 'rn-runtime/src/web/index.ts', 'rn-runtime/src/native/index.ts',
      'rn-runtime/package-lock.json', 'rn-runtime/packages/react-native/index.js', 'rn-runtime/packages/native-host/package.json']) {
      accessSync(path.join(pkg, file), constants.R_OK);
    }

    const viewer = path.join(pkg, 'viewer');
    const html = read(path.join(viewer, 'index.html'));
    const assets = [...html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)].map(match => match[1]);
    assert.ok(assets.includes('js/viewer.js'));
    for (const asset of assets) accessSync(path.join(viewer, asset), constants.R_OK);

    const manifest = json(path.join(pkg, '.' + host + '-plugin', 'plugin.json'));
    const skill = read(path.join(pkg, manifest.skills, 'prevue', 'SKILL.md'));
    assert.ok(skill.includes('(cd "$PREVUE/rn-runtime" && npm ci)'));
    assert.ok(skill.includes('"$PREVUE/rn-runtime/node_modules/.bin/playwright" install chromium'));
  });
}
