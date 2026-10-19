/**
 * dist/ に拡張機能一式を作る。chrome://extensions の「パッケージ化されていない拡張機能を読み込む」で dist/ を指定する。
 *   node scripts/build.mjs           ビルド
 *   node scripts/build.mjs --watch   変更を監視して再ビルド
 * 国境データ（static/data/）は先に `npm run build:data` で作っておく。
 *
 * 設定の既定値は static/config.json。config.local.json（または環境変数 AUTOMAP_CONFIG で指定した JSON）があれば、
 * その値を重ねて dist/config.json にする（scripts/apply-config.mjs。ビルド後の配布物に重ねることもできる）。
 */
import fs from 'node:fs';
import * as esbuild from 'esbuild';
import { applyConfig } from './apply-config.mjs';

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

function applyLocalConfig() {
  const file = process.env.AUTOMAP_CONFIG || 'config.local.json';
  if (fs.existsSync(file)) applyConfig(file, OUT);
  else if (process.env.AUTOMAP_CONFIG) throw new Error(`${file} がありません`);
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
