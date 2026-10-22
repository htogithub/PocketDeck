// Mnemo — utilitaires partagés (DOM, texte, dates, chargement des bibliothèques)
import { t, getLang, locale } from './i18n.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) append(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

const ICONS = {
  decks: '<rect x="3.5" y="7.5" width="13" height="13" rx="2.5"/><path d="M8 4h10a2.5 2.5 0 0 1 2.5 2.5V16"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  stats: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
  settings: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  edit: '<path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  flag: '<path d="M5 21V4M5 4h12l-2.5 4.5L17 13H5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  caret: '<path d="m6 9 6 6 6-6"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="m20 17-5-5-8 7.5"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4"/>',
  sigma: '<path d="M17 5H7l6 7-6 7h10"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4.2l2 2.3h6.8a2 2 0 0 1 2 2v7.7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  cloud: '<path d="M7 18.5h10a4 4 0 0 0 .7-7.94 6 6 0 0 0-11.5-1.4A4.5 4.5 0 0 0 7 18.5z"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4h-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.6V14M12 17.2v.1"/>',
};
export function ic(name, size = 22) {
  const span = document.createElement('span');
  span.className = 'ic';
  span.innerHTML = `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  return span;
}

// ---------- identifiants ----------
let lastId = 0;
export function newId() {
  let t = Date.now();
  if (t <= lastId) t = lastId + 1;
  lastId = t;
  return t;
}
export function bumpIdFloor(id) { if (id > lastId) lastId = id; }
const GUID_CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
export function guid() {
  const a = crypto.getRandomValues(new Uint8Array(10));
  let s = '';
  for (const x of a) s += GUID_CHARS[x % GUID_CHARS.length];
  return s;
}

// ---------- texte ----------
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", shy: '' };
export function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 ? String.fromCodePoint(n) : m;
    }
    const v = ENT[e.toLowerCase()];
    return v ?? m;
  });
}
export function stripHtml(s) {
  return decodeEntities(String(s ?? '')
    .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/\[sound:[^\]]*\]/g, ''))
    .replace(/\s+/g, ' ').trim();
}
export function textToHtml(t) { return esc(t).replace(/\r?\n/g, '<br>'); }
export function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ---------- dates (le jour commence à l'heure de bascule) ----------
let ROLLOVER = 4;
export function setRollover(hh) { ROLLOVER = Math.max(0, Math.min(23, +hh || 0)); }
export function dayNumber(ts = Date.now()) {
  const d = new Date(ts - ROLLOVER * 3600e3);
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5);
}
export function dayStart(day) {
  const d = new Date(day * 864e5);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), ROLLOVER).getTime();
}
export const today = () => dayNumber();
export function dayLabel(day, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  const d = new Date(day * 864e5);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12).toLocaleDateString(locale(), opts);
}
export function dateTime(ts) {
  return new Date(ts).toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const r1 = x => { const r = Math.round(x * 10) / 10; const s = Number.isInteger(r) ? String(r) : r.toFixed(1); return getLang() === 'en' ? s : s.replace('.', ','); };
export function fmtIvl(days) {
  const en = getLang() === 'en';
  const m = days * 1440;
  if (m < 1) return '<1 min';
  if (m < 59.5) return Math.round(m) + ' min';
  if (m < 1440) return r1(m / 60) + ' h';
  if (days < 30) return Math.round(days) + (en ? ' d' : ' j');
  if (days < 365) return r1(days / 30.44) + (en ? ' mo' : ' mois');
  const y = days / 365.25;
  return r1(y) + (en ? ' y' : y >= 2 ? ' ans' : ' an');
}
export function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' s';
  const m = Math.round(s / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + String(m % 60).padStart(2, '0');
}

// ---------- hasard déterministe ----------
export function hash32(...xs) {
  let hh = 2166136261;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) { hh ^= s.charCodeAt(i); hh = Math.imul(hh, 16777619); }
    hh ^= 0x2c; hh = Math.imul(hh, 16777619);
  }
  return hh >>> 0;
}
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(arr, rand = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}

// ---------- bibliothèques externes (chargées à la demande, mises en cache hors ligne) ----------
export const CDN = {
  jszip: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  sqljs: 'https://cdn.jsdelivr.net/npm/sql.js@1.10.2/dist/',
  katex: 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/',
  fzstd: 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js',
};
const loading = {};
export function loadScript(src) {
  return loading[src] ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.crossOrigin = 'anonymous';
    s.onload = res;
    s.onerror = () => { delete loading[src]; rej(new Error(t('Bibliothèque introuvable (hors ligne ?) : ') + src.split('/npm/')[1])); };
    document.head.append(s);
  });
}
export async function getJSZip() {
  if (!globalThis.JSZip) await loadScript(CDN.jszip);
  return globalThis.JSZip;
}
let sqlPromise = null;
export function getSQL() {
  return sqlPromise ??= (async () => {
    if (!globalThis.initSqlJs) await loadScript(CDN.sqljs + 'sql-wasm.js');
    return globalThis.initSqlJs({ locateFile: f => CDN.sqljs + f });
  })().catch(e => { sqlPromise = null; throw e; });
}
export async function getZstd() {
  if (!globalThis.fzstd) await loadScript(CDN.fzstd);
  return globalThis.fzstd;
}
let katexPromise = null;
export function getKatex() {
  return katexPromise ??= (async () => {
    if (!document.querySelector('link[data-katex]')) {
      document.head.append(h('link', { rel: 'stylesheet', href: CDN.katex + 'katex.min.css', 'data-katex': '1', crossorigin: 'anonymous' }));
    }
    if (!globalThis.katex) await loadScript(CDN.katex + 'katex.min.js');
    if (!globalThis.renderMathInElement) await loadScript(CDN.katex + 'contrib/auto-render.min.js');
    return globalThis.katex;
  })().catch(e => { katexPromise = null; throw e; });
}

// ---------- fichiers ----------
export function readFileAsText(file) { return file.text(); }
export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
export async function saveFile(blob, name) {
  const file = new File([blob], name, { type: blob.type || 'application/octet-stream' });
  if (isStandalone() && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name, style: 'display:none' });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let el = document.getElementById('toast');
  if (!el) { el = h('div', { id: 'toast', role: 'status' }); document.body.append(el); }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

export function debounce(fn, ms = 250) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export async function sha1Hex(str) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
