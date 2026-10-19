import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLocations } from '../src/lib/detect.js';

const near = (a, b, eps = 1e-3) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;
const TOKYO = [139.7671, 35.6812];

const hits = [
  ['東京駅は 35.6812, 139.7671 にあります', TOKYO, '35.6812, 139.7671'],
  ['位置: 35°40\'52.3"N 139°46\'1.6"E です', TOKYO, '35°40\'52.3"N 139°46\'1.6"E'],
  ['北緯35度40分52秒 東経139度46分1秒 付近', TOKYO, '北緯35度40分52秒 東経139度46分1秒'],
  ['緯度：35.6812、経度：139.7671', TOKYO],
  ['{"lat": 35.6812, "lng": 139.7671}', TOKYO],
  ['Lat 35.6812 Lon 139.7671', TOKYO],
  ['N35.6812 E139.7671', TOKYO],
  ['35.6812N 139.7671E', TOKYO],
  ['354052N 1394601E', TOKYO, '354052N 1394601E'],
  ['MGRS 54SUE8843349290 にて', TOKYO, '54SUE8843349290'],
  ['MGRS 54S UE 88433 49290', TOKYO, '54S UE 88433 49290'],
  ['UTM 54N 388433 3949290 にて', TOKYO, '54N 388433 3949290'],
  ['UTM 54S 388433 3949290 にて', TOKYO, '54S 388433 3949290'], // S は緯度帯（北緯 32〜40 度）
  ['54 S 388433mE 3949290mN', TOKYO],
  ['31U 448252 5411935', [2.2945, 48.8582]],
  ['56H 334000 6252000', [151.2055, -33.8593]],
  ['56S 334000 6252000', [151.2055, -33.8593]], // 帯 S に収まらないので南半球
  ['19F 500000 3950000', [-69, -54.5975]],
  ['geohash: xn76urx4', [139.767, 35.681], 'geohash: xn76urx4'],
  ['ハッシュ xn76urx4 です', [139.767, 35.681], 'xn76urx4'],
  ['WKT: POINT(139.7671 35.6812)', TOKYO, 'POINT(139.7671 35.6812)'],
  ['POINT Z (139.7671 35.6812 10)', TOKYO],
  ['35.6812° 139.7671°', TOKYO],
  ['-33.8688, 151.2093 Sydney', [151.2093, -33.8688]],
  ['＝３５．６８１２，１３９．７６７１', TOKYO],
  // 緯度 4 桁・経度 5 桁の度分
  ['3541N 13946E', [139.7667, 35.6833], '3541N 13946E'],
  ['地点 3541 13946 付近', [139.7667, 35.6833], '3541 13946'],
  ['3541.5, 13946.2', [139.77, 35.6917]],
  // 全角のゆれ
  ['３５４１Ｎ　１３９４６Ｅ', [139.7667, 35.6833], '３５４１Ｎ　１３９４６Ｅ'],
  ['Ｎ３５．６８１２ Ｅ１３９．７６７１', TOKYO],
  ['３５゜４０′５２″Ｎ １３９゜４６′１″Ｅ', TOKYO],
  ['ＭＧＲＳ ５４ＳＵＥ８８４３３４９２９０', TOKYO, '５４ＳＵＥ８８４３３４９２９０'],
  ['ＰＯＩＮＴ（１３９．７６７１　３５．６８１２）', TOKYO, 'ＰＯＩＮＴ（１３９．７６７１　３５．６８１２）'],
];
for (const [text, expected, match] of hits) {
  test(`detects: ${text}`, () => {
    const r = findLocations(text);
    assert.equal(r.length, 1, JSON.stringify(r));
    const g = r[0].geometry;
    assert.ok(near(g.center ?? g.coordinates, expected, 2e-3), JSON.stringify(r[0]));
    if (match) assert.equal(r[0].text, match);
  });
}

test('GeoHash はセルの Polygon（中心つき）', () => {
  const [r] = findLocations('geohash: xn76');
  assert.equal(r.geometry.type, 'Polygon');
  const ring = r.geometry.coordinates[0];
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  assert.ok(near(ring[0], [139.5703125, 35.5078125], 1e-9) && near(ring[2], [139.921875, 35.68359375], 1e-9), JSON.stringify(ring));
  assert.ok(near(r.geometry.center, [139.74609375, 35.595703125], 1e-9));
});

