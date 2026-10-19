/**
 * 設定 = 拡張内の config.json（既定値）に、設定画面で保存した値（chrome.storage.sync の "config"）を重ねたもの。
 */
export const STORAGE_KEY = 'config';

export async function loadDefaults() {
  return (await fetch(chrome.runtime.getURL('config.json'))).json();
}

/** 既定値の構造に沿って overrides の値を重ねる（既定値にないキーは無視する。配列は丸ごと置き換える）。 */
export function merge(defaults, overrides) {
  if (!overrides || typeof overrides !== 'object') return structuredClone(defaults);
  const out = {};
  for (const [k, v] of Object.entries(defaults)) {
    if (Array.isArray(v)) out[k] = structuredClone(Array.isArray(overrides[k]) ? overrides[k] : v);
    else if (v && typeof v === 'object') out[k] = merge(v, overrides[k]);
    else out[k] = overrides[k] !== undefined && typeof overrides[k] === typeof v ? overrides[k] : v;
  }
  return out;
}

export async function loadConfig() {
  const [defaults, stored] = await Promise.all([loadDefaults(), chrome.storage.sync.get(STORAGE_KEY)]);
  return merge(defaults, stored[STORAGE_KEY]);
}
