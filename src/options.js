/** 設定画面。config.json の既定値との差分だけを chrome.storage.sync に保存する。 */
import { STORAGE_KEY, loadDefaults, merge } from './lib/config.js';
import { SERVICES_KEY, defaultServices, loadServices, metaKey, newService } from './lib/services.js';
import { invalidPatterns } from './lib/sites.js';
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
  sites: {
    _: 'サイト',
    exclude: '稼働しないサイト（URL の正規表現。1 行に 1 つ）',
  },
  detect: {
    _: '検出する表記',
    latlon: '緯度経度（度分秒・日本語表記含む）',
    plainDecimal: '記号のない小数の組（35.681, 139.767）',
    minDecimals: '上記の小数点以下の最小桁数',
    plainDegMin: '記号のない度分の組（緯度 4 桁・経度 5 桁、3541 13946）',
    mgrs: 'MGRS',
    utm: 'UTM',
    geohash: 'GeoHash',
    wkt: 'WKT',
    splitPairs: '緯度と経度が別々の要素にあるものも組にする',
    pairMaxGap: '上記で組にする最大の間隔（文字数）',
  },
  gazetteer: {
    _: '地名（ArcGIS フィーチャーサービス）',
    enabled: '地名を検出する',
    minLength: '検出する名前の最小文字数',
    maxAgeHours: 'キャッシュの有効期間（時間、0 は無期限）',
    pageSize: '1 回の要求で取得する件数',
    maxFeatures: '取得する最大件数',
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
    // サービスの一覧（gazetteerServices）は地名の section の中でサービスごとに編集する
    if (group === SERVICES_KEY) continue;
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
      } else if (Array.isArray(value)) {
        // 文字列の配列は 1 行に 1 つ書く
        const wrap = document.createElement('div');
        const input = Object.assign(document.createElement('textarea'), { id, value: value.join('\n'), rows: 4, spellcheck: false });
        const error = Object.assign(document.createElement('div'), { className: 'error' });
        const check = () => {
          const bad = group === 'sites' ? invalidPatterns(current[group][key]) : [];
          error.textContent = bad.length ? `正規表現として読めないため無視します: ${bad.join('、')}` : '';
        };
        input.addEventListener('input', () => {
          update(group, key, input.value.split('\n').map((s) => s.trim()).filter(Boolean));
          check();
        });
        check();
        wrap.append(input, error);
        row.append(wrap);
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
    if (group === 'gazetteer') section.append(servicesEditor());
    form.append(section);
  }
}

// ---- 地名データのサービス ----

const SERVICE_LABELS = {
  label: '名前（任意。一覧での見分け用）',
  enabled: '使う',
  url: 'レイヤーの URL（…/FeatureServer/0）',
  where: '取得する条件（where 句）',
  nameField: '名前の属性',
  readingField: '読みの属性（任意。読みでも検出する）',
  lonField: '経度の属性（任意。空ならジオメトリ）',
  latField: '緯度の属性（任意。空ならジオメトリ）',
};

let services = [];

/** 地名の section の下に、サービスごとの設定と取得ボタンを並べる。同じ名前は上のサービスが優先。 */
function servicesEditor() {
  const box = document.createElement('div');
  box.className = 'services';
  services.forEach((service, i) => {
    const fs = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = `サービス ${i + 1}`;
    fs.append(legend);
    for (const [key, text] of Object.entries(SERVICE_LABELS)) {
      const row = document.createElement('div');
      row.className = 'row';
      const id = `service-${service.id}-${key}`;
      const label = Object.assign(document.createElement('label'), { htmlFor: id, textContent: text });
      const input = typeof service[key] === 'boolean'
        ? Object.assign(document.createElement('input'), { type: 'checkbox', id, checked: service[key] })
        : Object.assign(document.createElement('input'), { type: 'text', id, value: service[key], className: 'wide' });
      input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
        service[key] = input.type === 'checkbox' ? input.checked : input.value;
        document.getElementById('saved').textContent = '';
      });
      row.append(label, input);
      fs.append(row);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    const fetchButton = Object.assign(document.createElement('button'), { type: 'button', textContent: '保存して地名データを取得' });
    const removeButton = Object.assign(document.createElement('button'), { type: 'button', textContent: '削除' });
    const status = Object.assign(document.createElement('span'), { className: 'status' });
    fetchButton.onclick = () => fetchService(service, fetchButton, status);
    removeButton.onclick = () => {
      services.splice(i, 1);
      buildForm();
      document.getElementById('saved').textContent = '削除は「保存」で確定します';
    };
    actions.append(fetchButton, removeButton, status);
    fs.append(actions);
    box.append(fs);
    showServiceStatus(service, status);
  });
  const add = Object.assign(document.createElement('button'), { type: 'button', textContent: 'サービスを追加' });
  add.onclick = () => {
    services.push(newService());
    buildForm();
  };
  box.append(add);
  return box;
}

async function fetchService(service, button, status) {
  let origin;
  try {
    origin = new URL(service.url.trim()).origin;
  } catch {
    status.textContent = 'URL が正しくありません';
    return;
  }
  // サービスのサイトへのアクセスを許可してもらう（CORS に対応していないサービスでも取得できるように）
  if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
    status.textContent = 'サイトへのアクセスが許可されませんでした';
    return;
  }
  await save();
  button.disabled = true;
  status.textContent = '取得中…';
  const res = await chrome.runtime
    .sendMessage({ type: 'refreshGazetteer', service, common: current.gazetteer })
    .catch((e) => ({ error: String(e) }));
  button.disabled = false;
  if (!res?.ok) status.textContent = `取得できませんでした: ${res?.error ?? ''}`;
  else showServiceStatus(service, status);
}

async function showServiceStatus(service, status) {
  const { [metaKey(service.id)]: meta } = await chrome.storage.local.get(metaKey(service.id));
  if (!meta) return;
  const parts = [];
  if (meta.fetchedAt) parts.push(`${meta.count} 件（${new Date(meta.fetchedAt).toLocaleString()} に取得）`);
  if (meta.error) parts.push(`前回の取得に失敗: ${meta.error}`);
  status.textContent = parts.join('　');
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
    if (k === SERVICES_KEY) continue; // サービスの一覧は SERVICES_KEY に別に保存する
    if (Array.isArray(v)) {
      if (JSON.stringify(v) !== JSON.stringify(value[k])) out[k] = value[k];
    } else if (v && typeof v === 'object') {
      const d = diff(v, value[k]);
      if (Object.keys(d).length) out[k] = d;
    } else if (value[k] !== v) out[k] = value[k];
  }
  return out;
}

async function save() {
  await chrome.storage.sync.set({ [STORAGE_KEY]: diff(defaults, current), [SERVICES_KEY]: services });
  document.getElementById('saved').textContent = '保存しました（開き直したページから反映されます）';
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
  services = await loadServices(defaults.gazetteerServices);
  buildForm();
  document.getElementById('save').onclick = save;
  document.getElementById('reset').onclick = async () => {
    await chrome.storage.sync.remove([STORAGE_KEY, SERVICES_KEY]);
    current = structuredClone(defaults);
    services = defaultServices(defaults.gazetteerServices);
    buildForm();
    preview();
    document.getElementById('saved').textContent = '既定値に戻しました';
  };
  data = await loadGeoData((name) => `data/${name}`, [0, 1]);
  preview();
}

main();
