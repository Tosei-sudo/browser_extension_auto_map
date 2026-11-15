/**
 * サイドパネル: 表示中のタブで検出した位置の一覧。
 * 行のクリックでページの該当箇所へ移動、地図ボタンで 1 件、「すべて地図で表示」で表示中の全件を地図タブに出す。
 * 「MIKAGE」で 1 件、「MIKAGE に送る」で表示中の全件を MIKAGE（QGIS）に送る。
 */
import { formatLatLon } from '../coordinate-notation/dist/cdn/coordinate-notation.min.js';
import { loadConfig } from './lib/config.js';
import { cellSizeText } from './lib/geohash.js';
import { resultText } from './lib/mikage.js';
import { vertices } from './lib/wkt.js';

const KIND_LABEL = { latlon: '緯度経度', mgrs: 'MGRS', utm: 'UTM', geohash: 'GeoHash', wkt: 'WKT', place: '地名' };

const el = (id) => document.getElementById(id);
let tabId = null;
let items = [];
let countries = [];
let filter = 'all';
let selected = null;
let generation = 0;
/** 元のページ（MIKAGE に送る属性・地図タブの見出し）。 */
let page = {};
let mikageOn = true;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refresh() {
  const gen = ++generation;
  const tab = await activeTab();
  if (!tab) return;
  if (tab.id !== tabId) {
    filter = 'all';
    selected = null;
  }
  tabId = tab.id;
  page = { title: tab.title, url: tab.url };
  let res;
  try {
    res = await chrome.tabs.sendMessage(tab.id, { type: 'listLocations' });
  } catch {
    res = null; // 拡張機能が動かないページ（chrome:// など）か、読み込み中
  }
  if (gen !== generation) return;
  el('page').textContent = res?.title || tab.title || '';
  if (!res) {
    items = [];
    countries = [];
    render('このページでは検出していません（ブラウザの内部ページや、拡張機能を入れる前から開いていたページなど）。ページを再読み込みすると検出します。');
    return;
  }
  items = res.items;
  page = { title: res.title, url: res.url };
  countries = [];
  render();
  if (!items.length) return;
  const described = await chrome.runtime.sendMessage({ type: 'describe', geometries: items.map((i) => i.geometry) });
  if (gen !== generation || !Array.isArray(described)) return;
  countries = described;
  render();
}

function subText(item, i) {
  const g = item.geometry;
  const where = g.type === 'Point'
    ? formatLatLon(g.coordinates)
    : g.center
      ? `${formatLatLon(g.center)}（セル ${cellSizeText(g)}）`
      : `${g.type}（${[...vertices(g)].length} 点）`;
  const c = countries[i];
  const names = c?.map((x) => x.name) ?? [];
  const country = c ? (c.length ? `${names.slice(0, 3).join(' / ')}${names.length > 3 ? ` ほか ${names.length - 3} か国` : ''}` : '海上') : '';
  return [where, country].filter(Boolean).join('　');
}

const visibleItems = () => items.filter((it) => filter === 'all' || it.kind === filter);

function renderFilters() {
  const counts = {};
  for (const it of items) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
  const box = el('filters');
  box.textContent = '';
  const kinds = Object.keys(counts);
  if (kinds.length < 2) return;
  for (const kind of ['all', ...kinds]) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = kind === 'all' ? `すべて ${items.length}` : `${KIND_LABEL[kind] ?? kind} ${counts[kind]}`;
    b.setAttribute('aria-pressed', String(filter === kind));
    b.onclick = () => {
      filter = kind;
      render();
    };
    box.append(b);
  }
}

function render(emptyMessage) {
  const shown = visibleItems();
  el('count').textContent = `${items.length} 件`;
  el('showAll').disabled = !shown.length;
  el('showAll').textContent = filter === 'all' ? 'すべて地図で表示' : `${shown.length} 件を地図で表示`;
  el('sendAll').hidden = !mikageOn;
  el('sendAll').disabled = !shown.length;
  el('sendAll').textContent = filter === 'all' ? 'すべて MIKAGE に送る' : `${shown.length} 件を MIKAGE に送る`;
  renderFilters();
  const list = el('list');
  list.textContent = '';
  const empty = el('empty');
  empty.hidden = !!shown.length;
  empty.textContent = emptyMessage ?? 'このページには位置の記述が見つかりませんでした。';
  for (const item of shown) {
    const i = items.indexOf(item);
    const li = document.createElement('li');
    if (item.id === selected) li.className = 'selected';
    const text = document.createElement('div');
    text.className = 'text';
    const kind = document.createElement('span');
    kind.className = 'kind';
    kind.textContent = KIND_LABEL[item.kind] ?? item.kind;
    text.append(kind, item.text);
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = subText(item, i);
    const btn = document.createElement('button');
    btn.className = 'map-btn';
    btn.title = '地図で表示';
    btn.textContent = '地図';
    btn.onclick = (e) => {
      e.stopPropagation();
      openMap([item]);
    };
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(btn);
    if (mikageOn) {
      const send = document.createElement('button');
      send.className = 'mikage-btn';
      send.title = 'MIKAGE（QGIS）に送る';
      send.textContent = 'MIKAGE';
      send.onclick = (e) => {
        e.stopPropagation();
        sendToMikage([item], send);
      };
      actions.append(send);
    }
    li.append(text, actions, sub);
    li.onclick = () => {
      selected = item.id;
      for (const x of list.children) x.classList.toggle('selected', x === li);
      chrome.tabs.sendMessage(tabId, { type: 'revealLocation', id: item.id }).catch(() => {});
    };
    list.append(li);
  }
}

function openMap(list) {
  chrome.runtime.sendMessage({ type: 'openMap', items: list, tabId, page });
}

/** MIKAGE に送り、結果をヘッダーの下に出す（送っている間はボタンを押せない）。 */
let noteTimer = 0;
async function sendToMikage(list, button) {
  const note = el('note');
  button.disabled = true;
  clearTimeout(noteTimer);
  note.hidden = false;
  note.className = 'note';
  note.textContent = `MIKAGE に ${list.length} 件を送信中…`;
  const res = await chrome.runtime.sendMessage({ type: 'sendToMikage', items: list, page }).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
  button.disabled = false;
  note.className = res?.ok ? (res.errors?.length ? 'note warn' : 'note ok') : 'note err';
  note.textContent = resultText(res);
  if (res?.ok && !res.errors?.length) noteTimer = setTimeout(() => (note.hidden = true), 6000);
}

el('showAll').onclick = () => openMap(visibleItems());
el('sendAll').onclick = () => sendToMikage(visibleItems(), el('sendAll'));

// タブの切り替え・再読み込み・ページ内容の変化に合わせて一覧を更新する
let timer = 0;
const refreshSoon = () => {
  clearTimeout(timer);
  timer = setTimeout(refresh, 150);
};
chrome.tabs.onActivated.addListener(refreshSoon);
chrome.tabs.onUpdated.addListener((id, info) => {
  if (id === tabId && (info.status || info.title)) refreshSoon();
});
chrome.windows.onFocusChanged.addListener(refreshSoon);
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'locationsChanged' && sender.tab?.id === tabId) refreshSoon();
});

loadConfig()
  .then((config) => (mikageOn = config.mikage.enabled))
  .catch(() => {})
  .finally(refresh);