test('WKT LINESTRING / POLYGON / MULTIPOLYGON / GEOMETRYCOLLECTION', () => {
  const t = 'a LINESTRING (30 10, 10 30, 40 40) b POLYGON ((30 10, 40 40, 20 40, 10 20, 30 10)) c ' +
    'MULTIPOLYGON (((30 20, 45 40, 10 40, 30 20)), ((15 5, 40 10, 10 20, 5 10, 15 5))) d ' +
    'GEOMETRYCOLLECTION (POINT (40 10), LINESTRING (10 10, 20 20, 10 40)) e MULTIPOINT ((10 40), (40 30)) f MULTIPOINT (10 40, 40 30)';
  const r = findLocations(t);
  assert.deepEqual(r.map((x) => x.geometry.type), ['LineString', 'Polygon', 'MultiPolygon', 'GeometryCollection', 'MultiPoint', 'MultiPoint']);
});

const misses = [
  'version 1.2, 3.4 released',
  'price 12.50, 13.75',
  'The dog ate breakfast quickly',
  'Call 03-1234-5678 now',
  'ISBN 978-4-06-123456-7',
  'https://example.com/abc123def',
  '2024-10-17 12:34:56',
  'score 100.123, 200.456',
  'temperature 35.5°C',
  'deadbeefcafe',
  '2024 10000円',
  '9100 13946',
  '3561 13946',
];
for (const text of misses) {
  test(`ignores: ${text}`, () => assert.deepEqual(findLocations(text), []));
}

// ---- 別々の要素にある緯度と経度 ----
import { axisFromContext, findLoneAngles, pairLoneAngles } from '../src/lib/detect.js';

const lone = (text, gap, context) => ({ ...findLoneAngles(text)[0], gap, context: context ? axisFromContext(context) : undefined });
const pairs = [
  ['unlabeled DMS, longitude first', [lone('(任意)138度 55分 59.1599秒', Infinity), lone('(任意)35度 58分 40.4399秒', 4)], [138.93310, 35.97790]],
  ['labels in the same element', [lone('経度 138度 55分 59.1599秒', Infinity), lone('緯度 35度 58分 40.4399秒', 0)], [138.93310, 35.97790]],
  ['北緯 / 東経 in separate cells', [lone('北緯35度41分14秒', Infinity), lone('東経139度45分51秒', 0)], [139.76417, 35.68722]],
  ['decimals with labels in other cells', [lone('35.681236', Infinity, '緯度'), lone('139.767125', 2, '経度')], [139.767125, 35.681236]],
  ['南緯 label gives a negative latitude', [lone('33.8688', Infinity, '南緯'), lone('151.2093', 2, '東経')], [151.2093, -33.8688]],
];
for (const [name, items, expected] of pairs) {
  test(`pairs: ${name}`, () => {
    const r = pairLoneAngles(items);
    assert.equal(r.length, 1);
    assert.ok(near(r[0].geometry.coordinates, expected, 1e-4), JSON.stringify(r[0]));
  });
}
test('does not pair unlabeled decimals', () => assert.deepEqual(pairLoneAngles([lone('35.681236', Infinity), lone('139.767125', 2)]), []));
test('does not pair values far apart', () => assert.deepEqual(pairLoneAngles([lone('138度55分59秒', Infinity), lone('35度58分40秒', 100)]), []));
test('does not pair two latitudes', () => assert.deepEqual(pairLoneAngles([lone('北緯35度41分14秒', Infinity), lone('北緯36度41分14秒', 0)]), []));
test('pairs full-width values in separate cells', () => {
  const r = pairLoneAngles([lone('北緯３５度４１分１４秒', Infinity), lone('東経１３９度４５分５１秒', 0)]);
  assert.ok(near(r[0].geometry.coordinates, [139.76417, 35.68722], 1e-4), JSON.stringify(r));
});
test('lone angles keep original offsets', () => {
  const [a] = findLoneAngles('ａ Ｎ３５度４１分', {}, []);
  assert.deepEqual([a.start, a.end, a.text, a.value], [2, 9, 'Ｎ３５度４１分', 'N35度41分']);
});
test('ignores degrees without minutes (temperatures)', () => assert.deepEqual(findLoneAngles('気温35度'), []));
