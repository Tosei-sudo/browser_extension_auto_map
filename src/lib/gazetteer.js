/**
 * キャッシュした地名（arcgis.js の fetchPlaces の結果）で文中の地名を探す。
 * 名前と読みの完全一致で、同じ位置からは最も長い名前を採る。
 */

import { normalizeIfNeeded } from './normalize.js';

const ALNUM = /[A-Za-z0-9]/;
// 全角・半角のゆれ（ＡＢＣ / ABC、１丁目 / 1丁目、ｶﾅ / カナ）は名前と文中の両方を NFKC にそろえて比べる
const nfkc = (s) => normalizeIfNeeded(s, { extra: false })?.text ?? s;

/**
 * @param entries [名前, 経度, 緯度, 読み?][]
 * @returns 照合用の索引。地名がなければ null
 */
export function buildMatcher(entries, { minLength = 2 } = {}) {
  const map = new Map();
  const add = (raw, name, lon, lat) => {
    const key = raw && nfkc(raw);
    if (key && key.length >= minLength && !map.has(key)) map.set(key, { name, coordinates: [lon, lat] });
  };
  // 名前を先に登録し、読みが別の地名の名前と同じときは名前を優先する
  for (const [name, lon, lat] of entries) add(name, name, lon, lat);
  for (const [name, lon, lat, reading] of entries) add(reading, name, lon, lat);
  if (!map.size) return null;
  const lengths = [...new Set([...map.keys()].map((k) => k.length))].sort((a, b) => b - a);
  const firsts = new Set([...map.keys()].map((k) => k[0]));
  return { map, lengths, firsts };
}

/**
 * text 中の地名を返す。ranges（ほかの検出結果）と重なるものは除く。
 * 英数字で始まる・終わる名前は、前後が英数字のとき（単語の一部のとき）は除く。
 * @returns {{start: number, end: number, text: string, kind: 'place', name: string, geometry: object}[]}
 */
export function findPlaceNames(source, matcher, ranges = []) {
  if (!matcher) return [];
  const norm = normalizeIfNeeded(source, { extra: false });
  const text = norm ? norm.text : source;
  const pos = (i) => (norm ? norm.map[i] : i);
  const { map, lengths, firsts } = matcher;
  const out = [];
  const taken = (s, e) => ranges.some((f) => pos(s) < f.end && pos(e) > f.start);
  for (let i = 0; i < text.length; ) {
    let hit = null;
    if (firsts.has(text[i])) {
      for (const len of lengths) {
        const end = i + len;
        if (end > text.length) continue;
        const key = text.slice(i, end);
        const place = map.get(key);
        if (!place) continue;
        if (ALNUM.test(key[0]) && ALNUM.test(text[i - 1] ?? '')) continue;
        if (ALNUM.test(key.at(-1)) && ALNUM.test(text[end] ?? '')) continue;
        if (taken(i, end)) continue;
        hit = { start: i, end, name: place.name, geometry: { type: 'Point', coordinates: place.coordinates } };
        break;
      }
    }
    if (hit) {
      const [start, end] = [pos(hit.start), pos(hit.end)];
      out.push({ start, end, text: source.slice(start, end), kind: 'place', name: hit.name, geometry: hit.geometry });
      i = hit.end;
    } else i++;
  }
  return out;
}
