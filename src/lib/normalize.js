/**
 * 全角・半角などの表記のゆれをそろえる（NFKC）。検出は整えた文字列で行い、見つけた範囲は元の文字列の位置に戻す。
 * 文字列全体を一度に NFKC にすると前後の位置の対応が分からなくなるので、文字（と後ろに続く濁点・半濁点などの結合文字）ごとに変換する。
 */

// NFKC では度の記号にならないが、度の意味で使われる文字
const EXTRA = { '゜': '°', '˚': '°', 'º': '°' };
const CLUSTER = /.[゙゚ﾞﾟ\p{M}]*/gsu;

/**
 * @returns {{ text: string, map: number[] }} map[i] は整えた文字列の i 文字目に当たる元の位置（map[text.length] は元の長さ）
 */
export function normalizeText(source, { extra = true } = {}) {
  let text = '';
  const map = [];
  for (const m of source.matchAll(CLUSTER)) {
    const n = (extra && EXTRA[m[0]]) || m[0].normalize('NFKC');
    for (let i = 0; i < n.length; i++) map.push(m.index);
    text += n;
  }
  map.push(source.length);
  return { text, map };
}

/** 変換が要らない文字列（ASCII だけ）はそのまま使う。 */
export function normalizeIfNeeded(source, options) {
  if (/^[\x00-\x7F]*$/.test(source)) return null;
  return normalizeText(source, options);
}
