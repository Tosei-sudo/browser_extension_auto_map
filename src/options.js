/** 設定画面。config.json の既定値との差分だけを chrome.storage.sync に保存する。 */
import { STORAGE_KEY, loadDefaults, merge } from './lib/config.js';
import { loadGeoData } from './lib/geodata.js';
import { locate } from './lib/locate.js';
import { drawMap, fitBounds } from './lib/render.js';

const LABELS = {
  colors: {
    _: '色',
    highlightCountry: '位置のある国',
    otherCountry: 'その他の国',
    ocean: '海洋',
    border: '国境線',
    marker: 'ポイント',
    markerStroke: 'ポイントの縁',
    geometryStroke: '線・面（WKT）の線',
    geometryFill: '面（WKT）の塗り',
    textHighlight: 'ページ内のハイライト',
  },
  map: { _: '地図', borderWidth: '国境線の太さ (px)', markerRadius: 'ポイントの半径 (px)', geometryWidth: '線・面の線の太さ (px)' },
  image: {
    _: 'ホバー画像',
    width: '幅 (px)',
    height: '高さ (px)',
    padding: '余白（割合 0〜0.4）',
    minSpanDeg: '最小表示範囲（度）',
    oceanSpanDeg: '海上の点の表示範囲（度）',
    maxCountrySpanDeg: '国全体を映す上限（度）',
  },
  detect: {
    _: '検出する表記',
    latlon: '緯度経度（度分秒・日本語表記含む）',
    plainDecimal: '記号のない小数の組（35.681, 139.767）',
    minDecimals: '上記の小数点以下の最小桁数',
    mgrs: 'MGRS',
    utm: 'UTM',
    geohash: 'GeoHash',
    wkt: 'WKT',
    splitPairs: '緯度と経度が別々の要素にあるものも組にする',
    pairMaxGap: '上記で組にする最大の間隔（文字数）',
  },
};

// 色の入力欄の右にあるカラーピッカーは #RRGGBB だけを扱えるので、それ以外の書き方では使わない
const isHex = (v) => /^#[0-9a-f]{6}$/i.test(v);

let defaults;
let current;
const form = document.getElementById('form');

function buildForm() {
  form.textContent = '';
  for (const [group, values] of Object.entries(defaults)) {
    const section = document.createElement('section');
    const h2 = document.createElement('h2');
    h2.textContent = LABELS[group]?._ ?? group;
    section.append(h2);
    for (const key of Object.keys(values)) {
      const value = current[group][key];
      const row = document.createElement('div');
      row.className = 'row';
      const label = document.createElement('label');
      label.textContent = LABELS[group]?.[key] ?? key;
      const id = `${group}.${key}`;
      label.htmlFor = id;
      row.append(label);
      if (typeof value === 'boolean') {
        const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked: value });
        input.addEventListener('change', () => update(group, key, input.checked));
        row.append(input);
      } else if (typeof value === 'number') {
        const input = Object.assign(document.createElement('input'), { type: 'number', id, value, step: 'any' });
        input.addEventListener('input', () => input.value !== '' && update(group, key, Number(input.value)));
        row.append(input);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'color';
        const text = Object.assign(document.createElement('input'), { type: 'text', id, value });
        const picker = Object.assign(document.createElement('input'), { type: 'color', value: isHex(value) ? value : '#000000' });
        picker.style.visibility = isHex(value) ? '' : 'hidden';
        text.addEventListener('input', () => {
          picker.style.visibility = isHex(text.value) ? '' : 'hidden';
          if (isHex(text.value)) picker.value = text.value;
          update(group, key, text.value);
        });
        picker.addEventListener('input', () => {
          text.value = picker.value.toUpperCase();
          update(group, key, text.value);
        });
        wrap.append(text, picker);
        row.append(wrap);
      }
      section.append(row);
    }
    form.append(section);
  }
}

function update(group, key, value) {
  current[group][key] = value;
  document.getElementById('saved').textContent = '';
  preview();
}

/** 既定値と違う値だけを取り出す。 */
function diff(base, value) {
  const out = {};
  for (const [k, v] of Object.entries(base)) {
    if (v && typeof v === 'object') {
      const d = diff(v, value[k]);
      if (Object.keys(d).length) out[k] = d;
    } else if (value[k] !== v) out[k] = value[k];
  }
  return out;
}

let data = null;
const SAMPLES = [
  { canvas: 'pv1', geometry: { type: 'Point', coordinates: [139.7671, 35.6812] } },
  { canvas: 'pv2', geometry: { type: 'LineString', coordinates: [[2.35, 48.85], [13.4, 52.52], [16.37, 48.21]] } },
];
function preview() {
  if (!data) return;
  const { width, height, padding } = current.image;
  for (const s of SAMPLES) {
    const canvas = document.getElementById(s.canvas);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const located = locate(data, s.geometry, current.image);
    drawMap(ctx, data, fitBounds(located.bbox, width, height, { padding }), current, { highlight: located.highlight, geometry: s.geometry });
  }
}

async function main() {
  defaults = await loadDefaults();
  const stored = await chrome.storage.sync.get(STORAGE_KEY);
  current = merge(defaults, stored[STORAGE_KEY]);
  buildForm();
  document.getElementById('save').onclick = async () => {
    await chrome.storage.sync.set({ [STORAGE_KEY]: diff(defaults, current) });
    document.getElementById('saved').textContent = '保存しました（開き直したページから反映されます）';
  };
  document.getElementById('reset').onclick = async () => {
    await chrome.storage.sync.remove(STORAGE_KEY);
    current = structuredClone(defaults);
    buildForm();
    preview();
    document.getElementById('saved').textContent = '既定値に戻しました';
  };
  data = await loadGeoData((name) => `data/${name}`, [0, 1]);
  preview();
}

main();
