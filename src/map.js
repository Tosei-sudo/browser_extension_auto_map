/**
 * 別タブの動かせる地図（OpenLayers）。
 * 国境は scripts/build-data.mjs の出力を表示倍率に応じて 3 段階で切り替えて表示する。
 * 色はホバー画像と同じ設定（config.colors / config.map）を使う。
 */
import 'ol/ol.css';
import Map from 'ol/Map.js';
import View from 'ol/View.js';
import Feature from 'ol/Feature.js';
import Point from 'ol/geom/Point.js';
import Polygon from 'ol/geom/Polygon.js';
import GeoJSON from 'ol/format/GeoJSON.js';
import VectorLayer from 'ol/layer/Vector.js';
import VectorSource from 'ol/source/Vector.js';
import { Circle, Fill, Stroke, Style } from 'ol/style.js';
import { ScaleLine, defaults as defaultControls } from 'ol/control.js';
import { getCenter } from 'ol/extent.js';
import { fromLonLat, toLonLat, transformExtent } from 'ol/proj.js';
import { formatDms, formatLatLon, formatMgrs, formatUtm } from '../coordinate-notation/dist/cdn/coordinate-notation.min.js';
import { loadConfig } from './lib/config.js';
import { LEVEL_TOLERANCE, SCALE, findCountry, loadGeoData } from './lib/geodata.js';
import { expandToMinSpan, locate } from './lib/locate.js';
import { cellSizeText } from './lib/geohash.js';
import { geometryBbox, imageViewerUrl } from './lib/wkt.js';

const KIND_LABEL = { latlon: '緯度経度', mgrs: 'MGRS', utm: 'UTM', geohash: 'GeoHash', wkt: 'WKT', place: '地名' };
// 赤道での 1 度の長さ（m）。表示解像度（m/px）と間引き許容誤差（度）の換算に使う
const METERS_PER_DEGREE = 111319.49;
const R = 6378137;
// 国境データの出典（CC BY 4.0 の表示義務。変更を加えた旨も示す）
const BOUNDARY_ATTRIBUTION =
  '国境: <a href="https://datacatalog.worldbank.org/search/dataset/0038272" target="_blank" rel="noopener">World Bank Official Boundaries</a>' +
  ' © The World Bank, <a href="https://creativecommons.org/licenses/by/4.0/deed.ja" target="_blank" rel="noopener">CC BY 4.0</a>' +
  '（形状の簡略化・属性の削減を行って使用）';

const statusEl = document.getElementById('status');

/** 表示する位置。background.js が session ストレージに { items: [{id, text, kind, geometry}], sourceTabId } を置く。 */
async function loadParams() {
  const id = new URLSearchParams(location.search).get('id');
  if (!id) return null;
  const key = `map:${id}`;
  return (await chrome.storage.session.get(key))[key] ?? null;
}

/** 国境データ 1 レベル分を OpenLayers の地物にする（座標は EPSG:3857 に変換）。 */
function levelFeatures(level, highlight) {
  const features = [];
  const c = level.coords;
  for (let f = 0; f < level.featureCount; f++) {
    const r0 = level.featStart[f];
    const r1 = level.featStart[f + 1];
    if (r0 === r1) continue;
    const p0 = level.ringStart[r0];
    const flat = new Float64Array((level.ringStart[r1] - p0) * 2);
    for (let p = p0, i = 0; p < level.ringStart[r1]; p++, i += 2) {
      const lat = Math.max(-85.06, Math.min(85.06, c[2 * p + 1] / SCALE));
      flat[i] = ((c[2 * p] / SCALE) * Math.PI * R) / 180;
      flat[i + 1] = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    }
    const ends = [];
    for (let r = r0; r < r1; r++) ends.push((level.ringStart[r + 1] - p0) * 2);
    // 1 つの Polygon にすべてのリング（島・穴）を入れる。OpenLayers は 2 つめ以降を穴の向きにそろえるが、
    // 塗りは nonzero 規則なので、離れた島は塗られ、外周の中にある穴は抜ける
    const feature = new Feature(new Polygon(Array.from(flat), 'XY', ends));
    feature.set('index', f);
    feature.set('highlight', highlight.has(f));
    features.push(feature);
  }
  return features;
}

/** 間引きレベル i を使う解像度（m/px）の範囲。ホバー画像（lib/render.js の pickLevel）と同じ基準。 */
function resolutionRange(i) {
  const lower = (t) => (t / 0.7) * METERS_PER_DEGREE;
  return {
    minResolution: i < LEVEL_TOLERANCE.length - 1 ? lower(LEVEL_TOLERANCE[i]) : undefined,
    maxResolution: i > 0 ? lower(LEVEL_TOLERANCE[i - 1]) : undefined,
  };
}

