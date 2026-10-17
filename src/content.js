/**
 * ページ内のテキストから位置の記述を探してハイライトし、
 * ホバーで地図画像、クリックで動かせる地図（別タブ）を表示する。
 *
 * ページの DOM は書き換えない。ハイライトは CSS Custom Highlight API（Range）で描き、
 * マウスの下の文字は caretPositionFromPoint で調べる。React などがテキストノードを持ち続けて
 * 書き換えても壊れないようにするためで、変化は MutationObserver で拾ってその段落だけ調べ直す。
 */
import { formatDms, formatLatLon, formatMgrs } from '../coordinate-notation/dist/cdn/coordinate-notation.min.js';
import { axisFromContext, findLoneAngles, findLocations, pairLoneAngles } from './lib/detect.js';
import { cellSizeText } from './lib/geohash.js';
import { vertices } from './lib/wkt.js';

const KIND_LABEL = { latlon: '緯度経度', mgrs: 'MGRS', utm: 'UTM', geohash: 'GeoHash', wkt: 'WKT' };
// 中身を調べない要素（スクリプト、入力欄など）
const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'IFRAME', 'CANVAS', 'SVG', 'MATH']);
// 文字が続いているとみなす要素。これ以外（div、p、td など）を段落とし、その境目で文字列を区切る
const INLINE = new Set([
  'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN', 'EM', 'FONT', 'I', 'INS', 'KBD', 'LABEL', 'MARK',
  'NOBR', 'Q', 'RP', 'RT', 'RUBY', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'TT', 'U', 'VAR', 'WBR',
]);
// 位置の記述はどれも数字を含む（全角数字も）
const HAS_DIGIT = /[0-9０-９]/;
const HL = 'automap';

let config = null;
const send = (msg) => chrome.runtime.sendMessage(msg);

// ---- 段落単位の検出 ----

const tagOf = (el) => el.tagName.toUpperCase();
const isInline = (el) => INLINE.has(tagOf(el));

/** node を含む段落（インライン要素でない最も近い祖先）。 */
function blockOf(node) {
  let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  while (el && el !== document.body && isInline(el)) el = el.parentElement;
  return el;
}

function isSkipped(el) {
  for (let e = el; e && e !== document.documentElement; e = e.parentElement) {
    if (SKIP.has(tagOf(e))) return true;
  }
  return el.isContentEditable;
}

/** root 以下の段落すべて（root が段落ならそれも含む）。 */
function blocksIn(root) {
  if (root.nodeType !== Node.ELEMENT_NODE) return [];
  const out = isInline(root) ? [] : [root];
  for (const el of root.querySelectorAll('*')) if (!isInline(el) && !SKIP.has(tagOf(el))) out.push(el);
  return out;
}

/** 段落の文字列と、文字位置とテキストノードの対応。入れ子の段落と <br> は改行 1 文字にする。 */
function blockText(block) {
  let text = '';
  const segs = [];
  const walk = (el) => {
    for (let c = el.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) {
        segs.push({ node: c, start: text.length, end: text.length + c.nodeValue.length });
        text += c.nodeValue;
      } else if (c.nodeType === Node.ELEMENT_NODE && !SKIP.has(tagOf(c))) {
        if (isInline(c)) walk(c);
        else text += '\n';
      }
    }
  };
  walk(block);
  return { text, segs };
}

/** 段落の文字列中の範囲 → Range（複数のテキストノードにまたがってよい）。 */
function makeRange(segs, start, end) {
  const s = segs.find((g) => start >= g.start && start < g.end);
  const e = segs.findLast((g) => end > g.start && end <= g.end);
  if (!s || !e) return null;
  const range = new Range();
  range.setStart(s.node, start - s.start);
  range.setEnd(e.node, end - e.start);
  return range;
}

let nextId = 1;
const newLoc = (text, kind, geometry, ranges) => ({ id: nextId++, text, kind, geometry, ranges });

/** 段落 → { full: 段落内で完結する検出結果, lones: 緯度・経度の片方だけの記述 } */
const blocks = new Map();

