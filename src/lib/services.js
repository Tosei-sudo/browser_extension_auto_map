/**
 * 地名を取得する ArcGIS フィーチャーサービスの一覧（chrome.storage.sync の "gazetteerServices"）。
 * サービスごとに URL・条件・属性の対応を持ち、キャッシュも別々に置く。
 * 有効期間など全体の設定は config.json の gazetteer にある。
 */
import { STORAGE_KEY } from './config.js';

export const SERVICES_KEY = 'gazetteerServices';

// chrome.storage.local のキー。地名の配列は大きくなりうるので、取得日時などの情報とは分けて置く
export const entriesKey = (id) => `gazetteerEntries:${id}`; // { source, entries }
export const metaKey = (id) => `gazetteerMeta:${id}`; // { source, fetchedAt, count, attemptedAt, error }
export const isEntriesKey = (key) => key.startsWith('gazetteerEntries:');

const FIELDS = { label: '', enabled: true, url: '', where: '1=1', nameField: 'NAME', readingField: '', lonField: '', latField: '' };

export function newService() {
  return { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, ...FIELDS };
}

/** 一覧を読む。まだ一覧がなく、以前の 1 サービスだけの設定（config.gazetteer.url）があればそれを使う。 */
export async function loadServices() {
  const stored = await chrome.storage.sync.get([SERVICES_KEY, STORAGE_KEY]);
  if (Array.isArray(stored[SERVICES_KEY])) return stored[SERVICES_KEY].map((s) => ({ ...FIELDS, ...s }));
  const old = stored[STORAGE_KEY]?.gazetteer;
  if (!old?.url) return [];
  const service = { id: 'default', ...FIELDS };
  for (const k of Object.keys(FIELDS)) if (typeof old[k] === typeof FIELDS[k]) service[k] = old[k];
  return [service];
}

/** 取得するサービス（有効で URL があるもの）。 */
export const activeServices = (services) => services.filter((s) => s.enabled && s.url.trim());
