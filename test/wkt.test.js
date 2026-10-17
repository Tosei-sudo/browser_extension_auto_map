import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageViewerUrl, parseWkt, toWkt } from '../src/lib/wkt.js';

const samples = [
  'POINT (139.7671 35.6812)',
  'LINESTRING (30 10, 10 30, 40 40)',
  'POLYGON ((35 10, 45 45, 15 40, 10 20, 35 10), (20 30, 35 35, 30 20, 20 30))',
  'MULTIPOINT (10 40, 40 30, 20 20)',
  'MULTILINESTRING ((10 10, 20 20), (40 40, 30 30))',
  'MULTIPOLYGON (((30 20, 45 40, 10 40, 30 20)), ((15 5, 40 10, 10 20, 5 10, 15 5)))',
  'GEOMETRYCOLLECTION (POINT (40 10), LINESTRING (10 10, 20 20, 10 40))',
];
for (const wkt of samples) test(`round trip: ${wkt.split(' ')[0]}`, () => assert.equal(toWkt(parseWkt(wkt)), wkt));

test('drops floating point noise', () => assert.equal(toWkt({ type: 'Point', coordinates: [139.76710000000001, -0.1 - 0.2] }), 'POINT (139.7671 -0.3)'));
test('imageViewerUrl encodes the WKT', () => {
  assert.equal(imageViewerUrl({ type: 'Point', coordinates: [139.7671, 35.6812] }), 'web+imageviewer:geom=POINT%20(139.7671%2035.6812)');
});
