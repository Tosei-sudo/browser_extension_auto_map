/** GeoHash の復号（coordinate-notation は GeoHash に対応していないため自前で持つ）。 */
const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** GeoHash → { lonLat: セル中心 [lon, lat], bbox: [minLon, minLat, maxLon, maxLat] }。不正なら null。 */
export function decodeGeohash(hash) {
  const h = hash.toLowerCase();
  if (!h || h.length > 12) return null;
  let minLon = -180, maxLon = 180, minLat = -90, maxLat = 90;
  let even = true;
  for (const ch of h) {
    const v = BASE32.indexOf(ch);
    if (v < 0) return null;
    for (let bit = 4; bit >= 0; bit--) {
      const on = (v >> bit) & 1;
      if (even) {
        const mid = (minLon + maxLon) / 2;
        if (on) minLon = mid;
        else maxLon = mid;
      } else {
        const mid = (minLat + maxLat) / 2;
        if (on) minLat = mid;
        else maxLat = mid;
      }
      even = !even;
    }
  }
  return { lonLat: [(minLon + maxLon) / 2, (minLat + maxLat) / 2], bbox: [minLon, minLat, maxLon, maxLat] };
}

/**
 * GeoHash → セルを表す GeoJSON の Polygon。中心 [lon, lat] を center に持たせる
 * （GeoJSON の外の独自プロパティ。表示や表示範囲の決定に使う）。不正なら null。
 */
export function geohashGeometry(hash) {
  const g = decodeGeohash(hash);
  if (!g) return null;
  const [w, s, e, n] = g.bbox;
  return { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]], center: g.lonLat };
}

const length = (m) => (m >= 1000 ? `${+(m / 1000).toPrecision(3)} km` : m >= 1 ? `${+m.toPrecision(3)} m` : `${+(m * 100).toPrecision(3)} cm`);

/** セル（GeoHash の Polygon）の大きさ。「約 4.89 km × 4.89 km」（東西 × 南北）。 */
export function cellSizeText(geometry) {
  const ring = geometry.coordinates[0];
  const [w, s] = ring[0];
  const [e, n] = ring[2];
  const lat = ((s + n) / 2) * (Math.PI / 180);
  return `約 ${length((e - w) * 111320 * Math.cos(lat))} × ${length((n - s) * 110574)}`;
}
