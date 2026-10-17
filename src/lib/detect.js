/**
 * テキストの中から位置を表す記述を探す。
 *
 * coordinate-notation の parseCoordinate は「文字列全体が 1 つの座標か」を判定する関数なので、
 * ここでは正規表現で候補の範囲を切り出し、最終的な判定と変換をライブラリに任せる。
 * GeoHash と POINT 以外の WKT はライブラリの対象外なので、それぞれ geohash.js / wkt.js で読む。
 */
import { parseCoordinate } from '../../coordinate-notation/dist/cdn/coordinate-notation.min.js';
import { geohashGeometry } from './geohash.js';
import { WKT_START, matchParen, parseWkt } from './wkt.js';

const d = '[0-9０-９]';
const num = `${d}+(?:[.．]${d}+)?`;
const sign = '[-+−－]?';
const DEG = '(?:°|º|˚|度)';
const MIN = "(?:'|′|’|‘|分)";
const SEC = '(?:"|″|”|“|\'\'|′′|秒)';
const SEP = '\\s*[,，、/;；]?\\s*';
// ラベル付きは "lat": 35.6, "lng": 139.7 のように次のラベルの前に引用符が来ることがある
const LSEP = `${SEP}["']?`;

// 度記号つき（35°40'52.3" / 35.68° / 35度40分）と d-m-s 表記（35d40m52s）
const dmsAngle = `${num}\\s*${DEG}(?:\\s*${num}\\s*${MIN}(?:\\s*${num}\\s*${SEC})?)?`;
const dAngle = `${d}{1,3}(?:[.．]${d}+)?[dD]\\s?(?:${num}[mM]\\s?(?:${num}[sS])?)?`;
// 区切りなしの度分秒（354052N）と 10 進度
const angle = `(?:${dmsAngle}|${dAngle}|${d}{4,7}(?:[.．]${d}+)?|${d}{1,3}(?:[.．]${d}+)?)`;
const labeled = `${sign}(?:${dmsAngle}|${num})`;

const LAT = `(?:[NS]\\s?${angle}|${angle}\\s?[NS])`;
const LON = `(?:[EW]\\s?${angle}|${angle}\\s?[EW])`;
const JP_LAT = `(?:北緯|南緯)\\s*(?:${dmsAngle}|${num})`;
const JP_LON = `(?:東経|西経)\\s*(?:${dmsAngle}|${num})`;
const JP_LAT_L = `緯度\\s*[:：=]?\\s*${labeled}`;
const JP_LON_L = `経度\\s*[:：=]?\\s*${labeled}`;
// "lat": 35.6 のような JSON 風の書き方も拾う
const EN_LAT = `\\b(?:latitude|lat)["']?\\s*[:=]?\\s*${labeled}`;
const EN_LON = `\\b(?:longitude|long|lng|lon)["']?\\s*[:=]?\\s*${labeled}`;

const START = '(?<![\\w.．°])';
const END = '(?![\\w°])';

