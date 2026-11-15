import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mikageBase, mikageBody, resultText, sendToMikage } from '../src/lib/mikage.js';

const POINT = { id: 'a', text: '35.6812, 139.7671', kind: 'latlon', geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } };
const CELL = {
  id: 'b',
  text: 'xn76urx4',
  kind: 'geohash',
  geometry: { type: 'Polygon', coordinates: [[[139, 35], [140, 35], [140, 36], [139, 35]]], center: [139.5, 35.5] },
};
const PLACE = { id: 'c', text: '横須賀港', kind: 'place', name: '横須賀港', geometry: { type: 'Point', coordinates: [139.67, 35.28] } };

test('送信先はこの PC だけ', () => {
  assert.equal(mikageBase('http://127.0.0.1:47631/'), 'http://127.0.0.1:47631');
  assert.equal(mikageBase(' http://localhost:47631 '), 'http://localhost:47631');
  assert.equal(mikageBase('http://[::1]:47631'), 'http://[::1]:47631');
  for (const bad of ['https://127.0.0.1:47631', 'http://192.168.0.2:47631', 'http://127.0.0.1.evil.example', 'http://127.0.0.1:99999', '', null]) {
    assert.equal(mikageBase(bad), null, bad);
  }
});

test('本文は GeoJSON の FeatureCollection とレイヤー名', () => {
  const body = mikageBody([POINT, CELL], { title: '報告書', url: 'https://example.jp/r' });
  assert.equal(body.name, '報告書（2 件）');
  assert.deepEqual(body.geojson.features[0], {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [139.7671, 35.6812] },
    properties: { label: '35.6812, 139.7671', kind: '緯度経度', page_title: '報告書', page_url: 'https://example.jp/r' },
  });
  // 検出で付けた center は送らない
  assert.deepEqual(Object.keys(body.geojson.features[1].geometry), ['type', 'coordinates']);
  assert.equal(mikageBody([PLACE]).name, '横須賀港');
  assert.equal(mikageBody([PLACE]).geojson.features[0].properties.place, '横須賀港');
  assert.equal(mikageBody([POINT, PLACE]).name, 'AutoMap（2 件）');
});

test('長い文字列（WKT など）はラベル・レイヤー名を縮め、全体は text に', () => {
  const wkt = 'POLYGON ((139.6 35.2, 139.8 35.2,\n 139.8 35.4, 139.6 35.2))';
  const body = mikageBody([{ ...CELL, text: wkt, kind: 'wkt' }]);
  const { properties } = body.geojson.features[0];
  assert.equal(properties.label, 'POLYGON ((139.6 35.2, 139.8 35.2, 139.8…');
  assert.equal([...properties.label].length, 40);
  assert.equal(properties.text, wkt);
  assert.equal(body.name, properties.label);
  // 短いものに text は付けない
  assert.equal('text' in mikageBody([POINT]).geojson.features[0].properties, false);
});

/** MIKAGE の代わりの HTTP サーバー。handler(req, body) → [status, json]。 */
async function withServer(handler, run) {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [status, value] = handler(req, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(typeof value === 'string' ? value : JSON.stringify(value));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('送って MIKAGE の答えを返す', async () => {
  let received = null;
  const res = await withServer(
    (req, body) => {
      received = { method: req.method, url: req.url, type: req.headers['content-type'], body: JSON.parse(body) };
      return [200, { app: 'MIKAGE', ok: true, count: 1, layer: '35.6812, 139.7671', errors: [] }];
    },
    (url) => sendToMikage(url, [POINT], { title: 'p' }),
  );
  assert.deepEqual(res, { ok: true, count: 1, layer: '35.6812, 139.7671', errors: [] });
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/show');
  assert.equal(received.type, 'application/json');
  assert.equal(received.body.geojson.features.length, 1);
  assert.equal(resultText(res), 'MIKAGE に 1 個送りました（レイヤー「35.6812, 139.7671」）');
});

test('受け取らなかったとき・MIKAGE でないとき・つながらないときは理由を返す', async () => {
  const refused = await withServer(
    () => [403, { app: 'MIKAGE', ok: false, error: '送信元 chrome-extension://x からは受け取らない' }],
    (url) => sendToMikage(url, [POINT]),
  );
  assert.equal(refused.ok, false);
  assert.match(refused.error, /^MIKAGE が受け取りませんでした: 送信元 .* shapeReceiver\.origins/);
  const other = await withServer(() => [200, '<html>'], (url) => sendToMikage(url, [POINT]));
  assert.match(other.error, /は MIKAGE ではありません（HTTP 200）/);
  // サーバーを閉じたあとのポート
  const closed = await withServer(() => [200, {}], async (url) => url);
  const down = await sendToMikage(closed, [POINT]);
  assert.match(down.error, /^MIKAGE に接続できませんでした。QGIS が起動していて/);
  assert.match((await sendToMikage('http://example.com', [POINT])).error, /は使えません/);
  const slow = await sendToMikage('http://127.0.0.1:1', [POINT], {}, {
    timeout: 50,
    fetch: (u, o) => new Promise((_, reject) => o.signal.addEventListener('abort', () => reject(Object.assign(new Error('x'), { name: 'AbortError' })))),
  });
  assert.match(slow.error, /応答がありません/);
});
