/**
 * ビルド済みの拡張機能（dist/ や配布用に展開したフォルダ）に、外部の JSON の設定を重ねる。ビルドし直さずに既定値を変えられる。
 *   node scripts/apply-config.mjs settings.json [拡張機能のフォルダ（既定 dist）]
 *   npm run configure -- settings.json [フォルダ]
 * フォルダの config.json に重ねる（オブジェクトはキーごとに重ね、配列と値は置き換える）。
 * 既定のサービス（gazetteerServices）のサイトは、取得の許可を求めずに済むよう manifest.json の host_permissions に入れる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

export function applyConfig(file, dir = 'dist') {
  const configFile = path.join(dir, 'config.json');
  const manifestFile = path.join(dir, 'manifest.json');
  const config = deepMerge(readJson(configFile), readJson(file));
  writeJson(configFile, config);
  const origins = [...new Set((config.gazetteerServices ?? []).map((s) => new URL(s.url).origin))].map((o) => `${o}/*`);
  const manifest = readJson(manifestFile);
  if (origins.length) manifest.host_permissions = origins;
  else delete manifest.host_permissions;
  writeJson(manifestFile, manifest);
  console.log(`${file} の設定を ${configFile} に重ねました${origins.length ? `（host_permissions: ${origins.join(', ')}）` : ''}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, dir] = process.argv.slice(2);
  if (!file) {
    console.error('使い方: node scripts/apply-config.mjs settings.json [拡張機能のフォルダ（既定 dist）]');
    process.exit(1);
  }
  applyConfig(file, dir);
}
