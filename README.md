# AutoMap

ブラウザで表示しているページの文章から位置の記述を見つけてハイライトする Chrome / Edge 拡張機能（Manifest V3）です。

- ハイライトにマウスを乗せると、その位置に印を付けた地図の画像を表示します。
- クリックすると、ドラッグと拡大縮小ができる地図（OpenLayers）を別タブで開きます。
- 位置が陸上なら、その国を別の色で塗ります（線・面の場合は、通る国・含む国をすべて塗ります）。
- リンクの中の座標は、Ctrl（Mac は ⌘）を押しながらクリックすると地図ではなくリンクを開きます。
- ツールバーのアイコンに検出件数を表示し、アイコンを押すとサイドパネルに一覧を表示します。
  - 行をクリックするとページの該当箇所までスクロールして点滅します。「地図」で 1 件、「すべて地図で表示」で全件（種類で絞り込んだときはその分）を地図タブに出します。
  - 全件の地図では、左の一覧で選ぶとその位置へ寄り、地図上の位置をクリックすると元のタブに切り替えて該当箇所を表示します。
- 画像ビューアアプリ（`web+imageviewer` プロトコル）へのリンクを、地図タブの情報パネル（表示中・選択中の位置、全件表示では「すべて」も）とサイドパネルの各行に置いています。
  URL は `web+imageviewer:geom=<WKT を encodeURIComponent したもの>` で、全件は `GEOMETRYCOLLECTION` にまとめます（例: `web+imageviewer:geom=POINT%20(139.7671%2035.6812)`）。

## 対応している表記

| 種類 | 例 |
| --- | --- |
| 緯度経度（10 進） | `35.6812, 139.7671`、`-33.8688, 151.2093`、`N35.6812 E139.7671`、`35.6812° 139.7671°` |
| 度分秒 | `35°40'52.3"N 139°46'1.6"E`、`354052N 1394601E`、`35d40m52s N …` |
| 度分（緯度 4 桁・経度 5 桁） | `3541N 13946E`、`N3541 E13946`、`3541 13946`（記号なしは北緯・東経として読む） |
| 日本語 | `北緯35度40分52秒 東経139度46分1秒`、`緯度：35.6812、経度：139.7671`、全角数字 |
| ラベル付き | `lat 35.68 lon 139.76`、`{"lat": 35.68, "lng": 139.76}` |
| MGRS | `54SUE8843349290`、`54S UE 88433 49290` |
| UTM | `54N 388433 3949290`（半球 N/S）、`54S 388268 3949227`（緯度帯 C〜X）、`mE`/`mN` 付きも可 |
| GeoHash | `geohash: xn76urx4`（ラベル付き）、`xn76urx4`（ラベルなしは 6〜12 文字で数字と英字が混ざるものだけ）。セルの範囲を面（Polygon）として扱う |
| WKT | `POINT`、`LINESTRING`、`POLYGON`、`MULTI*`、`GEOMETRYCOLLECTION`（Z / M 付き、`SRID=4326;` 付きも可） |

UTM の `S` は「南半球」と「緯度帯 S（北緯 32〜40 度）」のどちらの意味でも使われます。緯度帯として読んで帯の中に収まればそちらを、収まらなければ南半球として読みます。そのほかの緯度帯の文字は、読んだ位置が帯から外れていれば検出しません。

記号もラベルもない小数の組（`35.681, 139.767`）は、誤検出を避けるため小数点以下 3 桁以上のときだけ検出します（設定で変更可）。
記号のない度分の組（`3541 13946`）は、分が 60 未満・緯度 90 度以下・経度 180 度以下で、直後が単位（`円`、`人` など漢字・かな）や `%` でないときだけ検出します（設定 `detect.plainDegMin` で無効にできます）。

全角の数字・英字・記号（`３５４１Ｎ`、`ＭＧＲＳ`、`，`、`：`、`－` など）や半角カナは、NFKC で半角にそろえてから調べます（`゜` は度として読みます）。ハイライトは元の文字の位置に付きます。地名の照合も同じようにそろえて比べるので、`ＡＢＣ` と `ABC`、`１丁目` と `1丁目` は同じ名前として扱います。
### ページの書き換えへの追随

ページの DOM は書き換えません。ハイライトは CSS Custom Highlight API で描き、マウスの下の文字は `caretPositionFromPoint` で調べます。
そのため React などがテキストを書き換えてもページを壊さず、変化した段落だけを MutationObserver で調べ直します（約 0.1 秒後に反映）。

検出は段落（`p`・`div`・`td` など、インライン要素以外）ごとに中の文字列をつないで行うので、`<b>35.68</b>, <i>139.76</i>` のようにタグで分かれていても 1 つの座標として扱います。

### 緯度と経度が別々の要素にある場合

表のセルや別の行に分かれていても、文書順で隣り合い、間の文字が 40 文字以内（`detect.pairMaxGap`）なら 1 つの位置として扱います。ホバーすると両方が枠で強調されます。

