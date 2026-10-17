/**
 * country_bound.geojson を拡張機能で読み込める形に変換する。
 *
 * 出力 (static/data/):
 *   countries.json  … 国ごとの属性（国名・ISO コード）と範囲
 *   l0.bin / l1.bin / l2.bin … 境界座標。l2 が高精度（判定・拡大表示用）、l0 / l1 は縮小表示用に間引いたもの
 *
 * .bin の構造（すべてリトルエンディアン、4 バイト単位）:
 *   Uint32[4]          ヘッダ: 国数 F, リング数 R, 頂点数 P, 予約
 *   Uint32[F + 1]      国ごとのリング開始番号
 *   Uint32[R + 1]      リングごとの頂点開始番号
 *   Int32[R * 4]       リングの範囲 [minX, minY, maxX, maxY]（1e-6 度単位）
 *   Int32[P * 2]       頂点 [経度, 緯度]（1e-6 度単位）
 *
 * 外周と穴は区別せず、塗りと内外判定は even-odd 規則で行う。
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] ?? 'country_bound.geojson';
const OUT = 'static/data';
const SCALE = 1e6;
// 各レベルの Douglas-Peucker 許容誤差（度）。l2 は約 0.1 m で、実質的に元の形を保つ。
const LEVELS = [
  { name: 'l0', tolerance: 0.02 },
  { name: 'l1', tolerance: 0.004 },
  { name: 'l2', tolerance: 0.000001 },
];

const geojson = JSON.parse(fs.readFileSync(SRC, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

// 小数 6 桁に丸めて連続する重複点を除いたリング（閉じた形、先頭 = 末尾）
const features = geojson.features.map((f) => {
  const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  const rings = [];
  for (const polygon of polygons) {
    for (const ring of polygon) {
      const pts = [];
      for (const [x, y] of ring) {
        const qx = Math.round(x * SCALE);
        const qy = Math.round(y * SCALE);
        const n = pts.length;
        if (n && pts[n - 2] === qx && pts[n - 1] === qy) continue;
        pts.push(qx, qy);
      }
      if (pts.length >= 8) rings.push(pts);
    }
  }
  const p = f.properties;
  return { props: { name: p.NAM_0, iso3: p.ISO_A3, iso2: p.ISO_A2 }, rings };
});

/** 閉じたリングの Douglas-Peucker。先頭と最遠点で 2 つに分けて処理する。 */
function simplifyRing(pts, tol) {
  const n = pts.length / 2;
  if (tol <= 0 || n <= 4) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  // 閉じたリングは始点と終点が同じなので、始点から最も遠い点で分割する
  let far = 0;
  let farD = -1;
  for (let i = 1; i < n - 1; i++) {
    const d = (pts[2 * i] - pts[0]) ** 2 + (pts[2 * i + 1] - pts[1]) ** 2;
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  keep[far] = 1;
  const tol2 = tol * tol;
  const stack = [0, far, far, n - 1];
  while (stack.length) {
    const b = stack.pop();
    const a = stack.pop();
    const ax = pts[2 * a], ay = pts[2 * a + 1];
    const dx = pts[2 * b] - ax, dy = pts[2 * b + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const px = pts[2 * i] - ax, py = pts[2 * i + 1] - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      }
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push(a, idx, idx, b);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[2 * i], pts[2 * i + 1]);
  return out;
}

function bboxOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    if (pts[i] < minX) minX = pts[i];
    if (pts[i] > maxX) maxX = pts[i];
    if (pts[i + 1] < minY) minY = pts[i + 1];
    if (pts[i + 1] > maxY) maxY = pts[i + 1];
  }
  return [minX, minY, maxX, maxY];
}

for (const level of LEVELS) {
  const tol = level.tolerance * SCALE;
  const featRings = features.map((f) => {
    const rings = f.rings.map((r) => simplifyRing(r, tol)).filter((r) => r.length >= 8);
    // 間引きで全リングが消える小さな島は、最大のリングだけ元の形で残す
    if (!rings.length && f.rings.length) rings.push(f.rings.reduce((a, b) => (a.length >= b.length ? a : b)));
    return rings;
  });
  const F = features.length;
  const R = featRings.reduce((s, r) => s + r.length, 0);
  const P = featRings.reduce((s, rs) => s + rs.reduce((t, r) => t + r.length / 2, 0), 0);
  const buf = new ArrayBuffer(4 * (4 + F + 1 + R + 1 + R * 4 + P * 2));
  let o = 0;
  const u32 = (n) => new Uint32Array(buf, (o += 4 * n) - 4 * n, n);
  const i32 = (n) => new Int32Array(buf, (o += 4 * n) - 4 * n, n);
  u32(4).set([F, R, P, 0]);
  const featStart = u32(F + 1);
  const ringStart = u32(R + 1);
  const ringBbox = i32(R * 4);
  const coords = i32(P * 2);
  let r = 0;
  let p = 0;
  featRings.forEach((rings, fi) => {
    featStart[fi] = r;
    for (const ring of rings) {
      ringStart[r] = p;
      ringBbox.set(bboxOf(ring), r * 4);
      coords.set(ring, p * 2);
      p += ring.length / 2;
      r++;
    }
  });
  featStart[F] = r;
  ringStart[R] = p;
  fs.writeFileSync(path.join(OUT, `${level.name}.bin`), Buffer.from(buf));
  console.log(`${level.name}: tolerance ${level.tolerance}°, ${R} rings, ${P} points, ${(buf.byteLength / 1e6).toFixed(1)} MB`);
}

const countries = features.map((f) => {
  const all = f.rings.flat();
  const [minX, minY, maxX, maxY] = bboxOf(all);
  return { ...f.props, bbox: [minX / SCALE, minY / SCALE, maxX / SCALE, maxY / SCALE] };
});
fs.writeFileSync(path.join(OUT, 'countries.json'), JSON.stringify(countries));
console.log(`countries.json: ${countries.length} countries`);
