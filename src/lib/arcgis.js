/**
 * ArcGIS フィーチャーサービス（レイヤー）から地名を取得する。
 * 標準の query エンドポイントを resultOffset / resultRecordCount でページ送りしながら呼び、
 * [名前, 経度, 緯度, 読み] の配列にする。座標は outSR=4326（WGS84）で受け取る。
 */

/** キャッシュがどの設定で作られたかを表す文字列。設定が変わったら作り直す。 */
export function sourceKey(s) {
  return JSON.stringify([s.url.trim(), s.where, s.nameField, s.readingField, s.lonField, s.latField]);
}

/** レイヤーの URL（末尾の / や /query は取り除く）。 */
const layerUrl = (url) => url.trim().replace(/\/+$/, '').replace(/\/query$/i, '');

/** 点以外のジオメトリは外接矩形の中心を位置とする。 */
function pointOf(g) {
  if (!g) return null;
  if (Number.isFinite(g.x) && Number.isFinite(g.y)) return [g.x, g.y];
  const pts = g.points ?? g.paths?.flat() ?? g.rings?.flat();
  if (!pts?.length) return null;
  let [minX, minY, maxX, maxY] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

const valid = (p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;

/**
 * @param s 設定の gazetteer（url, where, nameField, readingField, lonField, latField, pageSize, maxFeatures）
 * @returns {Promise<[string, number, number, string?][]>}
 */
export async function fetchPlaces(s, { fetch = globalThis.fetch, onProgress } = {}) {
  if (!s.url.trim()) throw new Error('サービスの URL が設定されていません');
  if (!s.nameField) throw new Error('名前の属性が設定されていません');
  const useAttrs = !!(s.lonField && s.latField);
  const fields = [...new Set([s.nameField, s.readingField, useAttrs && s.lonField, useAttrs && s.latField].filter(Boolean))];
  const pageSize = Math.max(1, s.pageSize | 0 || 1000);
  const max = Math.max(1, s.maxFeatures | 0 || 100000);
  const out = [];
  for (let offset = 0; out.length < max; ) {
    const params = new URLSearchParams({
      where: s.where || '1=1',
      outFields: fields.join(','),
      returnGeometry: String(!useAttrs),
      outSR: '4326',
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: 'json',
    });
    const res = await fetch(`${layerUrl(s.url)}/query?${params}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.error) throw new Error(`ArcGIS: ${json.error.message ?? json.error.code}`);
    const features = json.features ?? [];
    for (const f of features) {
      const a = f.attributes ?? {};
      const name = a[s.nameField] == null ? '' : String(a[s.nameField]).trim();
      const p = useAttrs ? [Number(a[s.lonField]), Number(a[s.latField])] : pointOf(f.geometry);
      if (!name || !valid(p)) continue;
      const reading = s.readingField && a[s.readingField] != null ? String(a[s.readingField]).trim() : '';
      out.push(reading ? [name, p[0], p[1], reading] : [name, p[0], p[1]]);
    }
    onProgress?.(out.length);
    // ページ送りに対応していないサービスは exceededTransferLimit を返さないので、そこで止める
    if (!json.exceededTransferLimit || !features.length) break;
    offset += features.length;
  }
  return out.slice(0, max);
}