function countryLayer(level, highlight, config, i) {
  const stroke = config.map.borderWidth > 0 ? new Stroke({ color: config.colors.border, width: config.map.borderWidth }) : undefined;
  const styles = {
    true: new Style({ fill: new Fill({ color: config.colors.highlightCountry }), stroke, zIndex: 1 }),
    false: new Style({ fill: new Fill({ color: config.colors.otherCountry }), stroke, zIndex: 0 }),
  };
  return new VectorLayer({
    source: new VectorSource({ features: levelFeatures(level, highlight), wrapX: true, attributions: BOUNDARY_ATTRIBUTION }),
    style: (feature) => styles[feature.get('highlight')],
    renderOrder: null,
    updateWhileInteracting: false,
    ...resolutionRange(i),
  });
}

/** 検出した位置の層。選ばれている位置（selected()）は大きく描いて手前に出す。 */
function geometryLayer(items, config, selected) {
  const colors = config.colors;
  const marker = (scale, geometry) =>
    new Style({
      image: new Circle({
        radius: config.map.markerRadius * scale,
        fill: new Fill({ color: colors.marker }),
        stroke: new Stroke({ color: colors.markerStroke, width: 2 * scale }),
      }),
      geometry,
      zIndex: scale > 1 ? 2 : 1,
    });
  // 線や面が印より小さくて見えにくいときに、中心（GeoHash ならセルの中心）へ添える印
  const center = (f) => new Point(f.get('center') ?? getCenter(f.getGeometry().getExtent()));
  const styles = (scale) => ({
    marker: marker(scale),
    dot: marker(scale, center),
    shape: new Style({
      fill: new Fill({ color: colors.geometryFill }),
      stroke: new Stroke({ color: colors.geometryStroke, width: config.map.geometryWidth * scale }),
      zIndex: scale > 1 ? 2 : 1,
    }),
  });
  const normal = styles(1);
  const big = styles(1.5);
  const format = new GeoJSON();
  const features = items.map((item) => {
    const f = new Feature(format.readGeometry(item.geometry, { featureProjection: 'EPSG:3857' }));
    f.set('item', item);
    if (item.geometry.center) f.set('center', fromLonLat(item.geometry.center));
    return f;
  });
  return new VectorLayer({
    source: new VectorSource({ features, wrapX: true }),
    style: (f, resolution) => {
      const s = f.get('item').id === selected() ? big : normal;
      const g = f.getGeometry();
      if (/Point/.test(g.getType())) return s.marker;
      const [x0, y0, x1, y1] = g.getExtent();
      return Math.max(x1 - x0, y1 - y0) / resolution < 2 * config.map.markerRadius ? [s.shape, s.dot] : s.shape;
    },
    zIndex: 10,
  });
}

const countryText = (countries, max = Infinity) => {
  if (!countries.length) return '海上';
  const names = countries.slice(0, max).map((c) => `${c.name} (${c.iso3})`).join(' / ');
  return countries.length > max ? `${names} ほか ${countries.length - max} か国` : names;
};
const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** 1 件の詳細（座標の各表記と国）。 */
function detailRows(item, countries) {
  const g = item.geometry;
  const rows = [];
  if (item.name) rows.push(['地名', item.name]);
  // GeoHash のセルは中心の座標を出す
  const p = g.type === 'Point' ? g.coordinates : g.center;
  if (p) {
    if (g.center) rows.push(['セル', cellSizeText(g)]);
    rows.push([g.center ? '中心' : '緯度経度', formatLatLon(p)], ['度分秒', formatDms(p)]);
    const mgrs = formatMgrs(p);
    const utm = formatUtm(p);
    if (mgrs) rows.push(['MGRS', mgrs]);
    if (utm) rows.push(['UTM', utm]);
  } else {
    const [w, s, e, n] = geometryBbox(g);
    rows.push(['範囲', `${s.toFixed(5)}, ${w.toFixed(5)} 〜 ${n.toFixed(5)}, ${e.toFixed(5)}`]);
  }
  rows.push(['国', countryText(countries)]);
  return rows;
}

function showDetail(item, countries) {
  const g = item.geometry;
  document.getElementById('kind').textContent = `${KIND_LABEL[item.kind] ?? item.kind}${g.center ? '（セル）' : g.type !== 'Point' ? `（${g.type}）` : ''}`;
  const dl = document.getElementById('info');
  dl.textContent = '';
  for (const [k, v] of detailRows(item, countries)) {
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dl.append(dt, dd);
  }
  document.getElementById('viewer').href = imageViewerUrl(g);
  document.getElementById('viewer').hidden = false;
}

