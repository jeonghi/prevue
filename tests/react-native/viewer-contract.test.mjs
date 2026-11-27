import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../plugin/daemon/daemon/src/test/contract/', import.meta.url);
test('upstream viewer fixture defines stable card and focus fields', () => {
  for (const kind of ['board', 'focus']) {
    const {status, schema} = JSON.parse(readFileSync(new URL('viewer.state.' + kind + '.json', root), 'utf8'));
    assert.equal(status, 200);
    assert.equal(schema.version, 'number');
    assert.ok(Array.isArray(schema.tabs));
    assert.equal(schema.board.groups[0].cards[0].previewId, 'string');
    if (kind === 'focus') assert.equal(schema.focus.imageUrl, 'string');
  }
});
