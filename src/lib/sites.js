/**
 * 稼働しないサイトの判定。config.json の sites.exclude（URL に対する正規表現の配列、大文字小文字は区別しない）。
 */

/** 正しく読めない正規表現は無視する（設定画面で知らせる）。 */
export function compilePatterns(patterns = []) {
  return patterns.flatMap((p) => {
    const s = String(p).trim();
    if (!s) return [];
    try {
      return [new RegExp(s, 'i')];
    } catch {
      return [];
    }
  });
}

/** 読めない正規表現の一覧（設定画面の表示用）。 */
export function invalidPatterns(patterns = []) {
  return patterns.filter((p) => String(p).trim() && !compilePatterns([p]).length);
}

export const isExcluded = (url, patterns) => compilePatterns(patterns).some((re) => re.test(url));
