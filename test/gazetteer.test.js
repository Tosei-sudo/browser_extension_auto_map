import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPlaces } from '../src/lib/arcgis.js';
import { buildMatcher, findPlaceNames } from '../src/lib/gazetteer.js';

const SETTINGS = {
  url: 'https://example.com/arcgis/rest/services/Places/FeatureServer/0/', where: '1=1', nameField: 'NAME',
  readingField: 'KANA', lonField: '', latField: '', pageSize: 2, maxFeatures: 100,
};

/** ページごとに決まった応答を返す fetch。呼ばれた URL を記録する。 */
function fakeFetch(pages) {
  const calls = [];
  const fn = async (url) => {
    calls.push(new URL(url));
    const offset = Number(new URL(url).searchParams.get('resultOffset'));
    return { ok: true, json: async () => pages[offset / 2] };
  };
  return { fn, calls };
}

test('ページ送りしながら取得し、ジオメトリから位置を読む', async () => {
  const { fn, calls } = fakeFetch([
    {
      exceededTransferLimit: true,
      features: [
        { attributes: { NAME: '東京', KANA: 'とうきょう' }, geometry: { x: 139.7671, y: 35.6812 } },
        { attributes: { NAME: '琵琶湖' }, geometry: { rings: [[[135.8, 34.9], [136.3, 34.9], [136.3, 35.5], [135.8, 35.5]]] } },
      ],
    },
    { features: [{ attributes: { NAME: '  ' }, geometry: { x: 1, y: 1 } }, { attributes: { NAME: '大阪' }, geometry: { x: 135.5, y: 34.7 } }] },
  ]);
  const entries = await fetchPlaces(SETTINGS, { fetch: fn });
  assert.deepEqual(entries, [['東京', 139.7671, 35.6812, 'とうきょう'], ['琵琶湖', 136.05, 35.2], ['大阪', 135.5, 34.7]]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].pathname, '/arcgis/rest/services/Places/FeatureServer/0/query');
  assert.equal(calls[1].searchParams.get('resultOffset'), '2');
  assert.equal(calls[0].searchParams.get('outSR'), '4326');
  assert.equal(calls[0].searchParams.get('outFields'), 'NAME,KANA');
});

test('緯度・経度の属性を指定するとジオメトリを使わない', async () => {
  const { fn, calls } = fakeFetch([{ features: [{ attributes: { NAME: '札幌', LON: '141.35', LAT: '43.06' } }] }]);
  const entries = await fetchPlaces({ ...SETTINGS, readingField: '', lonField: 'LON', latField: 'LAT' }, { fetch: fn });
  assert.deepEqual(entries, [['札幌', 141.35, 43.06]]);
  assert.equal(calls[0].searchParams.get('returnGeometry'), 'false');
});

test('サービスのエラーを伝える', async () => {
  const { fn } = fakeFetch([{ error: { code: 400, message: 'Invalid field' } }]);
  await assert.rejects(fetchPlaces(SETTINGS, { fetch: fn }), /Invalid field/);
});

const matcher = buildMatcher([
  ['東京', 139.7671, 35.6812, 'とうきょう'],
  ['東京都', 139.69, 35.69],
  ['京都', 135.76, 35.01],
  ['Kyoto', 135.76, 35.01],
  ['港', 139.75, 35.66],
]);
const found = (text, ranges) => findPlaceNames(text, matcher, ranges).map((f) => [f.text, f.name]);

test('文中の地名を最長一致で探す', () => {
  assert.deepEqual(found('東京都と京都に行く'), [['東京都', '東京都'], ['京都', '京都']]);
  assert.deepEqual(found('とうきょうえき'), [['とうきょう', '東京']]);
  assert.deepEqual(found('港へ'), []); // minLength（既定 2）より短い名前は使わない
});

test('英数字の名前は単語の一部では検出しない', () => {
  assert.deepEqual(found('Kyoto, Kyotoite'), [['Kyoto', 'Kyoto']]);
});

test('ほかの検出結果と重なる地名は除く', () => {
  assert.deepEqual(found('東京 京都', [{ start: 0, end: 2 }]), [['京都', '京都']]);
});

test('地名がなければ null', () => {
  assert.equal(buildMatcher([]), null);
  assert.deepEqual(findPlaceNames('東京', null), []);
});
