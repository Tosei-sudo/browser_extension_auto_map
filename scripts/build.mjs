/**
 * dist/ に拡張機能一式を作る。chrome://extensions の「パッケージ化されていない拡張機能を読み込む」で dist/ を指定する。
 *   node scripts/build.mjs           ビルド
 *   node scripts/build.mjs --watch   変更を監視して再ビルド
 * 国境データ（static/data/）は先に `npm run build:data` で作っておく。
 *
 * 設定の既定値は static/config.json。config.local.json（または環境変数 AUTOMAP_CONFIG で指定した JSON）があれば、
 * その値を重ねて dist/config.json にする（オブジェクトはキーごとに重ね、配列と値は置き換える）。
 * 既定のサービス（gazetteerServices）のサイトは、取得の許可を求めずに済むよう manifest の host_permissions に入れる。
 */
import fs from 'node:fs';
import * as esbuild from 'esbuild';

const OUT = 'dist';
const watch = process.argv.includes('--watch');

if (!fs.existsSync('static/data/l2.bin')) {
  console.error('static/data/ がありません。先に `npm run build:data` を実行してください。');
  process.exit(1);
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync('static', OUT, { recursive: true });
applyLocalConfig();
// 配布物にもライセンスと第三者の表記を入れる
for (const f of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) fs.copyFileSync(f, `${OUT}/${f}`);

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = k in base ? deepMerge(base[k], v) : v;
  return out;
}

function applyLocalConfig() {
  const file = process.env.AUTOMAP_CONFIG || 'config.local.json';
  if (!fs.existsSync(file)) {
    if (process.env.AUTOMAP_CONFIG) throw new Error(`${file} がありません`);
    return;
  }
  const config = deepMerge(JSON.parse(fs.readFileSync(`${OUT}/config.json`, 'utf8')), JSON.parse(fs.readFileSync(file, 'utf8')));
  fs.writeFileSync(`${OUT}/config.json`, `${JSON.stringify(config, null, 2)}\n`);
  const origins = [...new Set((config.gazetteerServices ?? []).map((s) => new URL(s.url).origin))].map((o) => `${o}/*`);
  if (origins.length) {
    const manifest = JSON.parse(fs.readFileSync(`${OUT}/manifest.json`, 'utf8'));
    manifest.host_permissions = origins;
    fs.writeFileSync(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  console.log(`${file} の設定を dist/config.json に重ねました${origins.length ? `（host_permissions: ${origins.join(', ')}）` : ''}`);
}

const options = {
  entryPoints: {
    background: 'src/background.js',
    content: 'src/content.js',
    map: 'src/map.js',
    options: 'src/options.js',
    sidepanel: 'src/sidepanel.js',
  },
  bundle: true,
  outdir: OUT,
  // content script は ES モジュールとして読めないので全部 IIFE にする（background も問題なく動く）
  format: 'iife',
  target: 'chrome116',
  charset: 'utf8',
  sourcemap: 'linked',
  minify: true,
  logLevel: 'info',
  // coordinate-notation の tsconfig.json は元リポジトリの設定を参照しており、ここでは見つからない（JS 出力の取り込みには不要）
  logOverride: { 'tsconfig.json': 'silent' },
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