/** 位置記述の種類と、その検出用正規表現（優先度の高い順）。 */
function buildPatterns(minDecimals) {
  const dec = `${sign}${d}{1,3}[.．]${d}{${minDecimals},}`;
  return [
    { kind: 'mgrs', re: `(?<![\\w])\\d{1,2}\\s?[C-HJ-NP-X]\\s?[A-HJ-NP-Z]{2}\\s?(?:\\d{2,5}\\s\\d{2,5}|\\d{4,10})(?![\\w])` },
    {
      kind: 'utm',
      re: `(?<![\\w])(\\d{1,2})\\s?([C-HJ-NP-X])([\\s,]+\\d{6}(?:\\.\\d+)?(?:\\s?m?E|\\s?m)?[\\s,]+\\d{6,7}(?:\\.\\d+)?(?:\\s?m?N|\\s?m)?)(?![\\w])`,
    },
    { kind: 'latlon', re: `(?:${JP_LAT}${SEP}${JP_LON}|${JP_LON}${SEP}${JP_LAT})` },
    { kind: 'latlon', re: `(?:${JP_LAT_L}${LSEP}${JP_LON_L}|${JP_LON_L}${LSEP}${JP_LAT_L})` },
    { kind: 'latlon', re: `(?:${EN_LAT}${LSEP}${EN_LON}|${EN_LON}${LSEP}${EN_LAT})`, flags: 'i' },
    { kind: 'latlon', re: `${START}(?:${LAT}${SEP}${LON}|${LON}${SEP}${LAT})${END}` },
    { kind: 'latlon', re: `${START}${sign}${dmsAngle}${SEP}${sign}${dmsAngle}` },
    { kind: 'geohash', re: `\\bgeohash["']?\\s*[:=：]?\\s*["']?([0-9b-hjkmnp-z]{1,12})(?![\\w])`, flags: 'i' },
    {
      kind: 'decimal',
      re: `(?<![\\w.．,，\\-−－])${dec}(?:\\s*[,，、]\\s*|\\s+)${dec}(?![\\w.．])`,
    },
    { kind: 'geohash-bare', re: `(?<![\\w\\-/.#@:=&?%])[0-9b-hjkmnp-z]{6,12}(?![\\w\\-/.@])` },
  ].map((p) => ({ ...p, re: new RegExp(p.re, `g${p.flags ?? ''}`) }));
}

