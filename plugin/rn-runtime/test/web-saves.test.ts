import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { SavedFiles } from '../src/web/saved-files.ts';

test('a saved file produces one source revision across duplicate and overlapping watcher events', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'prevue-saves-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'Card.tsx');
  const saved = new SavedFiles();
  async function save(contents: string, time: number) {
    await writeFile(source, contents);
    await utimes(source, time, time);
  }
  await save('one', 1234567890);
  const events = await Promise.all([saved.changed(source), saved.changed(source)]);
  assert.equal(events.filter(Boolean).length, 1);
  await save('one', 1234567890);
  assert.equal(await saved.changed(source), false);
  await save('two', 1234567890);
  assert.equal(await saved.changed(source), true, 'same timestamp and size can contain a new edit');
  await save('two', 1234567891);
  assert.equal(await saved.changed(source), true, 'a new save time is visible to rn wait');
  await rm(source);
  assert.equal(await saved.changed(source), true);
  assert.equal(await saved.changed(source), false);
  await save('two', 1234567891);
  assert.equal(await saved.changed(source), true, 'recreating a preview is a new revision');
});
