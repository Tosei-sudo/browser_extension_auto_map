/**
 * Web メルカトルで国境と位置を Canvas に描く。ホバー画像（OffscreenCanvas）と別タブの地図で共通に使う。
 *
 * view = { x, y, zoom, width, height }
 *   x, y はズーム 0 の世界座標（0〜256）で表した表示中心、zoom は 2 の累乗の倍率。
 */
import { SCALE, LEVEL_TOLERANCE } from './geodata.js';
import { vertices } from './wkt.js';

const TILE = 256;
const MAX_LAT = 85.0511287798;

export const lonToX = (lon) => ((lon + 180) / 360) * TILE;
export function latToY(lat) {
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE;
}
export const xToLon = (x) => (x / TILE) * 360 - 180;
export const yToLat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / TILE))) * 180) / Math.PI;

/** 画面上のピクセル → 経度緯度 */
export function screenToLonLat(view, px, py) {
  const s = 2 ** view.zoom;
  return [xToLon(view.x + (px - view.width / 2) / s), yToLat(view.y + (py - view.height / 2) / s)];
}

/** 範囲 [minLon, minLat, maxLon, maxLat] が収まる view。padding は幅・高さに対する余白の割合。 */
export function fitBounds([minLon, minLat, maxLon, maxLat], width, height, { padding = 0.1, maxZoom = 18 } = {}) {
  const x0 = lonToX(minLon), x1 = lonToX(maxLon);
  const y0 = latToY(maxLat), y1 = latToY(minLat);
  const w = Math.max(x1 - x0, 1e-9);
  const h = Math.max(y1 - y0, 1e-9);
  const zoom = Math.min(Math.log2((width * (1 - 2 * padding)) / w), Math.log2((height * (1 - 2 * padding)) / h), maxZoom);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, zoom, width, height };
}

/** 表示倍率に合う間引きレベル（読み込み済みのもののうち、1 ピクセルより粗くならない最も軽いもの）。 */
function pickLevel(levels, view) {
  const degPerPx = 360 / (TILE * 2 ** view.zoom);
  let chosen = -1;
  for (let i = 0; i < levels.length; i++) {
    if (!levels[i]) continue;
    if (chosen < 0) chosen = i;
    if (LEVEL_TOLERANCE[i] <= degPerPx * 0.7) return i;
    chosen = i;
  }
  return chosen;
}

/**
 * 地図を描く。
 * @param ctx      CanvasRenderingContext2D / OffscreenCanvasRenderingContext2D
 * @param data     loadGeoData の結果
 * @param view     表示範囲
 * @param style    config.colors / config.map をまとめたもの
 * @param overlay  { highlight: Set<国番号>, geometry: GeoJSON ジオメトリ（任意） }
 */