/** ライブラリが読みやすいよう、ラベルまわりの引用符や / を整える。 */
function cleanForLibrary(text) {
  return text.replace(/["']\s*(?=[:=：])/g, '').replace(/[:=：]\s*["']/g, ':').replace(/\//g, ',');
}

/** 文字・数字が混ざっていない GeoHash もどきは除く（英単語・数値の誤検出よけ）。 */
function plausibleBareGeohash(s) {
  const letters = s.replace(/\d/g, '').length;
  const digits = s.length - letters;
  return digits >= 1 && letters >= 2;
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWX';

/**
 * UTM（ゾーン + 文字 + 東距 + 北距）を読む。文字は半球（N/S）か緯度帯（C〜X、8 度ごと）のどちらか。
 * coordinate-notation は N/S の半球表記だけを読むので、緯度帯は半球に直して渡し、結果が帯に収まるか確かめる。
 * S は「南半球」と「緯度帯 S（北緯 32〜40 度）」の両方がありうるので、緯度帯に収まるならそちらを採る。
 */
function parseUtm(zone, letter, rest) {
  const parse = (h) => parseCoordinate(`${zone}${h}${rest}`);
  if (letter === 'N') return parse('N'); // 半球 N でも緯度帯 N（北緯 0〜8 度）でも同じ計算になる
  const i = BANDS.indexOf(letter);
  const p = parse(i < BANDS.indexOf('N') ? 'S' : 'N');
  const min = -80 + 8 * i;
  const max = letter === 'X' ? 84 : min + 8;
  // 帯の境界付近の丸めを許すため 0.5 度の余裕を持たせる
  if (p && p[1] >= min - 0.5 && p[1] <= max + 0.5) return p;
  return letter === 'S' ? parse('S') : null;
}

let cache = { key: '', patterns: [] };

/**
 * text 中の位置記述をすべて返す。
 * @returns {{start: number, end: number, text: string, kind: string, geometry: object}[]}
 *   geometry は GeoJSON 形式（Point なら coordinates = [lon, lat]）
 */
export function findLocations(text, options = {}) {
  const opt = {
    latlon: true, mgrs: true, utm: true, geohash: true, wkt: true, plainDecimal: true, minDecimals: 3,
    ...options,
  };
  const key = String(opt.minDecimals);
  if (cache.key !== key) cache = { key, patterns: buildPatterns(Math.max(0, opt.minDecimals | 0)) };

  const found = [];
  const taken = (s, e) => found.some((f) => s < f.end && e > f.start);
  const add = (start, end, kind, geometry) => {
    if (!geometry || taken(start, end)) return;
    found.push({ start, end, text: text.slice(start, end), kind, geometry });
  };

  if (opt.wkt) {
    WKT_START.lastIndex = 0;
    for (const m of text.matchAll(WKT_START)) {
      const end = matchParen(text, m.index + m[0].length - 1);
      if (end < 0) continue;
      const src = text.slice(m.index, end);
      let geometry = parseWkt(src);
      // POINT は coordinate-notation で読む（変換処理の統一のため）
      if (geometry?.type === 'Point') {
        const p = parseCoordinate(src.replace(/^\s*SRID=\d+;\s*/i, '').replace(/\s*(ZM|Z|M)\s*\(/i, '('));
        geometry = p ? { type: 'Point', coordinates: p } : geometry;
      }
      add(m.index, end, 'wkt', geometry);
    }
  }

  for (const p of cache.patterns) {
    const enabled = {
      mgrs: opt.mgrs, utm: opt.utm, latlon: opt.latlon, decimal: opt.plainDecimal && opt.latlon,
      geohash: opt.geohash, 'geohash-bare': opt.geohash,
    }[p.kind];
    if (!enabled) continue;
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken(start, end)) continue;
      if (p.kind === 'geohash' || p.kind === 'geohash-bare') {
        const hash = p.kind === 'geohash' ? m[1] : m[0];
        if (p.kind === 'geohash-bare' && !plausibleBareGeohash(hash)) continue;
        add(start, end, 'geohash', geohashGeometry(hash));
        continue;
      }
      const lonLat = p.kind === 'utm' ? parseUtm(m[1], m[2], m[3]) : parseCoordinate(cleanForLibrary(m[0]));
      if (lonLat) add(start, end, p.kind === 'decimal' ? 'latlon' : p.kind, { type: 'Point', coordinates: lonLat });
    }
  }
  return found.sort((a, b) => a.start - b.start);
}

// ---- 緯度と経度が別々の要素（表のセル、別の行など）に書かれている場合 ----

const LAT_LABEL = '(?:北緯|南緯|緯度|latitude|lat)';
const LON_LABEL = '(?:東経|西経|経度|longitude|long|lng|lon)';
// 度と分の両方が付いた角度（35度58分40.4秒、35°58'40"）。度だけ（35度）は温度などと紛れるので単独では拾わない
const dmAngle = `${sign}${num}\\s*${DEG}\\s*${num}\\s*${MIN}(?:\\s*${num}\\s*${SEC})?`;

/** 単独の角度の検出用正規表現（優先度の高い順）。axis は文字列自体から分かる軸。 */
function buildLonePatterns(minDecimals) {
  return [
    { axis: 'lat', re: `(?:北緯|南緯)\\s*(?:${dmsAngle}|${num})|緯度\\s*[:：=]?\\s*${labeled}` },
    { axis: 'lon', re: `(?:東経|西経)\\s*(?:${dmsAngle}|${num})|経度\\s*[:：=]?\\s*${labeled}` },
    { axis: 'lat', re: `\\b(?:latitude|lat)["']?\\s*[:=]\\s*${labeled}`, flags: 'i' },
    { axis: 'lon', re: `\\b(?:longitude|long|lng|lon)["']?\\s*[:=]\\s*${labeled}`, flags: 'i' },
    { axis: 'lat', re: `${START}${LAT}${END}` },
    { axis: 'lon', re: `${START}${LON}${END}` },
    { axis: null, re: `${START}${dmAngle}` },
    // ラベルのない小数は、直前に緯度・経度のラベルがあるときだけ使う（needsLabel）
    { axis: null, needsLabel: true, re: `(?<![\\w.．,，\\-−－])${sign}${d}{1,3}[.．]${d}{${minDecimals},}(?![\\w.．])` },
  ].map((p) => ({ ...p, re: new RegExp(p.re, `g${p.flags ?? ''}`) }));
}

let loneCache = { key: '', patterns: [] };

/**
 * text 中の単独の角度（緯度か経度の片方）を返す。ranges（findLocations の結果）と重なるものは除く。
 * @returns {{start: number, end: number, text: string, axis: 'lat'|'lon'|null, degrees: number, needsLabel: boolean}[]}
 */
export function findLoneAngles(text, options = {}, ranges = []) {
  if (options.latlon === false || options.splitPairs === false) return [];
  const minDecimals = Math.max(0, (options.minDecimals ?? 3) | 0);
  if (loneCache.key !== String(minDecimals)) loneCache = { key: String(minDecimals), patterns: buildLonePatterns(minDecimals) };
  const out = [];
  const taken = (s, e) => ranges.some((f) => s < f.end && e > f.start) || out.some((f) => s < f.end && e > f.start);
  for (const p of loneCache.patterns) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken(start, end)) continue;
      const deg = /[0-9０-９]+(?:[.．][0-9０-９]+)?/.exec(m[0].normalize('NFKC').replace('．', '.'));
      out.push({ start, end, text: m[0], axis: p.axis, degrees: Math.abs(Number(deg[0])), needsLabel: !!p.needsLabel });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const CONTEXT_LABEL = new RegExp(`(${LAT_LABEL}|${LON_LABEL})[^0-9０-９]*$`, 'i');

/**
 * 角度の直前の文字列（別の要素のラベルなど）から軸を読む。ラベルと角度の間に数字があれば無関係とみなす。
 * @returns {{axis: 'lat'|'lon', label: string} | null}
 */
export function axisFromContext(before) {
  const m = CONTEXT_LABEL.exec(before);
  if (!m) return null;
  return { axis: new RegExp(`^${LAT_LABEL}$`, 'i').test(m[1]) ? 'lat' : 'lon', label: m[1] };
}

/**
 * 文書順に並んだ単独の角度を、隣り合う 2 つずつ緯度経度の組にする。
 * items[i] は findLoneAngles の結果に次を加えたもの:
 *   gap     … 直前の項目との間にある文字数（空白を除く）。離れすぎていれば組にしない
 *   context … axisFromContext の結果（任意）
 * 軸はラベル → 値（90 を超えれば経度）→ 順序（どちらも 90 以下なら先が緯度）の順で決める。
 * @returns {{first: number, second: number, geometry: object}[]}  first / second は items の番号
 */
export function pairLoneAngles(items, maxGap = 40) {
  const resolved = items.map((it) => {
    if (it.axis) return { ...it, prefix: '' };
    if (it.context) return { ...it, axis: it.context.axis, prefix: `${it.context.label} ` };
    return it.needsLabel ? null : { ...it, prefix: null };
  });
  const pairs = [];
  for (let i = 0; i + 1 < resolved.length; i++) {
    const a = resolved[i];
    const b = resolved[i + 1];
    if (!a || !b || !(b.gap <= maxGap)) continue;
    let axisA = a.axis;
    let axisB = b.axis;
    if (!axisA && !axisB) {
      if (a.degrees > 90 && b.degrees <= 90) [axisA, axisB] = ['lon', 'lat'];
      else if (a.degrees <= 90 && b.degrees <= 90) [axisA, axisB] = ['lat', 'lon'];
      else [axisA, axisB] = ['lat', 'lon'];
    } else if (!axisA) axisA = axisB === 'lat' ? 'lon' : 'lat';
    else if (!axisB) axisB = axisA === 'lat' ? 'lon' : 'lat';
    if (axisA === axisB) continue;
    const part = (it, axis) => `${it.prefix ?? (axis === 'lat' ? '緯度 ' : '経度 ')}${cleanForLibrary(it.text)}`;
    const [lat, lon] = axisA === 'lat' ? [part(a, axisA), part(b, axisB)] : [part(b, axisB), part(a, axisA)];
    const lonLat = parseCoordinate(`${lat}, ${lon}`);
    if (!lonLat) continue;
    pairs.push({ first: i, second: i + 1, geometry: { type: 'Point', coordinates: lonLat } });
    i++;
  }
  return pairs;
}
