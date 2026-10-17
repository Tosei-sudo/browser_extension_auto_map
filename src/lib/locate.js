/**
 * 検出した位置（GeoJSON ジオメトリ）について、ハイライトする国と地図の表示範囲を決める。
 */
import { SCALE, findCountry } from './geodata.js';
import { geometryBbox } from './wkt.js';

// 線・面の国判定で調べる点の数の上限と、線上に点を置く間隔（度）
const MAX_SAMPLES = 1000;
const SAMPLE_STEP_DEG = 0.05;

/** 点・線・面の境界上に並べた判定用の点。線は途中で通る国も拾えるよう細かく区切る。 */
function samplePoints(geometry) {
  const lines = [];
  const points = [];
  const collect = (g) => {
    switch (g.type) {
      case 'Point': points.push(g.coordinates); break;
      case 'MultiPoint': points.push(...g.coordinates); break;
      case 'LineString': lines.push(g.coordinates); break;
      case 'MultiLineString': case 'Polygon': lines.push(...g.coordinates); break;
      case 'MultiPolygon': g.coordinates.forEach((p) => lines.push(...p)); break;
      case 'GeometryCollection': g.geometries.forEach(collect); break;
    }
  };
  collect(geometry);
  let length = 0;
  for (const l of lines) for (let i = 1; i < l.length; i++) length += Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
  const step = Math.max(SAMPLE_STEP_DEG, length / MAX_SAMPLES);
  for (const l of lines) {
    points.push(l[0]);
    for (let i = 1; i < l.length; i++) {
      const [x0, y0] = l[i - 1];
      const [x1, y1] = l[i];
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step);
      for (let k = 1; k <= n; k++) points.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
    }
  }
  const stride = Math.max(1, Math.ceil(points.length / MAX_SAMPLES));
  return points.filter((_, i) => i % stride === 0);
}

/** ジオメトリに含まれる面（リングの配列）をすべて返す。 */
function polygonsOf(g) {
  if (g.type === 'Polygon') return [g.coordinates];
  if (g.type === 'MultiPolygon') return g.coordinates;
  if (g.type === 'GeometryCollection') return g.geometries.flatMap(polygonsOf);
  return [];
}

function polygonContains(rings, x, y) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/** 面の内側に一部でも入っている国（国境の頂点が面の中にある国）。境界が面の外を通るだけの国は samplePoints 側で拾う。 */
function countriesInside(data, rings) {
  const [minLon, minLat, maxLon, maxLat] = geometryBbox({ type: 'Polygon', coordinates: rings });
  const level = data.levels.find(Boolean);
  const out = [];
  data.countries.forEach((country, f) => {
    const [x0, y0, x1, y1] = country.bbox;
    if (x1 < minLon || x0 > maxLon || y1 < minLat || y0 > maxLat) return;
    const c = level.coords;
    for (let p = level.ringStart[level.featStart[f]]; p < level.ringStart[level.featStart[f + 1]]; p++) {
      if (polygonContains(rings, c[2 * p] / SCALE, c[2 * p + 1] / SCALE)) {
        out.push(f);
        return;
      }
    }
  });
  return out;
}

export function expandToMinSpan([minLon, minLat, maxLon, maxLat], minSpan) {
  const cx = (minLon + maxLon) / 2, cy = (minLat + maxLat) / 2;
  const hw = Math.max(maxLon - minLon, minSpan) / 2;
  const hh = Math.max(maxLat - minLat, minSpan) / 2;
  return [cx - hw, Math.max(-85, cy - hh), cx + hw, Math.min(85, cy + hh)];
}

const union = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
const span = (b) => Math.max(b[2] - b[0], b[3] - b[1]);

/** 点を含む国と、点を映すときの範囲（国全体、海上なら点の周り）。 */
function pointView(data, [lon, lat], image) {
  const hit = findCountry(data, lon, lat);
  if (!hit) {
    const h = image.oceanSpanDeg / 2;
    return { bbox: [lon - h, lat - h, lon + h, lat + h] };
  }
  // 国全体を映す。ただし海外領土などで国の範囲が極端に広いときは、点のある島・大陸部分を映す
  const country = hit.country.bbox;
  const bbox = span(country) > Math.max(4 * span(hit.ringBbox), image.maxCountrySpanDeg) ? hit.ringBbox : country;
  return { index: hit.index, bbox };
}

/**
 * @param data      loadGeoData の結果（l2 を含むこと）
 * @param geometry  GeoJSON ジオメトリ。center があれば（GeoHash のセル）点と同じく国全体も表示範囲に含める
 * @param image     config.image
 * @returns {{ highlight: Set<number>, countries: object[], bbox: number[] }}
 */
export function locate(data, geometry, image) {
  const highlight = new Set();
  let bbox;
  if (geometry.type === 'Point') {
    const hit = pointView(data, geometry.coordinates, image);
    if (hit.index !== undefined) highlight.add(hit.index);
    bbox = hit.bbox;
  } else {
    // 点の数が多いので、読み込み済みなら中間精度（l1）で判定する
    const levelIndex = data.levels[1] ? 1 : 2;
    for (const [lon, lat] of samplePoints(geometry)) {
      const hit = findCountry(data, lon, lat, levelIndex);
      if (hit) highlight.add(hit.index);
    }
    for (const polygon of polygonsOf(geometry)) {
      for (const f of countriesInside(data, polygon)) highlight.add(f);
    }
    bbox = geometryBbox(geometry);
    if (geometry.center) {
      // 小さいセルは中間精度だと海岸近くで国を外すので、中心は最高精度でも判定する
      const hit = pointView(data, geometry.center, image);
      if (hit.index !== undefined) highlight.add(hit.index);
      bbox = union(bbox, hit.bbox);
    }
  }
  return {
    highlight,
    countries: [...highlight].map((i) => data.countries[i]),
    bbox: expandToMinSpan(bbox, image.minSpanDeg),
  };
}