function scanBlock(block) {
  // 調べ直しても同じ記述が残っていれば同じ id を使う（一覧の選択などが外れないように）
  const previous = new Map((blocks.get(block)?.full ?? []).map((l) => [l.text, l.id]));
  blocks.delete(block);
  if (!block.isConnected || isSkipped(block)) return;
  const { text, segs } = blockText(block);
  if (text.length < 4 || !HAS_DIGIT.test(text)) return;
  const found = findLocations(text, config.detect);
  const full = [];
  for (const f of found) {
    const range = makeRange(segs, f.start, f.end);
    if (!range) continue;
    const loc = newLoc(f.text, f.kind, f.geometry, [range]);
    if (previous.has(f.text)) {
      loc.id = previous.get(f.text);
      previous.delete(f.text);
    }
    full.push(loc);
  }
  const lones = [];
  for (const a of findLoneAngles(text, config.detect, found)) {
    const range = makeRange(segs, a.start, a.end);
    if (range) lones.push({ ...a, range, uid: nextId++ });
  }
  if (full.length || lones.length) blocks.set(block, { full, lones });
}

// ---- 別々の段落にある緯度と経度の組 ----

// ラベルを探す範囲（直前の文字数）
const CONTEXT_CHARS = 24;
const textWalker = () => document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
const nonSpaceLength = (s) => s.replace(/\s+/g, '').length;

/** 位置の直前の文字列（前の要素にまたがって CONTEXT_CHARS 文字まで）。 */
function textBefore(node, offset) {
  let s = node.nodeValue.slice(0, offset);
  const w = textWalker();
  w.currentNode = node;
  while (s.length < CONTEXT_CHARS && w.previousNode()) s = w.currentNode.nodeValue + s;
  return s.slice(-CONTEXT_CHARS);
}

/** 2 つの範囲の間にある文字数（空白を除く）。max を超えたら Infinity。 */
function gapBetween(a, b, max) {
  const from = a.endContainer;
  const to = b.startContainer;
  if (from === to) return nonSpaceLength(from.nodeValue.slice(a.endOffset, b.startOffset));
  let n = nonSpaceLength(from.nodeValue.slice(a.endOffset));
  const w = textWalker();
  w.currentNode = from;
  while (n <= max && w.nextNode()) {
    if (w.currentNode === to) return n + nonSpaceLength(to.nodeValue.slice(0, b.startOffset));
    n += nonSpaceLength(w.currentNode.nodeValue);
  }
  return Infinity;
}

const alive = (range) => range.startContainer.isConnected && range.endContainer.isConnected && !range.collapsed;
const byPosition = (a, b) => a.compareBoundaryPoints(Range.START_TO_START, b);

let pairLocs = new Map(); // "uid-uid" → loc（組が変わらなければ同じ id を使い続ける）

function updatePairs() {
  const lones = [...blocks.values()].flatMap((b) => b.lones).filter((a) => alive(a.range));
  lones.sort((a, b) => byPosition(a.range, b.range));
  const maxGap = config.detect.pairMaxGap;
  lones.forEach((a, i) => {
    a.gap = i ? gapBetween(lones[i - 1].range, a.range, maxGap) : Infinity;
    a.context = a.axis ? undefined : axisFromContext(textBefore(a.range.startContainer, a.range.startOffset));
  });
  const next = new Map();
  for (const { first, second, geometry } of pairLoneAngles(lones, maxGap)) {
    const a = lones[first];
    const b = lones[second];
    const key = `${a.uid}-${b.uid}`;
    next.set(key, pairLocs.get(key) ?? newLoc(`${a.text.trim()} / ${b.text.trim()}`, 'latlon', geometry, [a.range, b.range]));
  }
  pairLocs = next;
}

// ---- ハイライトとマウス位置の判定 ----

let allLocs = [];
let nodeIndex = new WeakMap(); // テキストノード → そのノードにかかる検出結果