export function drawMap(ctx, data, view, style, overlay = {}) {
  const { width, height } = view;
  const s = 2 ** view.zoom;
  const highlight = overlay.highlight ?? new Set();
  ctx.save();
  ctx.fillStyle = style.colors.ocean;
  ctx.fillRect(0, 0, width, height);

  const li = pickLevel(data.levels, view);
  const level = data.levels[li];
  const left = view.x - width / 2 / s;
  const right = view.x + width / 2 / s;
  const top = view.y - height / 2 / s;
  const bottom = view.y + height / 2 / s;
  const minLat = yToLat(bottom), maxLat = yToLat(top);
  // 経度方向は世界を繰り返して描く（日付変更線をまたぐ表示のため）
  const offsets = [];
  for (let k = Math.floor(left / TILE); k <= Math.floor(right / TILE); k++) offsets.push(k);

  const c = level.coords;
  const rb = level.ringBbox;
  const lat0 = minLat * SCALE, lat1 = maxLat * SCALE;
  const ox = width / 2 - view.x * s;
  const oy = height / 2 - view.y * s;
  // 国 f の表示範囲内のリングをパスにする。k は世界の繰り返し番号
  const pathFeature = (f) => {
    ctx.beginPath();
    let any = false;
    for (const k of offsets) {
      const lonShift = k * 360;
      const lon0 = (xToLon(left - k * TILE)) * SCALE;
      const lon1 = (xToLon(right - k * TILE)) * SCALE;
      for (let r = level.featStart[f]; r < level.featStart[f + 1]; r++) {
        if (rb[4 * r + 2] < lon0 || rb[4 * r] > lon1 || rb[4 * r + 3] < lat0 || rb[4 * r + 1] > lat1) continue;
        const start = level.ringStart[r];
        const end = level.ringStart[r + 1];
        let lastX = NaN, lastY = NaN;
        for (let i = start; i < end; i++) {
          const px = lonToX(c[2 * i] / SCALE + lonShift) * s + ox;
          const py = latToY(c[2 * i + 1] / SCALE) * s + oy;
          if (i === start) ctx.moveTo(px, py);
          // 同じピクセルに重なる点は省く
          else if (Math.abs(px - lastX) < 0.3 && Math.abs(py - lastY) < 0.3 && i !== end - 1) continue;
          else ctx.lineTo(px, py);
          lastX = px;
          lastY = py;
        }
        ctx.closePath();
        any = true;
      }
    }
    return any;
  };

  ctx.lineJoin = 'round';
  ctx.strokeStyle = style.colors.border;
  ctx.lineWidth = style.map.borderWidth;
  for (const pass of [0, 1]) {
    // ハイライト国は境界線が隣国に隠れないよう後から描く
    for (let f = 0; f < data.countries.length; f++) {
      if (highlight.has(f) !== (pass === 1)) continue;
      const [bx0, by0, bx1, by1] = data.countries[f].bbox;
      if (by1 < minLat || by0 > maxLat) continue;
      if (!offsets.some((k) => bx1 >= xToLon(left - k * TILE) && bx0 <= xToLon(right - k * TILE))) continue;
      if (!pathFeature(f)) continue;
      ctx.fillStyle = pass ? style.colors.highlightCountry : style.colors.otherCountry;
      ctx.fill('evenodd');
      if (style.map.borderWidth > 0) ctx.stroke();
    }
  }

  if (overlay.geometry) drawGeometry(ctx, view, style, overlay.geometry, offsets);
  ctx.restore();
}

function drawGeometry(ctx, view, style, geometry, offsets) {
  const s = 2 ** view.zoom;
  const ox = view.width / 2 - view.x * s;
  const oy = view.height / 2 - view.y * s;
  const toPx = ([lon, lat], k) => [(lonToX(lon) + k * TILE) * s + ox, latToY(lat) * s + oy];
  const colors = style.colors;

  const marker = (p) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], style.map.markerRadius, 0, Math.PI * 2);
    ctx.fillStyle = colors.marker;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = colors.markerStroke;
    ctx.stroke();
  };
  const line = (coords, k, close) => {
    coords.forEach((c, i) => {
      const [x, y] = toPx(c, k);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    if (close) ctx.closePath();
  };

  const draw = (g, k) => {
    switch (g.type) {
      case 'Point':
        marker(toPx(g.coordinates, k));
        break;
      case 'MultiPoint':
        g.coordinates.forEach((c) => marker(toPx(c, k)));
        break;
      case 'LineString':
      case 'MultiLineString':
        ctx.beginPath();
        (g.type === 'LineString' ? [g.coordinates] : g.coordinates).forEach((l) => line(l, k, false));
        ctx.lineWidth = style.map.geometryWidth;
        ctx.strokeStyle = colors.geometryStroke;
        ctx.stroke();
        break;
      case 'Polygon':
      case 'MultiPolygon':
        ctx.beginPath();
        (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).forEach((poly) => poly.forEach((r) => line(r, k, true)));
        ctx.fillStyle = colors.geometryFill;
        ctx.fill('evenodd');
        ctx.lineWidth = style.map.geometryWidth;
        ctx.strokeStyle = colors.geometryStroke;
        ctx.stroke();
        break;
      case 'GeometryCollection':
        g.geometries.forEach((x) => draw(x, k));
        break;
    }
  };
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const k of offsets) draw(geometry, k);
  // 線や面が印より小さくて見えにくいときは、代わりに印を付ける
  if (geometry.type !== 'Point' && geometry.type !== 'MultiPoint') {
    const pts = [...vertices(geometry)];
    const xs = pts.map((p) => lonToX(p[0]) * s), ys = pts.map((p) => latToY(p[1]) * s);
    const small = 2 * style.map.markerRadius;
    if (Math.max(...xs) - Math.min(...xs) < small && Math.max(...ys) - Math.min(...ys) < small) {
      for (const k of offsets) marker(toPx(geometry.center ?? pts[0], k));
    }
  }
}
