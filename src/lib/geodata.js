/**
 * 国境データ（scripts/build-data.mjs の出力）の読み込みと、点がどの国にあるかの判定。
 */
export const SCALE = 1e6;
/** 各レベルの間引き許容誤差（度）。build-data.mjs の LEVELS と合わせる。 */
export const LEVEL_TOLERANCE = [0.02, 0.004, 0.000001];

/** .bin を型付き配列のビューに分ける（コピーしない）。 */
export function parseLevel(buffer) {
  const [F, R, P] = new Uint32Array(buffer, 0, 4);
  let o = 16;
  const take = (Type, n) => {
    const a = new Type(buffer, o, n);
    o += 4 * n;
    return a;
  };
  return {
    featureCount: F,
    featStart: take(Uint32Array, F + 1),
    ringStart: take(Uint32Array, R + 1),
    ringBbox: take(Int32Array, R * 4),
    coords: take(Int32Array, P * 2),
  };
}

/** countries.json と指定レベルの .bin を読み込む。url(name) で各ファイルの URL を返す。 */
export async function loadGeoData(url, levels = [0, 1, 2]) {
  const [countries, ...bins] = await Promise.all([
    fetch(url('countries.json')).then((r) => r.json()),
    ...levels.map((l) => fetch(url(`l${l}.bin`)).then((r) => r.arrayBuffer())),
  ]);
  const data = { countries, levels: [] };
  levels.forEach((l, i) => (data.levels[l] = parseLevel(bins[i])));
  return data;
}

/** リング r が点 (x, y)（1e-6 度単位）を含むか。 */
function ringContains(level, r, x, y) {
  const b = level.ringBbox;
  if (x < b[4 * r] || x > b[4 * r + 2] || y < b[4 * r + 1] || y > b[4 * r + 3]) return false;
  const c = level.coords;
  const start = level.ringStart[r];
  const end = level.ringStart[r + 1];
  let inside = false;
  for (let i = start, j = end - 1; i < end; j = i++) {
    const xi = c[2 * i], yi = c[2 * i + 1];
    const xj = c[2 * j], yj = c[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 経度緯度の点を含む国を探す。見つからなければ null（海上）。
 * 返り値の ringBbox は点を含む外周リング（島・大陸部分）の範囲 [minLon, minLat, maxLon, maxLat]。
 */
export function findCountry(data, lon, lat, levelIndex = 2) {
  const level = data.levels[levelIndex] ?? data.levels.at(-1);
  const x = Math.round(lon * SCALE);
  const y = Math.round(lat * SCALE);
  let best = null;
  for (let f = 0; f < data.countries.length; f++) {
    const [minX, minY, maxX, maxY] = data.countries[f].bbox;
    if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
    let inside = false;
    let outer = -1;
    let outerSize = -1;
    for (let r = level.featStart[f]; r < level.featStart[f + 1]; r++) {
      if (!ringContains(level, r, x, y)) continue;
      inside = !inside;
      const b = level.ringBbox;
      const size = (b[4 * r + 2] - b[4 * r]) * (b[4 * r + 3] - b[4 * r + 1]);
      if (size > outerSize) {
        outerSize = size;
        outer = r;
      }
    }
    if (!inside) continue;
    // 重なりがあるときは小さい方（飛び地・係争地など、より具体的な方）を採る
    if (!best || outerSize < best.size) {
      const b = level.ringBbox;
      best = {
        index: f,
        size: outerSize,
        ringBbox: [b[4 * outer] / SCALE, b[4 * outer + 1] / SCALE, b[4 * outer + 2] / SCALE, b[4 * outer + 3] / SCALE],
      };
    }
  }
  if (!best) return null;
  return { index: best.index, country: data.countries[best.index], ringBbox: best.ringBbox };
}