- 度分（秒）付きの値: `138度 55分 59.1599秒` と `35度 58分 40.4399秒`（度だけの `35度` は温度などと紛れるので対象外）
- 半球・ラベル付きの値: `北緯35度41分14秒` と `東経139度45分51秒`、`N35.68`、`緯度: 35.68`
- 直前にラベルがある小数: `<th>緯度</th><td>35.681236</td>` と `<th>経度</th><td>139.767125</td>`（ラベルのない小数同士は組にしない）

緯度か経度かは、ラベル（直前の 緯度 / 経度 / 北緯 / 南緯 / 東経 / 西経 / lat / lon など）、値（90 を超えれば経度）、順序（どちらも 90 以下でラベルもなければ先が緯度）の順で決めます。

座標の解析・変換には `coordinate-notation/` を使っています。このライブラリが対象にしていない GeoHash と POINT 以外の WKT は `src/lib/geohash.js`、`src/lib/wkt.js` で読みます。

## 地名（ArcGIS フィーチャーサービス）

設定の「地名」で ArcGIS のフィーチャーサービス（レイヤー）を指定すると、そこから取得した地名もページ内で検出します（既定はオフ）。サービスは複数登録でき、URL・条件・属性の対応とキャッシュはサービスごとに持ちます。

- 地名は前もってまとめて取得し、拡張機能のローカルストレージにキャッシュします。ページを開くたびにサービスへ問い合わせることはありません。
- 取得は標準の `query` エンドポイントを `resultOffset` / `resultRecordCount` でページ送りして行います（座標は `outSR=4326`）。
- 各サービスの「保存して地名データを取得」で取得します。初回はサービスのサイトへのアクセス許可を求めます。キャッシュが有効期間を過ぎるか、そのサービスの URL・条件・属性の設定を変えると、次にページを開いたときに自動で取り直します（失敗したときは 1 時間空けて再試行）。一覧から削除したサービスのキャッシュは捨てます。
- 照合は名前（と読み）の完全一致で、同じ位置からは最も長い名前を採ります。英数字の名前は単語の一部では検出しません。同じ名前が複数あるときは、一覧で上にあるサービスの、最初の 1 件の位置を使います。
- 位置は緯度・経度の属性を指定すればその値を、空ならジオメトリ（点以外は外接矩形の中心）を使います。

サービスごとの設定（設定画面で保存した一覧は `chrome.storage.sync` の `gazetteerServices`、既定の一覧は `config.json` の `gazetteerServices`）:

| 項目 | 内容 | 既定値 |
| --- | --- | --- |
| `label` | 一覧での見分け用の名前（任意） | 空 |
| `enabled` | このサービスを使う | `true` |
| `url` | レイヤーの URL（`…/FeatureServer/0` など。`/query` は付けても付けなくてもよい） | 空 |
| `where` | 取得する条件（where 句） | `1=1` |
| `nameField` / `readingField` | 名前・読みの属性（読みは任意） | `NAME` / 空 |
| `lonField` / `latField` | 経度・緯度の属性（空ならジオメトリ） | 空 |

全体の設定（`config.json`）:

| キー | 内容 | 既定値 |
| --- | --- | --- |
| `gazetteer.enabled` | 地名を検出する | `false` |
| `gazetteer.minLength` | 検出する名前の最小文字数 | 2 |
| `gazetteer.maxAgeHours` | キャッシュの有効期間（時間、0 は無期限） | 168 |
| `gazetteer.pageSize` / `maxFeatures` | 1 回の要求の件数 / 1 サービスから取得する最大件数 | 1000 / 100000 |

1 サービスだけだった版の設定（`gazetteer.url` など）は、そのまま 1 つ目のサービスとして読み込みます。

## 使い方

