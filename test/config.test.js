import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from '../src/lib/config.js';
import { defaultServices } from '../src/lib/services.js';

test('配列は丸ごと置き換え、既定値にないキーは無視する', () => {
  const defaults = { a: { x: 1, y: 'a' }, list: [] };
  assert.deepEqual(merge(defaults, { a: { x: 2, z: 3 }, list: [{ url: 'u' }], extra: 1 }), { a: { x: 2, y: 'a' }, list: [{ url: 'u' }] });
  assert.deepEqual(merge(defaults, { list: 'x' }), defaults);
});

test('既定のサービスに足りない項目と id を補う', () => {
  const [a, b] = defaultServices([{ url: 'https://a/FeatureServer/0' }, { id: 'b', url: 'https://b', nameField: 'MEI' }]);
  assert.equal(a.id, 'default-0');
  assert.equal(a.nameField, 'NAME');
  assert.equal(a.enabled, true);
  assert.equal(b.id, 'b');
  assert.equal(b.nameField, 'MEI');
});
