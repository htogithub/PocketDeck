// Mnemo — synchronisation entre appareils via un projet Supabase (gratuit).
// Chaque objet (note, carte, paquet…) est une ligne. Le serveur numérote chaque changement (srv_seq),
// on ne récupère donc que ce qui a changé. En cas de conflit, la modification la plus récente gagne.
import { S, persist, invalidateDecks, indexCards, defaultPreset } from './state.js';
import * as DB from './db.js';
import { t } from './i18n.js';

const TABLE = 'mnemo_items', BUCKET = 'mnemo-media';
const KINDS = ['notetypes', 'decks', 'presets', 'notes', 'cards', 'revlog'];
const ORDER = Object.fromEntries([...KINDS, 'media'].map((k, i) => [k, i]));

export const SETUP_SQL = `-- Mnemo : synchronisation. À exécuter une seule fois dans SQL Editor.
create sequence if not exists public.mnemo_seq;

create table if not exists public.mnemo_items (
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  kind text not null,
  id text not null,
  data jsonb,
  deleted boolean not null default false,
  updated_at bigint not null default 0,
  srv_seq bigint not null default nextval('public.mnemo_seq'),
  primary key (user_id, kind, id)
);
create index if not exists mnemo_items_user_seq on public.mnemo_items (user_id, srv_seq);

alter table public.mnemo_items enable row level security;
drop policy if exists "mnemo_own_rows" on public.mnemo_items;
create policy "mnemo_own_rows" on public.mnemo_items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- La version la plus récente gagne ; chaque changement reçoit un nouveau numéro
create or replace function public.mnemo_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;
  end if;
  new.srv_seq := nextval('public.mnemo_seq');
  return new;
end $$;
drop trigger if exists mnemo_touch on public.mnemo_items;
create trigger mnemo_touch before insert or update on public.mnemo_items
  for each row execute function public.mnemo_touch();

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.mnemo_items to authenticated;
grant usage, select on sequence public.mnemo_seq to authenticated;

-- Images et sons
insert into storage.buckets (id, name, public) values ('mnemo-media', 'mnemo-media', false)
  on conflict (id) do nothing;
drop policy if exists "mnemo_media_select" on storage.objects;
drop policy if exists "mnemo_media_insert" on storage.objects;
drop policy if exists "mnemo_media_update" on storage.objects;
drop policy if exists "mnemo_media_delete" on storage.objects;
create policy "mnemo_media_select" on storage.objects for select to authenticated
  using (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mnemo_media_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mnemo_media_update" on storage.objects for update to authenticated
  using (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "mnemo_media_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'mnemo-media' and (storage.foldername(name))[1] = auth.uid()::text);
`;

const st = {
  cfg: null, auth: null, lastSeq: 0, initialDone: false, lastSync: 0,
  dirty: new Map(), pendingMedia: new Map(),
  status: 'off', error: '', progress: '', busy: false, again: false,
};
const listeners = new Set();
export const sync = {
  state: st,
  chooser: null,   // async () => 'merge' | 'cloud' | 'device' | null (défini par l'interface)
  onRemote: null,  // appelé quand des changements distants ont été appliqués
  onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};
const emit = () => { for (const f of listeners) { try { f(st); } catch {} } };
const setStatus = (s, err = '') => { st.status = s; st.error = err; if (s !== 'syncing') st.progress = ''; emit(); };
const progress = msg => { st.progress = msg; emit(); };

export const configured = () => !!(st.cfg?.url && st.cfg?.key);
export const loggedIn = () => configured() && !!st.auth?.access_token;

// ---------- état persistant (local à l'appareil, jamais synchronisé) ----------
let saveTimer = null;
function saveNow() {
  clearTimeout(saveTimer); saveTimer = null;
  persist.putKV('sync', {
    cfg: st.cfg, auth: st.auth, lastSeq: st.lastSeq, initialDone: st.initialDone, lastSync: st.lastSync, firstUpload: st.firstUpload || null,
    dirty: [...st.dirty], pendingMedia: [...st.pendingMedia],
  });
}
const saveSoon = () => { if (!saveTimer) saveTimer = setTimeout(saveNow, 800); };