function textNodesIn(range) {
  if (range.startContainer === range.endContainer) return [range.startContainer];
  const nodes = [];
  const w = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  w.currentNode = range.startContainer;
  for (let n = range.startContainer; n; n = w.nextNode()) {
    nodes.push(n);
    if (n === range.endContainer) break;
  }
  return nodes;
}

/**
 * 描画用の Range。拡張機能（content script）で作った Range は、複数のテキストノードにまたがると
 * Chrome で描画されないため、テキストノードごとに分ける。
 */
function paintRanges(loc) {
  return (loc.paint ??= loc.ranges.flatMap((range) => {
    const nodes = textNodesIn(range);
    if (nodes.length === 1) return [range];
    return nodes.map((n) => {
      const r = new Range();
      r.setStart(n, n === range.startContainer ? range.startOffset : 0);
      r.setEnd(n, n === range.endContainer ? range.endOffset : n.nodeValue.length);
      return r;
    });
  }));
}

/** 検出結果の一覧・ハイライト・ノードの索引を作り直す。 */
function rebuild() {
  for (const b of blocks.keys()) if (!b.isConnected) blocks.delete(b);
  updatePairs();
  allLocs = [...[...blocks.values()].flatMap((b) => b.full), ...pairLocs.values()].filter((l) => l.ranges.every(alive));
  allLocs.sort((a, b) => byPosition(a.ranges[0], b.ranges[0]));
  nodeIndex = new WeakMap();
  for (const loc of allLocs) {
    for (const r of loc.ranges) {
      for (const n of textNodesIn(r)) {
        if (!nodeIndex.has(n)) nodeIndex.set(n, []);
        nodeIndex.get(n).push(loc);
      }
    }
  }
  CSS.highlights.set(HL, new Highlight(...allLocs.flatMap(paintRanges)));
  // ホバー中の記述が書き換えで作り直されたら、マウスの位置で判定し直す
  if (current && !allLocs.includes(current.loc)) {
    const hit = lastMouse && hitTest(lastMouse.x, lastMouse.y);
    if (hit) show(hit);
    else hide();
  }
  notifyChanged();
}

function caretAt(x, y) {
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    return p && { node: p.offsetNode, offset: p.offset };
  }
  const r = document.caretRangeFromPoint?.(x, y);
  return r && { node: r.startContainer, offset: r.startOffset };
}

const inRect = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/** 画面上の点の下にある検出結果と、その Range。 */
function hitTest(x, y) {
  const caret = caretAt(x, y);
  const candidates = caret && nodeIndex.get(caret.node);
  if (!candidates) return null;
  for (const loc of candidates) {
    for (const range of loc.ranges) {
      if (!range.isPointInRange(caret.node, caret.offset)) continue;
      // カーソル位置は行末の外側などでも最寄りの文字を返すので、実際に文字の上にあるかを確かめる
      if ([...range.getClientRects()].some((r) => inRect(r, x, y))) return { loc, range };
    }
  }
  return null;
}

// ---- 走査の段取り ----

/** 大きなページで固まらないよう、アイドル時間に少しずつ処理する。 */
const idle = window.requestIdleCallback ?? ((cb) => setTimeout(() => cb({ timeRemaining: () => 10 }), 16));
async function eachIdle(list, fn) {
  let i = 0;
  while (i < list.length) {
    await new Promise((resolve) =>
      idle((deadline) => {
        do fn(list[i++]);
        while (i < list.length && deadline.timeRemaining() > 2);
        resolve();
      }),
    );
  }
}

let chain = Promise.resolve();
function enqueue(blockList) {
  chain = chain
    .then(async () => {
      await eachIdle([...new Set(blockList)], scanBlock);
      rebuild();
    })
    .catch((e) => console.warn('[AutoMap]', e));
}

function observe() {
  const dirty = new Set();
  let timer = 0;
  new MutationObserver((records) => {
    for (const r of records) {
      // 書き換えられたテキストや追加・削除のあった段落と、追加された要素の中の段落を調べ直す
      const block = blockOf(r.target);
      if (block) dirty.add(block);
      if (r.type === 'childList') for (const n of r.addedNodes) for (const b of blocksIn(n)) dirty.add(b);
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      const list = [...dirty];
      dirty.clear();
      enqueue(list);
    }, 100);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });
}