国境データ `country_bound.geojson`（約 150 MB）は GitHub のファイルサイズ上限を超えるためリポジトリに含めていません。[World Bank Official Boundaries](https://datacatalog.worldbank.org/search/dataset/0038272) から国（Admin 0）の境界の GeoJSON をダウンロードし、`country_bound.geojson` という名前でこのフォルダ直下に置いてください。

```sh
npm install
npm run build:data   # country_bound.geojson → static/data/（最初の 1 回と、geojson を差し替えたとき）
npm run build        # dist/ に拡張機能一式を作る
npm test             # 検出のテスト
```

GitHub Actions（`.github/workflows/build.yml`）がプルリクエストと main へのマージのたびにテストとビルドを行います。main でビルドした `dist/` は、その実行結果の Artifacts（`automap-dist`）からダウンロードできます。

Chrome で `chrome://extensions` を開き、「デベロッパー モード」をオンにして「パッケージ化されていない拡張機能を読み込む」で `dist/` を選びます。
ローカルファイル（`file://`）でも使う場合は、拡張機能の詳細で「ファイルの URL へのアクセスを許可する」をオンにしてください。

## 設定

既定値は `static/config.json`（ビルド後は `dist/config.json`）です。拡張機能の「オプション」画面でも変更でき、そこで保存した値は既定値に上書きされます（プレビュー付き）。

### 既定値を JSON で決める（ビルド時）

`static/config.json` を直接書き換えるほか、リポジトリ直下に `config.local.json` を置くと、ビルド時にその値を `static/config.json` に重ねて `dist/config.json` を作ります（`config.local.json` は Git に含めません。書き方は [`config.local.example.json`](config.local.example.json)）。別の場所のファイルを使うときは `AUTOMAP_CONFIG=path/to/config.json npm run build` とします。

- オブジェクトはキーごとに重ね、配列と値は置き換えます。書かなかった項目は `static/config.json` の値のままです。
- `gazetteerServices` に地名のサービスの一覧（項目は下の「地名」の表のとおり。`id` は省略可）を書くと、それが既定のサービスになります。そのサイトは `manifest.json` の `host_permissions` に入るので、アクセスの許可を求めずに取得します。
- 設定画面で保存した値は既定値より優先します。サービスの一覧は、設定画面で一度保存するとそちらを使い、「既定値に戻す」で既定の一覧に戻ります。
- GitHub Actions では、リポジトリの変数 `AUTOMAP_CONFIG_JSON` に JSON を入れておくと、それを `config.local.json` として使ってビルドします。

| キー | 内容 | 既定値 |
| --- | --- | --- |
| `colors.highlightCountry` | 位置のある国 | `#FFFFFF` |
| `colors.otherCountry` | その他の国 | `#BBBBBB` |
| `colors.ocean` | 海洋 | `#A8D8F0`（水色） |
| `colors.border` | 国境線 | `#7A7A7A` |
| `colors.marker` / `markerStroke` | ポイントと縁 | `#E53935` / `#FFFFFF` |
| `colors.geometryStroke` / `geometryFill` | WKT の線・面 | |
| `colors.textHighlight` | ページ内のハイライト | |
| `map.*` | 国境線・ポイント・線の太さ | |
| `image.width` / `height` | ホバー画像の大きさ (px) | 320 × 200 |
| `image.oceanSpanDeg` | 海上の点の表示範囲（度） | 40 |
| `image.maxCountrySpanDeg` | これより広い国（海外領土を含む国など）は点のある島・大陸部分だけを映す | 60 |
| `detect.*` | 検出する表記の切り替え | すべて有効 |

色は CSS の色表記（`#RRGGBB`、`rgba(...)` など）が使えます。ホバー画像と別タブの地図は同じ設定・同じ描画処理を使います。

## 国境データ

出典: [World Bank Official Boundaries](https://datacatalog.worldbank.org/search/dataset/0038272) © The World Bank（[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)）。形状の簡略化と属性の削減を行って使用しています。別タブの地図の右下にもこの出典を表示しています。

`scripts/build-data.mjs` が `country_bound.geojson`（約 150 MB）から次を作ります。

- 属性は国名（`NAM_0`）と ISO コード（`ISO_A3`、`ISO_A2`）だけを残します。
- 座標は小数 6 桁（約 10 cm）に丸め、連続する同じ点を除きます。
- `l2.bin`（約 30 MB）: 許容誤差 0.000001°（約 0.1 m）の間引きのみで、元データとほぼ同じ形です（366 万点）。国の判定と拡大表示に使います。
- `l1.bin`（約 9 MB、0.004°）、`l0.bin`（約 2 MB、0.02°）: 縮小表示用です。表示倍率に応じて自動で切り替えます。

地図は Web メルカトル図法です（緯度 ±85° より極側は表示されません）。別タブの地図は OpenLayers で、表示倍率に応じて l0 / l1 / l2 を切り替えます（ホバー画像と同じ基準）。背景タイルは使わず、国境データだけを表示します。

## 構成

```
src/background.js   Service Worker。国境データの保持、ホバー画像の生成（OffscreenCanvas、lib/render.js）、地図タブを開く
src/content.js      ページの走査、ハイライト、ホバー表示、クリック
src/map.js          別タブの地図（OpenLayers、static/map.html）
src/options.js      設定画面（static/options.html）
src/sidepanel.js    検出一覧のサイドパネル（static/sidepanel.html）
src/lib/detect.js   文中の位置記述の検出
src/lib/locate.js   ハイライトする国と表示範囲の決定
src/lib/render.js   ホバー画像・設定画面プレビューの描画
src/lib/geodata.js  国境データの読み込みと点の国判定
src/lib/arcgis.js   ArcGIS フィーチャーサービスからの地名の取得
src/lib/gazetteer.js キャッシュした地名による文中の地名の検出
src/lib/services.js 地名を取得するサービスの一覧とキャッシュのキー
src/lib/normalize.js 全角・半角のゆれをそろえる（元の位置との対応つき）
```

## ライセンス

AutoMap 本体のソースコードは [MIT License](LICENSE) です。

配布物には OpenLayers（BSD-2-Clause）、coordinate-notation・mgrs（MIT）などのソフトウェアと、World Bank Official Boundaries（CC BY 4.0）から作ったデータが含まれます。それぞれのライセンスと出典は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめています。ビルドすると `LICENSE` と `THIRD_PARTY_NOTICES.md` も `dist/` にコピーされます。

このソフトウェアを引用するときの情報は [CITATION.cff](CITATION.cff) にあります。
