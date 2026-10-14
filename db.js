// Mnemo — persistance IndexedDB (écritures groupées) et médias
import { S, persist, initCollection, indexCards, DEFAULT_SETTINGS, defaultPreset, invalidateDecks } from './state.js';
import { bumpIdFloor, setRollover } from './util.js';
import { t } from './i18n.js';

const DB_NAME = 'mnemo', VERSION = 1;
const STORES = { notetypes: 'id', decks: 'id', presets: 'id', notes: 'id', cards: 'id', revlog: 'id', media: 'name', kv: 'k' };
let db = null;

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      for (const [name, keyPath] of Object.entries(STORES)) if (!r.result.objectStoreNames.contains(name)) r.result.createObjectStore(name, { keyPath });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
const all = store => new Promise((res, rej) => {
  const r = db.transaction(store).objectStore(store).getAll();
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});

// ---------- écritures groupées ----------
const pending = new Map();
let timer = null, flushing = Promise.resolve();
function queue(store, key, val) {
  if (!pending.has(store)) pending.set(store, new Map());
  pending.get(store).set(key, val);
  if (!timer) timer = setTimeout(flush, 60);
}
export function flush() {
  clearTimeout(timer); timer = null;
  if (!pending.size || !db) return flushing;
  const batch = [...pending.entries()]; pending.clear();
  flushing = flushing.then(() => new Promise((res) => {
    const tx = db.transaction(batch.map(b => b[0]), 'readwrite');
    for (const [store, items] of batch) {
      const os = tx.objectStore(store);
      for (const [key, val] of items) val === null ? os.delete(key) : os.put(structuredCloneSafe(val));
    }
    tx.oncomplete = () => res();
    tx.onerror = tx.onabort = () => { console.error('IDB', tx.error); res(); };
  }));
  return flushing;
}
function structuredCloneSafe(v) { return v; }

persist.put = (store, obj) => queue(store, obj[STORES[store]], obj);
persist.del = (store, key) => queue(store, key, null);
persist.putKV = (k, v) => queue('kv', k, { k, v });

// ---------- chargement ----------
export async function loadAll() {
  db = await open();
  const [nts, decks, presets, notes, cards, revlog, kv] = await Promise.all(['notetypes', 'decks', 'presets', 'notes', 'cards', 'revlog', 'kv'].map(all));
  if (!decks.length && !nts.length) { initCollection(); await flush(); }
  else {
    for (const x of nts) S.notetypes.set(x.id, x);
    for (const x of decks) S.decks.set(x.id, x);
    for (const x of presets) S.presets.set(x.id, { ...defaultPreset(x.id, x.name), ...x });
    for (const x of notes) { S.notes.set(x.id, x); bumpIdFloor(x.id); }
    for (const x of cards) { S.cards.set(x.id, x); bumpIdFloor(x.id); }
    S.revlog = revlog.sort((a, b) => a.id - b.id);
    const kvm = Object.fromEntries(kv.map(x => [x.k, x.v]));
    S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(kvm.settings || {}) };
    S.settings.gestures = { ...DEFAULT_SETTINGS.gestures, ...(kvm.settings?.gestures || {}) };
    S.meta = { nextPos: 1, ...(kvm.meta || {}) };
    if (!S.presets.size) { const p = defaultPreset(); S.presets.set(1, p); persist.put('presets', p); }
    if (!S.decks.has(1)) { const d = { id: 1, name: t('Par défaut'), conf: 1, desc: '', collapsed: false, mod: Date.now() }; S.decks.set(1, d); persist.put('decks', d); }
    for (const x of decks) bumpIdFloor(x.id);
    for (const x of nts) bumpIdFloor(x.id);
  }
  invalidateDecks();
  indexCards();
  setRollover(S.settings.rollover);
}

export async function wipeAll() {
  await flush();
  const tx = db.transaction(Object.keys(STORES), 'readwrite');
  for (const s of Object.keys(STORES)) tx.objectStore(s).clear();
  await new Promise(r => { tx.oncomplete = r; tx.onerror = r; });
  for (const k of ['decks', 'presets', 'notetypes', 'notes', 'cards']) S[k].clear();
  S.revlog = []; S.nc.clear();
  revokeMedia();
}

// ---------- médias ----------
const urlCache = new Map();
export function putMedia(name, blob) {
  urlCache.delete(name);
  return new Promise((res, rej) => {
    const tx = db.transaction('media', 'readwrite');
    tx.objectStore('media').put({ name, blob });
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export function putMediaMany(list) {
  return new Promise((res, rej) => {
    const tx = db.transaction('media', 'readwrite');
    for (const { name, blob } of list) { urlCache.delete(name); tx.objectStore('media').put({ name, blob }); }
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
export function getMedia(name) {
  return new Promise(res => {
    const r = db.transaction('media').objectStore('media').get(name);
    r.onsuccess = () => res(r.result?.blob || null); r.onerror = () => res(null);
  });
}
export function hasMedia(name) {
  return new Promise(res => {
    const r = db.transaction('media').objectStore('media').count(name);
    r.onsuccess = () => res(r.result > 0); r.onerror = () => res(false);
  });
}
export function mediaNames() {
  return new Promise(res => {
    const r = db.transaction('media').objectStore('media').getAllKeys();
    r.onsuccess = () => res(r.result); r.onerror = () => res([]);
  });
}
export function deleteMedia(names) {
  return new Promise(res => {
    const tx = db.transaction('media', 'readwrite');
    for (const n of names) { tx.objectStore('media').delete(n); const u = urlCache.get(n); if (u) URL.revokeObjectURL(u); urlCache.delete(n); }
    tx.oncomplete = () => res(); tx.onerror = () => res();
  });
}
export async function getMediaUrl(name) {
  if (!name) return null;
  if (urlCache.has(name)) return urlCache.get(name);
  let blob = await getMedia(name);
  if (!blob) { try { const d = decodeURIComponent(name); if (d !== name) blob = await getMedia(d); } catch {} }
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  urlCache.set(name, url);
  return url;
}
function revokeMedia() { for (const u of urlCache.values()) URL.revokeObjectURL(u); urlCache.clear(); }

export async function uniqueMediaName(name) {
  const clean = String(name || 'image').replace(/[\\/:*?"<>|#%]+/g, '_').replace(/^\.+/, '') || 'fichier';
  if (!(await hasMedia(clean))) return clean;
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean, ext = dot > 0 ? clean.slice(dot) : '';
  let i = 2; while (await hasMedia(`${base}-${i}${ext}`)) i++;
  return `${base}-${i}${ext}`;
}

export async function storageInfo() {
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  return { usage: est?.usage ?? null, quota: est?.quota ?? null, persisted: !!persisted };
}
export async function requestPersist() { return navigator.storage?.persist ? navigator.storage.persist() : false; }
