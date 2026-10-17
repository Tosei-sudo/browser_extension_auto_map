/**
 * WKT（Well-Known Text）を GeoJSON 形式のジオメトリに読む。座標は「経度 緯度」の順（WGS 84）。
 * Z / M / ZM の 3・4 次元目は読み捨てる。
 */
const TYPES = {
  POINT: 'Point',
  LINESTRING: 'LineString',
  POLYGON: 'Polygon',
  MULTIPOINT: 'MultiPoint',
  MULTILINESTRING: 'MultiLineString',
  MULTIPOLYGON: 'MultiPolygon',
  GEOMETRYCOLLECTION: 'GeometryCollection',
};

/** 文中の WKT の開始位置を探す正規表現（キーワードと開き括弧まで）。 */
export const WKT_START = /(?<![\w])(?:SRID=\d+;\s*)?(GEOMETRYCOLLECTION|MULTIPOLYGON|MULTILINESTRING|MULTIPOINT|POLYGON|LINESTRING|POINT)\s*(?:ZM|Z|M)?\s*\(/gi;

/** text の index（開き括弧の位置）から対応する閉じ括弧の次の位置を返す。なければ -1。 */
export function matchParen(text, index) {
  let depth = 0;
  for (let i = index; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i + 1;
    } else if (!/[\s\d.,+\-eE]/.test(c) && !/[A-Za-z]/.test(c)) return -1;
  }
  return -1;
}

/** WKT 文字列 → GeoJSON ジオメトリ。読めない・範囲外なら null。 */
export function parseWkt(text) {
  const tokens = text
    .replace(/^\s*SRID=\d+;\s*/i, '')
    .match(/[A-Za-z]+|\(|\)|,|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g);
  if (!tokens) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const expect = (t) => {
    if (next() !== t) throw new Error(`expected ${t}`);
  };

  function point() {
    const nums = [];
    while (peek() !== undefined && /^[-+.\d]/.test(peek())) nums.push(Number(next()));
    if (nums.length < 2 || nums.length > 4) throw new Error('bad point');
    const [lon, lat] = nums;
    if (!(Math.abs(lon) <= 180 && Math.abs(lat) <= 90)) throw new Error('out of range');
    return [lon, lat];
  }
  // ( item, item, ... )。MULTIPOINT は (1 2, 3 4) と ((1 2), (3 4)) の両方を許す
  function list(item) {
    expect('(');
    const out = [item()];
    while (peek() === ',') {
      next();
      out.push(item());
    }
    expect(')');
    return out;
  }
  const ring = () => list(point);
  const polygon = () => list(ring);
  const multiPointItem = () => {
    if (peek() !== '(') return point();
    next();
    const p = point();
    expect(')');
    return p;
  };

  function geometry() {
    const keyword = String(next()).toUpperCase();
    const type = TYPES[keyword];
    if (!type) throw new Error('unknown type');
    if (/^(ZM|Z|M)$/i.test(peek())) next();
    if (/^EMPTY$/i.test(peek())) throw new Error('empty');
    switch (type) {
      case 'Point': {
        expect('(');
        const p = point();
        expect(')');
        return { type, coordinates: p };
      }
      case 'LineString':
        return { type, coordinates: ring() };
      case 'Polygon':
        return { type, coordinates: polygon() };
      case 'MultiPoint':
        return { type, coordinates: list(multiPointItem) };
      case 'MultiLineString':
        return { type, coordinates: list(ring) };
      case 'MultiPolygon':
        return { type, coordinates: list(polygon) };
      default:
        return { type, geometries: list(geometry) };
    }
  }

  try {
    const g = geometry();
    return i === tokens.length ? g : null;
  } catch {
    return null;
  }
}

/** ジオメトリのすべての頂点 [lon, lat] を順に返す。 */
export function* vertices(geometry) {
  if (geometry.type === 'GeometryCollection') {
    for (const g of geometry.geometries) yield* vertices(g);
    return;
  }
  const walk = function* (c) {
    if (typeof c[0] === 'number') yield c;
    else for (const x of c) yield* walk(x);
  };
  yield* walk(geometry.coordinates);
}

/** ジオメトリの範囲 [minLon, minLat, maxLon, maxLat]。 */
export function geometryBbox(geometry) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of vertices(geometry)) {
    if (x < b[0]) b[0] = x;
    if (y < b[1]) b[1] = y;
    if (x > b[2]) b[2] = x;
    if (y > b[3]) b[3] = y;
  }
  return b;
}

const WKT_TYPES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
// 浮動小数点の誤差（139.76710000000001 など）を落とす。1e-8 度は約 1 mm
const num = (v) => String(Number(v.toFixed(8)));
const pt = (c) => `${num(c[0])} ${num(c[1])}`;
const list = (items, f) => `(${items.map(f).join(', ')})`;

/** GeoJSON ジオメトリ → WKT（経度 緯度の順）。 */
export function toWkt(g) {
  const type = WKT_TYPES[g.type];
  switch (g.type) {
    case 'Point':
      return `${type} (${pt(g.coordinates)})`;
    case 'LineString':
    case 'MultiPoint':
      return `${type} ${list(g.coordinates, pt)}`;
    case 'Polygon':
    case 'MultiLineString':
      return `${type} ${list(g.coordinates, (r) => list(r, pt))}`;
    case 'MultiPolygon':
      return `${type} ${list(g.coordinates, (p) => list(p, (r) => list(r, pt)))}`;
    case 'GeometryCollection':
      return `${type} ${list(g.geometries, toWkt)}`;
    default:
      throw new Error(`unknown geometry type: ${g.type}`);
  }
}

/** 画像ビューアアプリ（web+imageviewer プロトコル）でジオメトリを開く URL。 */
export const imageViewerUrl = (geometry) => `web+imageviewer:geom=${encodeURIComponent(toWkt(geometry))}`;
