/**
 * Service Worker: 地図画像の生成（OffscreenCanvas）と、動かせる地図のタブを開く処理。
 * 国境データは最初の要求で読み込み、ワーカーが止まるまで保持する。
 */
import { fetchPlaces, sourceKey } from './lib/arcgis.js';
import { STORAGE_KEY, loadConfig } from './lib/config.js';
import { ENTRIES_KEY, META_KEY } from './lib/gazetteer.js';
import { loadGeoData } from './lib/geodata.js';
import { locate } from './lib/locate.js';
import { drawMap, fitBounds } from './lib/render.js';

let configPromise = null;
let dataPromise = null;

const getConfig = () => (configPromise ??= loadConfig());
const getData = () => (dataPromise ??= loadGeoData((name) => chrome.runtime.getURL(`data/${name}`)));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && STORAGE_KEY in changes) configPromise = null;
});

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function render(geometry, dpr) {
  const [config, data] = await Promise.all([getConfig(), getData()]);
  const { width, height, padding } = config.image;
  const ratio = Math.min(Math.max(dpr || 1, 1), 3);
  const located = locate(data, geometry, config.image);
  const canvas = new OffscreenCanvas(Math.round(width * ratio), Math.round(height * ratio));
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const view = fitBounds(located.bbox, width, height, { padding });
  drawMap(ctx, data, view, config, { highlight: located.highlight, geometry });
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return {
    image: `data:image/png;base64,${toBase64(new Uint8Array(await blob.arrayBuffer()))}`,
    countries: located.countries.map(({ name, iso3, iso2 }) => ({ name, iso3, iso2 })),
  };
}

/** 一覧用: 各ジオメトリのある国。 */
async function describe(geometries) {
  const [config, data] = await Promise.all([getConfig(), getData()]);
  return geometries.map((g) => locate(data, g, config.image).countries.map(({ name, iso3 }) => ({ name, iso3 })));
}

// 地図タブに渡す内容は URL に入りきらないことがあるので、session ストレージ経由で渡す（新しいものから MAX_MAPS 件だけ残す）
const MAX_MAPS = 30;
async function openMap(items, sourceTabId, opener) {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const { mapKeys = [] } = await chrome.storage.session.get('mapKeys');
  const keys = [...mapKeys, `map:${id}`];
  const old = keys.splice(0, Math.max(0, keys.length - MAX_MAPS));
  await chrome.storage.session.set({ [`map:${id}`]: { items, sourceTabId }, mapKeys: keys });
  if (old.length) await chrome.storage.session.remove(old);
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`map.html?id=${id}`),
    index: opener ? opener.index + 1 : undefined,
    openerTabId: opener?.id,
  });
  return { ok: true };
}

// ---- 地名データ（ArcGIS フィーチャーサービス）の取得とキャッシュ ----

// 取得に失敗したあと、ページを開くたびに取り直さないよう、自動の取り直しはこの間隔を空ける
const RETRY_MS = 60 * 60 * 1000;
let refreshing = null;

/** 地名を取得して chrome.storage.local に置く。取得中に呼ばれたら同じ取得を待つ。 */
function refreshGazetteer(settings) {
  return (refreshing ??= (async () => {
    const source = sourceKey(settings);
    const { [META_KEY]: old } = await chrome.storage.local.get(META_KEY);
    const attemptedAt = Date.now();
    try {
      const entries = await fetchPlaces(settings);
      await chrome.storage.local.set({
        [ENTRIES_KEY]: { source, entries },
        [META_KEY]: { source, fetchedAt: attemptedAt, count: entries.length, attemptedAt },
      });
      return { ok: true, count: entries.length };
    } catch (e) {
      const error = String(e?.message ?? e);
      // 前回の取得結果は残す（同じ設定ならそのまま使い続ける）
      await chrome.storage.local.set({ [META_KEY]: { ...(old?.source === source ? old : { source }), attemptedAt, error } });
      return { ok: false, error };
    }
  })().finally(() => (refreshing = null)));
}

/** ページを開いたとき: キャッシュがない・設定が変わった・期限切れなら取り直す。 */
async function ensureGazetteer() {
  const { gazetteer: s } = await getConfig();
  if (!s.enabled || !s.url.trim() || refreshing) return { ok: true };
  const { [META_KEY]: meta } = await chrome.storage.local.get(META_KEY);
  const now = Date.now();
  if (meta?.source === sourceKey(s)) {
    if (meta.error && now - meta.attemptedAt < RETRY_MS) return { ok: true };
    if (meta.fetchedAt && (!(s.maxAgeHours > 0) || now - meta.fetchedAt < s.maxAgeHours * 3600_000)) return { ok: true };
  }
  return refreshGazetteer(s);
}

// ツールバーのアイコンでサイドパネル（検出一覧）を開く
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(sendResponse, (e) => sendResponse({ error: String(e?.message ?? e) }));
    return true;
  };
  switch (msg?.type) {
    case 'getConfig':
      return reply(getConfig());
    case 'render':
      return reply(render(msg.geometry, msg.dpr));
    case 'describe':
      return reply(describe(msg.geometries));
    case 'openMap': {
      // ページから: sender.tab が元のタブ。サイドパネルから: msg.tabId で元のタブを指定する
      const sourceTabId = sender.tab?.id ?? msg.tabId;
      const opener = sender.tab ? Promise.resolve(sender.tab) : chrome.tabs.get(msg.tabId).catch(() => null);
      return reply(opener.then((tab) => openMap(msg.items, sourceTabId, tab)));
    }
    case 'refreshGazetteer':
      // 設定画面から: 保存直後は getConfig が古いことがあるので、設定を一緒に受け取る
      return reply(msg.settings ? refreshGazetteer(msg.settings) : getConfig().then((c) => refreshGazetteer(c.gazetteer)));
    case 'ensureGazetteer':
      return reply(ensureGazetteer());
    case 'locationsChanged':
      if (sender.tab) {
        chrome.action.setBadgeText({ tabId: sender.tab.id, text: msg.count ? String(msg.count) : '' });
        chrome.action.setBadgeBackgroundColor({ tabId: sender.tab.id, color: '#E53935' });
      }
      return false;
  }
  return false;
});