// ---------- suivi des modifications locales ----------
let applying = false, pushTimer = null;
function mark(kind, id) {
  if (applying || !loggedIn() || !st.initialDone) return;
  st.dirty.set(`${kind}:${id}`, Date.now());
  saveSoon();
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => syncNow(), 4000);
}

export function initSync() {
  const saved = S.kv?.sync || {};
  st.cfg = saved.cfg || null; st.auth = saved.auth || null;
  st.lastSeq = saved.lastSeq || 0; st.initialDone = !!saved.initialDone; st.lastSync = saved.lastSync || 0; st.firstUpload = saved.firstUpload || null;
  st.dirty = new Map(saved.dirty || []); st.pendingMedia = new Map(saved.pendingMedia || []);
  const put = persist.put, del = persist.del;
  persist.put = (store, obj) => { put(store, obj); if (KINDS.includes(store)) mark(store, obj.id); };
  persist.del = (store, key) => { del(store, key); if (KINDS.includes(store)) mark(store, key); };
  raw.put = put; raw.del = del;
  DB.mediaHooks.put = names => { for (const n of names) mark('media', n); };
  setStatus(!configured() ? 'off' : loggedIn() ? 'idle' : 'loggedout');
  window.addEventListener('online', () => syncNow());
  document.addEventListener('visibilitychange', () => { if (loggedIn()) syncNow(); });
  setInterval(() => { if (document.visibilityState === 'visible') syncNow({ quiet: true }); }, 120000);
  if (loggedIn()) setTimeout(() => syncNow(), 600);
}
const raw = { put: null, del: null };