// ---- ホバーで表示する地図画像 ----

let tooltip = null;
let tooltipParts = null;
let current = null; // { loc, range }
let hideTimer = 0;
let lastMouse = null;
const imageCache = new Map();

function createTooltip() {
  const host = document.createElement('div');
  host.id = 'automap-tooltip';
  host.style.cssText = 'position:fixed;z-index:2147483647;top:0;left:0;pointer-events:none;display:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box { font: 12px/1.45 system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Meiryo", sans-serif; color: #1f2328;
             background: #fff; border: 1px solid rgba(0,0,0,.18); border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.22);
             overflow: hidden; }
      .img { display: block; background: #e8eef2; }
      .info { padding: 6px 9px 7px; border-top: 1px solid rgba(0,0,0,.08); }
      .country { font-weight: 600; }
      .coord { color: #57606a; font-variant-numeric: tabular-nums; }
      .hint { color: #8b949e; font-size: 11px; }
      .err { color: #b42318; }
    </style>
    <div class="box">
      <img class="img" alt="">
      <div class="info"><div class="country"></div><div class="coord"></div><div class="hint">クリックで地図を開く</div></div>
    </div>`;
  document.documentElement.append(host);
  tooltip = host;
  tooltipParts = {
    img: root.querySelector('.img'),
    country: root.querySelector('.country'),
    coord: root.querySelector('.coord'),
    hint: root.querySelector('.hint'),
  };
}

function describeCoord(loc) {
  const g = loc.geometry;
  if (g.center) {
    return [formatLatLon(g.center), formatDms(g.center), `GeoHash セル ${cellSizeText(g)}`].join('<br>');
  }
  if (g.type !== 'Point') {
    const n = [...vertices(g)].length;
    return `${KIND_LABEL[loc.kind]} ${g.type}（${n} 点）`;
  }
  const mgrs = formatMgrs(g.coordinates);
  return [formatLatLon(g.coordinates), formatDms(g.coordinates), mgrs && `MGRS ${mgrs}`].filter(Boolean).join('<br>');
}

function place() {
  if (!current) return;
  const r = current.range.getBoundingClientRect();
  const w = config.image.width + 2;
  const h = tooltip.offsetHeight || config.image.height + 70;
  const left = Math.min(Math.max(8, r.left), window.innerWidth - w - 8);
  let top = r.bottom + 6;
  if (top + h > window.innerHeight - 8 && r.top - h - 6 > 8) top = r.top - h - 6;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

const linkOf = (range) => range.startContainer.parentElement?.closest('a[href]');

async function show(hit) {
  if (!tooltip) createTooltip();
  current = hit;
  const { loc, range } = hit;
  // 別々の段落にある緯度と経度の組は、片方に乗ったときに両方を強調する
  const active = new Highlight(...paintRanges(loc));
  active.priority = 1;
  CSS.highlights.set(`${HL}-active`, active);
  document.documentElement.classList.add(`${HL}-pointer`);

  const { img, country, coord, hint } = tooltipParts;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  hint.textContent = linkOf(range) ? `クリックで地図を開く（${mod}+クリックでリンクを開く）` : 'クリックで地図を開く';
  img.width = config.image.width;
  img.height = config.image.height;
  img.removeAttribute('src');
  country.textContent = '地図を作成中…';
  country.className = 'country';
  coord.innerHTML = describeCoord(loc);
  tooltip.style.display = 'block';
  place();

  const key = JSON.stringify(loc.geometry);
  let result = imageCache.get(key);
  if (!result) {
    result = send({ type: 'render', geometry: loc.geometry, dpr: window.devicePixelRatio });
    imageCache.set(key, result);
  }
  const res = await result.catch((e) => ({ error: String(e) }));
  if (current?.loc !== loc) return;
  if (res?.error || !res) {
    imageCache.delete(key);
    country.textContent = `地図を作成できませんでした: ${res?.error ?? ''}`;
    country.className = 'country err';
    return;
  }
  img.src = res.image;
  country.textContent = res.countries.length ? res.countries.map((c) => `${c.name} (${c.iso3})`).join(' / ') : '海上';
  place();
}

function hide() {
  current = null;
  CSS.highlights.delete(`${HL}-active`);
  document.documentElement.classList.remove(`${HL}-pointer`);
  if (tooltip) tooltip.style.display = 'none';
}

function bindEvents() {
  let frame = 0;
  let last = null;
  addEventListener(
    'mousemove',
    (e) => {
      last = e;
      lastMouse = { x: e.clientX, y: e.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const hit = hitTest(last.clientX, last.clientY);
        if (hit) {
          clearTimeout(hideTimer);
          hideTimer = 0;
          if (hit.loc !== current?.loc) show(hit);
        } else if (current && !hideTimer) {
          hideTimer = setTimeout(() => {
            hideTimer = 0;
            hide();
          }, 120);
        }
      });
    },
    { passive: true },
  );
  addEventListener('scroll', place, { passive: true, capture: true });
  // リンク内の座標でもページ遷移より地図を優先する。Ctrl（Mac は ⌘）を押しながらなら通常のクリック（リンクを開く）にする
  addEventListener(
    'click',
    (e) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey) return;
      const hit = hitTest(e.clientX, e.clientY);
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      send({ type: 'openMap', items: [toItem(hit.loc)] });
    },
    true,
  );
}

// ---- サイドパネルの一覧とのやりとり ----

const liveLocs = () => allLocs.filter((l) => l.ranges.every(alive));
const toItem = (loc) => ({ id: loc.id, text: loc.text, kind: loc.kind, geometry: loc.geometry });

let notifyTimer = 0;
let lastCount = -1;
let lastIds = '';
function notifyChanged() {
  clearTimeout(notifyTimer);
  notifyTimer = setTimeout(() => {
    const locs = liveLocs();
    const ids = locs.map((l) => l.id).join(',');
    if (locs.length === lastCount && ids === lastIds) return;
    lastCount = locs.length;
    lastIds = ids;
    send({ type: 'locationsChanged', count: locs.length }).catch(() => {});
  }, 200);
}

/** 該当箇所までスクロールして、しばらく点滅させる。 */
let flashTimer = 0;
function reveal(id) {
  const loc = liveLocs().find((l) => l.id === id);
  if (!loc) return false;
  loc.ranges[0].startContainer.parentElement?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
  clearInterval(flashTimer);
  let n = 0;
  const flash = new Highlight(...paintRanges(loc));
  flash.priority = 2;
  flashTimer = setInterval(() => {
    if (n++ % 2 === 0) CSS.highlights.set(`${HL}-flash`, flash);
    else CSS.highlights.delete(`${HL}-flash`);
    if (n >= 8) clearInterval(flashTimer);
  }, 300);
  return true;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'listLocations') sendResponse({ items: liveLocs().map(toItem), url: location.href, title: document.title });
  else if (msg?.type === 'revealLocation') sendResponse({ ok: reveal(msg.id) });
});

function injectStyle() {
  const c = config.colors;
  const style = document.createElement('style');
  style.textContent =
    `::highlight(${HL}){background-color:${c.textHighlight};}` +
    `::highlight(${HL}-active){background-color:${c.textHighlight};text-decoration:underline 2px ${c.marker};}` +
    `::highlight(${HL}-flash){background-color:${c.marker};color:#fff;}` +
    `html.${HL}-pointer,html.${HL}-pointer *{cursor:pointer !important;}`;
  (document.head ?? document.documentElement).append(style);
}

async function main() {
  if (!document.body || !globalThis.CSS?.highlights) return;
  config = await send({ type: 'getConfig' });
  if (!config || config.error) return;
  injectStyle();
  bindEvents();
  enqueue(blocksIn(document.body));
  observe();
}

main();