async function main() {
  const params = await loadParams();
  const items = params?.items ?? [];
  if (!items.length) {
    statusEl.textContent = '表示する位置がありません（ブラウザを再起動すると、以前開いた地図の内容は消えます）';
    return;
  }
  const config = await loadConfig();
  document.getElementById('map').style.background = config.colors.ocean;

  // 国の判定と初期表示範囲は高精度データで行う（1 件ならホバー画像と同じ範囲になる）
  const data = await loadGeoData((name) => `data/${name}`, [0, 1, 2]);
  const located = items.map((item) => locate(data, item.geometry, config.image));
  const highlight = new Set(located.flatMap((l) => [...l.highlight]));
  // 1 件ならホバー画像と同じ範囲（国全体など）。複数件なら国の範囲ではなく、位置そのものが収まる範囲に寄せる
  const bbox =
    items.length === 1
      ? located[0].bbox
      : expandToMinSpan(items.map((it) => geometryBbox(it.geometry)).reduce(union), config.image.minSpanDeg);

  let selected = items.length === 1 ? items[0].id : null;
  const single = items.length === 1;
  const title = single ? items[0].text : `${items.length} 件の位置`;
  document.title = `AutoMap - ${title}`;
  document.getElementById('title').textContent = title;
  if (single) showDetail(items[0], located[0].countries);

  const toExtent = (b) => transformExtent(b, 'EPSG:4326', 'EPSG:3857');
  const fitOptions = () => {
    // 左上の情報パネルに隠れない位置に収める（画面が狭いときはパネルの分を空けない）
    const { width, height } = map.getTargetElement().getBoundingClientRect();
    const p = config.image.padding;
    const panel = document.querySelector('.panel').getBoundingClientRect();
    const left = panel.right + 16 < width * 0.6 ? panel.right + 16 : width * p;
    return { padding: [height * p, width * p, height * p, left] };
  };
  const marks = geometryLayer(items, config, () => selected);
  const map = new Map({
    target: 'map',
    layers: [...data.levels.map((level, i) => countryLayer(level, highlight, config, i)), marks],
    view: new View({ center: fromLonLat([0, 0]), zoom: 2, maxZoom: 21 }),
    controls: defaultControls({ attributionOptions: { collapsible: false } }).extend([new ScaleLine()]),
  });
  document.getElementById('reset').onclick = () => map.getView().fit(toExtent(bbox), { ...fitOptions(), duration: 300 });

  // 複数件のときは一覧を出し、選ぶとその位置へ寄って詳細を表示する
  const list = document.getElementById('items');
  const select = (index, zoom) => {
    selected = items[index].id;
    marks.changed();
    showDetail(items[index], located[index].countries);
    for (const li of list.children) li.classList.toggle('selected', Number(li.dataset.index) === index);
    list.children[index]?.scrollIntoView({ block: 'nearest' });
    if (zoom) map.getView().fit(toExtent(located[index].bbox), { ...fitOptions(), duration: 300 });
  };
  if (!single) {
    items.forEach((item, i) => {
      const li = document.createElement('li');
      li.dataset.index = i;
      const text = document.createElement('div');
      text.textContent = item.text;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = countryText(located[i].countries, 3);
      li.append(text, sub);
      li.onclick = () => select(i, true);
      list.append(li);
    });
    list.hidden = false;
    const all = document.getElementById('viewerAll');
    all.href = imageViewerUrl({ type: 'GeometryCollection', geometries: items.map((it) => it.geometry) });
    all.hidden = false;
  }
  map.getView().fit(toExtent(bbox), fitOptions());

  // 地図上の位置にマウスを乗せると元の文字列、クリックで元のページの該当箇所へ
  const label = document.getElementById('label');
  const itemAt = (pixel) => map.forEachFeatureAtPixel(pixel, (f) => f.get('item'), { layerFilter: (l) => l === marks, hitTolerance: 4 });
  map.on('click', async (e) => {
    const item = itemAt(e.pixel);
    if (!item) return;
    if (!single) select(items.indexOf(item), false);
    if (params.sourceTabId == null) return;
    try {
      const tab = await chrome.tabs.update(params.sourceTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.sendMessage(params.sourceTabId, { type: 'revealLocation', id: item.id });
    } catch {
      statusEl.textContent = '元のページが見つかりません（閉じられたか、移動した可能性があります）';
    }
  });

  // マウス位置の座標と国名
  let hoverTimer = 0;
  let cursor = null;
  let hoverName = '';
  const updateStatus = () => {
    const parts = [`ズーム ${map.getView().getZoom().toFixed(1)}`];
    if (cursor) parts.push(formatLatLon(cursor));
    if (hoverName) parts.push(hoverName);
    statusEl.textContent = parts.join('　');
  };
  map.on('pointermove', (e) => {
    const item = e.dragging ? null : itemAt(e.pixel);
    map.getTargetElement().style.cursor = item ? 'pointer' : '';
    label.hidden = !item;
    if (item) {
      label.textContent = params.sourceTabId != null ? `${item.text}（クリックでページの該当箇所へ）` : item.text;
      label.style.left = `${e.pixel[0] + 14}px`;
      label.style.top = `${e.pixel[1] + 14}px`;
    }
    const [lon, lat] = toLonLat(e.coordinate);
    cursor = [((((lon + 180) % 360) + 360) % 360) - 180, lat];
    updateStatus();
    if (hoverTimer) return;
    hoverTimer = setTimeout(() => {
      hoverTimer = 0;
      const hit = findCountry(data, cursor[0], cursor[1]);
      hoverName = hit ? `${hit.country.name} (${hit.country.iso3})` : '';
      updateStatus();
    }, 80);
  });
  map.getView().on('change:resolution', updateStatus);
  updateStatus();
}

main().catch((e) => {
  statusEl.textContent = `エラー: ${e.message}`;
  console.error(e);
});