// ---------- HTTP ----------
const base = () => st.cfg.url.trim().replace(/\/+$/, '');
async function errText(res) {
  let j = null; try { j = await res.json(); } catch {}
  return (j && (j.msg || j.message || j.error_description || j.error || j.hint)) || `HTTP ${res.status}`;
}
async function authCall(path, body) {
  let res;
  try {
    res = await fetch(`${base()}/auth/v1/${path}`, { method: 'POST', headers: { apikey: st.cfg.key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error(t('Serveur injoignable. Vérifie l\'URL du projet et ta connexion.')); }
  if (!res.ok) throw new Error(await errText(res));
  return res.json();
}
function setSession(j) {
  st.auth = {
    access_token: j.access_token, refresh_token: j.refresh_token,
    expires_at: j.expires_at || Math.floor(Date.now() / 1000) + (j.expires_in || 3600),
    user: { id: j.user?.id, email: j.user?.email },
  };
  saveNow();
}
let refreshing = null;
function refresh() {
  return refreshing ??= (async () => {
    try { setSession(await authCall('token?grant_type=refresh_token', { refresh_token: st.auth.refresh_token })); }
    catch (e) {
      if (/injoignable|unreachable/i.test(e.message)) throw e;
      st.auth = null; saveNow(); setStatus('loggedout', t('Session expirée : reconnecte-toi.'));
      throw new Error(t('Session expirée : reconnecte-toi.'));
    } finally { refreshing = null; }
  })();
}
// Erreurs passagères (serveur surchargé, trop de connexions…) : on réessaie avec un délai croissant
const TRANSIENT = /too many connections|timeout|timed out|rate limit|too many requests|temporar|try again|overloaded|unavailable/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function api(path, opts = {}, retry = true, attempt = 0) {
  if (!st.auth) throw new Error(t('Non connecté.'));
  if (st.auth.expires_at * 1000 < Date.now() + 60000) await refresh();
  let res;
  try {
    res = await fetch(base() + path, { ...opts, headers: { apikey: st.cfg.key, Authorization: `Bearer ${st.auth.access_token}`, ...(opts.headers || {}) } });
  } catch {
    if (attempt < 2 && navigator.onLine !== false) { await sleep(1500 * (attempt + 1)); return api(path, opts, retry, attempt + 1); }
    throw new Error(navigator.onLine === false ? t('Hors ligne.') : t("Serveur injoignable. Si Mnemo n'a pas été utilisé depuis une semaine, le projet Supabase est en pause : réactive-le depuis supabase.com."));
  }
  if (res.status === 401 && retry) { await refresh(); return api(path, opts, false, attempt); }
  if (!res.ok) {
    const msg = await errText(res);
    if (attempt < 4 && (res.status === 429 || res.status >= 500 || TRANSIENT.test(msg))) {
      await sleep(1000 * 2 ** attempt + Math.random() * 400);
      return api(path, opts, retry, attempt + 1);
    }
    throw new Error(msg);
  }
  return res;
}
const uid = () => st.auth.user.id;
async function sha256(s) {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
}

// ---------- compte ----------
export function setConfig(url, key) {
  url = String(url || '').trim(); key = String(key || '').trim();
  if (!/^https:\/\/[^\s/]+/.test(url)) throw new Error(t('URL invalide : elle commence par https:// et finit par .supabase.co'));
  if (!key) throw new Error(t('Clé manquante.'));
  st.cfg = { url: url.replace(/\/+$/, ''), key };
  st.auth = null; st.initialDone = false; st.lastSeq = 0; st.dirty.clear();
  saveNow(); setStatus('loggedout');
}
export function forgetConfig() {
  st.cfg = null; st.auth = null; st.initialDone = false; st.lastSeq = 0; st.dirty.clear(); st.pendingMedia.clear();
  saveNow(); setStatus('off');
}
function startAccount(j) {
  const prev = st.auth?.user?.id;
  setSession(j);
  if (prev !== st.auth.user.id) { st.initialDone = false; st.lastSeq = 0; st.dirty.clear(); st.pendingMedia.clear(); }
  saveNow(); setStatus('idle');
  return syncNow();
}
export async function signIn(email, password) {
  return startAccount(await authCall('token?grant_type=password', { email: email.trim(), password }));
}
export async function signUp(email, password) {
  const j = await authCall('signup', { email: email.trim(), password });
  if (j.access_token) { await startAccount(j); return 'ok'; }
  return 'confirm';
}
export async function signOut() {
  try { await api('/auth/v1/logout', { method: 'POST' }, false); } catch {}
  st.auth = null; st.initialDone = false; st.lastSeq = 0; st.dirty.clear(); st.pendingMedia.clear();
  saveNow(); setStatus('loggedout');
}

// ---------- application des changements distants ----------
function getLocal(kind, id, revMap) {
  if (kind === 'revlog') return revMap.get(Number(id)) || null;
  return S[kind]?.get(Number(id)) || null;
}
let pulledKeys = null;
function applyRows(rows) {
  let changed = 0, decks = false, rev = false;
  const revMap = new Map(S.revlog.map(l => [l.id, l]));
  const revDel = new Set();
  applying = true;
  try {
    for (const r of rows) {
      const key = `${r.kind}:${r.id}`;
      pulledKeys?.add(key);
      const localTs = st.dirty.get(key);
      if (localTs != null && localTs > r.updated_at) continue;
      if (localTs != null) st.dirty.delete(key);
      if (r.kind === 'media') {
        if (!r.deleted && r.data?.key) st.pendingMedia.set(r.id, r.data);
        continue;
      }
      const id = Number(r.id);
      if (r.kind === 'revlog') {
        if (r.deleted) { if (revMap.has(id)) { revDel.add(id); revMap.delete(id); raw.del('revlog', id); changed++; rev = true; } }
        else if (!revMap.has(id) && r.data) { revMap.set(id, r.data); S.revlog.push(r.data); raw.put('revlog', r.data); changed++; rev = true; }
        continue;
      }
      const map = S[r.kind];
      if (!(map instanceof Map)) continue;
      const cur = map.get(id);
      if (r.deleted || !r.data) {
        if (!cur) continue;
        map.delete(id); raw.del(r.kind, id);
        if (r.kind === 'cards') S.nc.get(cur.nid)?.delete(id);
        if (r.kind === 'decks') decks = true;
        changed++; continue;
      }
      let obj = r.kind === 'presets' ? { ...defaultPreset(r.data.id, r.data.name), ...r.data } : r.data;
      if (cur) { for (const k of Object.keys(cur)) if (!(k in obj)) delete cur[k]; Object.assign(cur, obj); obj = cur; }
      else map.set(id, obj);
      if (r.kind === 'cards') { if (!S.nc.has(obj.nid)) S.nc.set(obj.nid, new Set()); S.nc.get(obj.nid).add(id); }
      if (r.kind === 'decks') decks = true;
      raw.put(r.kind, obj);
      changed++;
    }
  } finally { applying = false; }
  if (revDel.size) S.revlog = S.revlog.filter(l => !revDel.has(l.id));
  if (rev) S.revlog.sort((a, b) => a.id - b.id);
  if (decks) invalidateDecks();
  return changed;
}

async function pull(from = st.lastSeq) {
  let last = from, changed = 0, n = 0;
  for (;;) {
    const res = await api(`/rest/v1/${TABLE}?select=kind,id,data,deleted,updated_at,srv_seq&srv_seq=gt.${last}&order=srv_seq.asc&limit=1000`);
    const rows = await res.json();
    if (!rows.length) break;
    changed += applyRows(rows);
    last = rows[rows.length - 1].srv_seq;
    st.lastSeq = last; n += rows.length;
    if (n > 1000) progress(t('Réception : {n} éléments', { n }));
    saveSoon();
    if (rows.length < 1000) break;
  }
  return changed;
}

// ---------- envoi des changements locaux ----------
const rowsDirty = () => [...st.dirty.keys()].some(k => !k.startsWith('media:'));
const mediaDirty = () => [...st.dirty.keys()].filter(k => k.startsWith('media:')).length;
async function pushRows() {
  if (!rowsDirty()) return 0;
  const revMap = new Map(S.revlog.map(l => [l.id, l]));
  const entries = [...st.dirty.entries()].sort((a, b) => ORDER[a[0].split(':')[0]] - ORDER[b[0].split(':')[0]]);
  const rows = [], media = [];
  for (const [key, ts] of entries) {
    const i = key.indexOf(':'), kind = key.slice(0, i), id = key.slice(i + 1);
    if (kind === 'media') { media.push([key, id, ts]); continue; }
    if (!KINDS.includes(kind)) { st.dirty.delete(key); continue; }
    const obj = getLocal(kind, id, revMap);
    rows.push({ row: { user_id: uid(), kind, id, data: obj, deleted: !obj, updated_at: ts }, key, ts });
  }
  let sent = 0, batch = [], size = 0;
  const flushBatch = async () => {
    if (!batch.length) return;
    await api(`/rest/v1/${TABLE}?on_conflict=user_id,kind,id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(batch.map(b => b.row)),
    });
    for (const b of batch) if (st.dirty.get(b.key) === b.ts) st.dirty.delete(b.key);
    sent += batch.length; batch = []; size = 0;
    if (rows.length > 500) progress(t('Envoi : {a} / {b}', { a: sent, b: rows.length }));
    saveSoon();
  };
  for (const r of rows) {
    const len = JSON.stringify(r.row.data || '').length;
    if (batch.length && (batch.length >= 400 || size + len > 1500000)) await flushBatch();
    batch.push(r); size += len;
  }
  await flushBatch();
  return sent;
}
// Médias envoyés un par un, sans bloquer la synchro des cartes en cas d'échec
async function pushMedia() {
  const media = [...st.dirty.entries()].filter(([key]) => key.startsWith('media:')).map(([key, ts]) => [key, key.slice(6), ts]);
  let k = 0;
  for (const [key, name, ts] of media) {
    k++;
    if (media.length > 3) progress(t('Envoi des médias : {a} / {b}', { a: k, b: media.length }));
    const blob = await DB.getMedia(name);
    const path = `${uid()}/${await sha256(name)}`;
    if (blob) {
      await api(`/storage/v1/object/${BUCKET}/${path}`, { method: 'POST', headers: { 'x-upsert': 'true', 'Content-Type': blob.type || 'application/octet-stream' }, body: blob });
    }
    await api(`/rest/v1/${TABLE}?on_conflict=user_id,kind,id`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify([{ user_id: uid(), kind: 'media', id: name, data: blob ? { key: path, type: blob.type || '', size: blob.size } : null, deleted: !blob, updated_at: ts }]),
    });
    if (st.dirty.get(key) === ts) st.dirty.delete(key);
    saveSoon();
    await sleep(120);
  }
  return media.length;
}

async function downloadMedia() {
  const todo = [...st.pendingMedia.entries()];
  let k = 0;
  const worker = async () => {
    while (todo.length) {
      const [name, info] = todo.shift();
      k++;
      if (!(await DB.hasMedia(name))) {
        const res = await api(`/storage/v1/object/authenticated/${BUCKET}/${info.key}`);
        const blob = await res.blob();
        await DB.putMedia(name, new Blob([blob], { type: info.type || blob.type }), { silent: true });
      }
      st.pendingMedia.delete(name); saveSoon();
      await sleep(80);
      if (k % 5 === 0) progress(t('Téléchargement des médias : {a} restants', { a: todo.length }));
    }
  };
  await worker();
}

async function maxSeq() {
  const rows = await (await api(`/rest/v1/${TABLE}?select=srv_seq&order=srv_seq.desc&limit=1`)).json();
  return rows[0]?.srv_seq || 0;
}
async function markAll(except = null) {
  const now = Date.now();
  const add = key => { if (!except?.has(key)) st.dirty.set(key, now); };
  for (const k of ['notetypes', 'decks', 'presets', 'notes', 'cards']) for (const id of S[k].keys()) add(`${k}:${id}`);
  for (const l of S.revlog) add(`revlog:${l.id}`);
  for (const n of await DB.mediaNames()) add(`media:${n}`);
}

// ---------- première synchro d'un appareil ----------
async function replaceLocal() {
  progress(t('Téléchargement de la collection…'));
  await DB.clearCollectionStores();
  st.dirty.clear(); st.lastSeq = 0;
  await pull(0);
  const now = Date.now();
  if (!S.presets.has(1)) { const p = defaultPreset(); S.presets.set(1, p); raw.put('presets', p); st.dirty.set('presets:1', now); }
  if (!S.decks.has(1)) { const d = { id: 1, name: t('Par défaut'), conf: 1, desc: '', collapsed: false, mod: now }; S.decks.set(1, d); raw.put('decks', d); st.dirty.set('decks:1', now); }
  indexCards(); invalidateDecks();
}
async function merge() {
  progress(t('Fusion avec le cloud…'));
  const pulled = new Set();
  pulledKeys = pulled;
  try { await pull(0); } finally { pulledKeys = null; }
  // Types de notes intégrés en double (créés indépendamment sur chaque appareil) : on garde ceux du cloud
  // et on y rattache les notes locales quand la structure est identique
  const same = (a, b) => a.flds.length === b.flds.length && a.flds.every((f, i) => f.name === b.flds[i].name) && a.tmpls.length === b.tmpls.length;
  for (const nt of [...S.notetypes.values()]) {
    if (!nt.builtin || pulled.has(`notetypes:${nt.id}`)) continue;
    const twin = [...S.notetypes.values()].find(x => x !== nt && x.builtin === nt.builtin && pulled.has(`notetypes:${x.id}`) && same(x, nt));
    if (!twin) continue;
    for (const n of S.notes.values()) if (n.mid === nt.id) { n.mid = twin.id; raw.put('notes', n); }
    S.notetypes.delete(nt.id); raw.del('notetypes', nt.id);
  }
  await markAll(pulled);
  await pushRows();
}
async function replaceCloud() {
  progress(t('Remplacement du cloud…'));
  const revMap = new Map(S.revlog.map(l => [l.id, l]));
  const now = Date.now();
  let last = 0;
  for (;;) {
    const rows = await (await api(`/rest/v1/${TABLE}?select=kind,id,srv_seq&deleted=eq.false&srv_seq=gt.${last}&order=srv_seq.asc&limit=1000`)).json();
    for (const r of rows) {
      const local = r.kind === 'media' ? await DB.hasMedia(r.id) : getLocal(r.kind, r.id, revMap);
      if (!local) st.dirty.set(`${r.kind}:${r.id}`, now);
    }
    if (rows.length < 1000) break;
    last = rows[rows.length - 1].srv_seq;
  }
  await markAll();
  await pushRows();
  st.lastSeq = await maxSeq();
}
async function firstSync() {
  const any = (await (await api(`/rest/v1/${TABLE}?select=id&deleted=eq.false&limit=1`)).json()).length > 0;
  if (!any) {
    progress(t('Premier envoi de la collection…'));
    st.firstUpload = uid();
    await markAll(); await pushRows();
    st.lastSeq = await maxSeq();
  } else if (!S.notes.size) await replaceLocal();
  else if (st.firstUpload === uid()) await merge();
  else {
    const choice = sync.chooser ? await sync.chooser() : 'merge';
    if (!choice) { setStatus('idle', t('Première synchronisation en attente.')); return false; }
    if (choice === 'cloud') await replaceLocal();
    else if (choice === 'device') await replaceCloud();
    else await merge();
  }
  st.initialDone = true;
  return true;
}

// ---------- médias (jamais bloquants) ----------
let mediaRetryAt = 0, mediaError = '';
async function mediaStep(force) {
  if (!mediaDirty() && !st.pendingMedia.size) { mediaError = ''; return; }
  if (!force && mediaError && Date.now() < mediaRetryAt) return;
  let err = '';
  try { await pushMedia(); } catch (e) { err = e.message || String(e); }
  try { if (st.pendingMedia.size) await downloadMedia(); } catch (e) { err ||= e.message || String(e); }
  mediaError = err;
  if (err) { console.warn('media sync', err); mediaRetryAt = Date.now() + 10 * 60000; }
}
function mediaNote() {
  const n = mediaDirty() + st.pendingMedia.size;
  return mediaError && n ? t('Cartes synchronisées. {n} image(s) ou son(s) en attente, nouvel essai plus tard ({e}).', { n, e: mediaError }) : '';
}

// ---------- synchro complète ----------
export async function syncNow({ quiet = false } = {}) {
  if (!loggedIn()) return;
  if (st.busy) { st.again = true; return; }
  if (navigator.onLine === false) { setStatus('offline'); return; }
  if (quiet && !st.dirty.size && Date.now() - st.lastSync < 60000) return;
  st.busy = true; setStatus('syncing');
  let changed = 0, firstDone = true;
  try {
    if (!st.initialDone) { firstDone = await firstSync(); changed = Infinity; }
    if (firstDone) {
      await pushRows();
      changed += await pull();
      if (rowsDirty()) await pushRows();
      st.lastSync = Date.now();
      await mediaStep(!quiet);
      setStatus('idle', mediaNote());
    }
  } catch (e) {
    console.error('sync', e);
    if (st.status !== 'loggedout') setStatus(navigator.onLine === false ? 'offline' : 'error', e.message || String(e));
  } finally {
    st.busy = false; saveNow(); await DB.flush();
    if (changed) sync.onRemote?.(changed);
    if (st.again) { st.again = false; setTimeout(() => syncNow(), 300); }
  }
}
export async function resetFrom(source) {
  if (!loggedIn() || st.busy) return;
  st.busy = true; setStatus('syncing');
  try {
    if (source === 'cloud') await replaceLocal(); else await replaceCloud();
    st.initialDone = true;
    await pull();
    st.lastSync = Date.now();
    await mediaStep(true);
    setStatus('idle', mediaNote());
  } catch (e) { setStatus('error', e.message || String(e)); }
  finally { st.busy = false; saveNow(); await DB.flush(); sync.onRemote?.(Infinity); }
}
