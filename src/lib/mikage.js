/**
 * MIKAGE（QGIS のプラグイン）に検出した位置を送る。MIKAGE は QGIS の中で http://127.0.0.1:<ポート> を待ち受け、
 * 受け取った図形をレイヤーグループ「受け取った図形」に追加して地図をそこへ移動する（MIKAGE の README「外部から図形を受け取る」）。
 *
 * 送るのは Service Worker（background.js）から: manifest の host_permissions（127.0.0.1・localhost）があるので、
 * ページの CORS や Chrome のローカル ネットワーク アクセスの確認に止められない。
 * 本文は MIKAGE のパラメーター（画像ビューアのリンクと同じ）を JSON にしたもの: { geojson: FeatureCollection, name }。
 */
const KIND_LABEL = { latlon: '緯度経度', mgrs: 'MGRS', utm: 'UTM', geohash: 'GeoHash', wkt: 'WKT', place: '地名' };
/** MIKAGE が待ち受けるのはこの PC の中だけ。送信先もここに限る（設定を誤ってもページの内容を外へ送らない）。 */
const LOOPBACK = /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;
/** MIKAGE からの応答を待つ時間（ms）。 */
export const TIMEOUT_MS = 15000;

/** 送信先の URL（末尾の / を除く）。この PC 以外なら null。 */
export function mikageBase(url) {
  const t = String(url ?? '').trim().replace(/\/+$/, '');
  const m = LOOPBACK.exec(t);
  if (!m || (m[1] && !(Number(m[1]) > 0 && Number(m[1]) <= 65535))) return null;
  return t;
}

/** GeoJSON のジオメトリだけを取り出す（GeoHash のセルの center など、検出で付けた項目は送らない）。 */
function plainGeometry(g) {
  if (g.type === 'GeometryCollection') return { type: g.type, geometries: g.geometries.map(plainGeometry) };
  return { type: g.type, coordinates: g.coordinates };
}

/** ラベル・レイヤー名の長さの上限（WKT など長い文字列は地図上で読めないので縮める）。 */
export const LABEL_MAX = 40;

/** 空白をまとめ、長ければ先頭 max 文字＋「…」に。 */
export function shortText(text, max = LABEL_MAX) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * 送る本文。各位置を Feature にし、元の文字列をラベル（label）、種類・地名・元のページを属性にする。
 * ラベルが長い（WKT など）ときは縮め、元の文字列全体は text に入れる。
 * レイヤー名（name）は 1 件ならそのラベル（地名なら名前）、複数ならページのタイトルと件数。
 * @param items 検出した位置 [{ text, kind, geometry, name? }]  @param page 元のページ { title, url }
 */
export function mikageBody(items, page = {}) {
  const title = shortText(page.title, 60);
  const features = items.map((item) => {
    const label = shortText(item.text);
    const properties = { label, kind: KIND_LABEL[item.kind] ?? item.kind };
    if (label !== String(item.text ?? '').trim()) properties.text = String(item.text);
    if (item.name) properties.place = item.name;
    if (title) properties.page_title = title;
    if (page.url) properties.page_url = page.url;
    return { type: 'Feature', geometry: plainGeometry(item.geometry), properties };
  });
  const name = items.length === 1 ? shortText(items[0].name || items[0].text) : `${title || 'AutoMap'}（${items.length} 件）`;
  return { geojson: { type: 'FeatureCollection', features }, name };
}

/**
 * MIKAGE に送る（Service Worker から）。成功なら { ok: true, count, layer, errors }、失敗なら { ok: false, error }（日本語の理由）。
 * @param url 送信先（config.mikage.url）
 */
export async function sendToMikage(url, items, page, { fetch: fetchFn = fetch, timeout = TIMEOUT_MS } = {}) {
  const base = mikageBase(url);
  if (!base) return { ok: false, error: `送信先「${url}」は使えません（設定の MIKAGE の送信先は http://127.0.0.1:ポート）` };
  if (!items?.length) return { ok: false, error: '送る位置がありません' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let res;
  try {
    res = await fetchFn(`${base}/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mikageBody(items, page)),
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    clearTimeout(timer);
    if (e?.name === 'AbortError') return { ok: false, error: `MIKAGE から ${timeout / 1000} 秒たっても応答がありません（QGIS が処理中か、止まっている可能性があります）` };
    return {
      ok: false,
      error: `MIKAGE に接続できませんでした。QGIS が起動していて MIKAGE が有効か確かめてください（送信先 ${base}。MIKAGE の入った QGIS を 2 つ開いているときは先に開いた方が受け取ります）`,
    };
  }
  let answer = null;
  try {
    answer = await res.json();
  } catch {
    answer = null;
  } finally {
    clearTimeout(timer);
  }
  if (answer?.app !== 'MIKAGE') return { ok: false, error: `送信先 ${base} は MIKAGE ではありません（HTTP ${res.status}）` };
  if (!res.ok || !answer.ok) {
    const why = answer.error ?? `HTTP ${res.status}`;
    const hint = res.status === 403 ? '（MIKAGE の設定ファイルの shapeReceiver.origins を確かめてください）' : '';
    return { ok: false, error: `MIKAGE が受け取りませんでした: ${why}${hint}` };
  }
  return { ok: true, count: answer.count, layer: answer.layer, errors: answer.errors ?? [] };
}

/** 結果を 1 行で。 */
export function resultText(res) {
  if (!res?.ok) return res?.error ?? 'MIKAGE に送れませんでした';
  const skipped = res.errors?.length ? `。読めなかったもの ${res.errors.length} 件: ${res.errors.slice(0, 3).join(' / ')}` : '';
  return `MIKAGE に ${res.count} 個送りました（レイヤー「${res.layer}」）${skipped}`;
}
