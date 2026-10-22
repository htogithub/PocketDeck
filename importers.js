// Mnemo — importation : .apkg/.colpkg, CSV/TSV/TXT, JSON, CrowdAnki, Markdown, HTML, GIFT, Aiken, sauvegardes
import { S, persist, newNote, addNote, updateNote, deckByName, notetypeOf, uniqueNotetypeName, saveNotetype, addCardObj, genCards,
  builtinNotetypes, saveMeta, invalidateDecks, indexCards, defaultPreset, DEFAULT_SETTINGS } from './state.js';
import { newId, guid, dayNumber, dayStart, stripHtml, textToHtml, esc, getJSZip, getSQL, getZstd, bumpIdFloor, setRollover } from './util.js';
import { t, getLang } from './i18n.js';

// ---------- outils binaires ----------
const isZstd = b => b && b.length > 4 && b[0] === 0x28 && b[1] === 0xB5 && b[2] === 0x2F && b[3] === 0xFD;
function varint(buf, i) {
  let v = 0, mul = 1, b;
  do { b = buf[i++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80 && i < buf.length);
  return [v, i];
}
export function pbDecode(buf) {
  const out = {}; let i = 0;
  buf = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []);
  while (i < buf.length) {
    let key; [key, i] = varint(buf, i);
    const field = Math.floor(key / 8), wt = key % 8;
    let val;
    if (wt === 0) [val, i] = varint(buf, i);
    else if (wt === 2) { let len; [len, i] = varint(buf, i); val = buf.subarray(i, i + len); i += len; }
    else if (wt === 1) { val = buf.subarray(i, i + 8); i += 8; }
    else if (wt === 5) { val = buf.subarray(i, i + 4); i += 4; }
    else break;
    (out[field] ||= []).push(val);
  }
  return out;
}
const pbStr = b => b ? new TextDecoder().decode(b) : '';
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', opus: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', css: 'text/css', js: 'text/javascript' };
export const mimeOf = name => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

function rowsOf(db, sql) {
  const r = db.exec(sql);
  if (!r.length) return [];
  const { columns, values } = r[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

// ---------- .apkg / .colpkg ----------
const MARK_RE = /\/\*mnemo:([A-Za-z0-9+/=]+)\*\//;
export function decodeMarker(css) {
  const m = (css || '').match(MARK_RE);
  if (!m) return null;
  try { return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1]), c => c.charCodeAt(0)))); } catch { return null; }
}
function ntFrom(id, name, type, flds, tmpls, css, sortf, mod) {
  const extra = decodeMarker(css);
  const nt = {
    id: +id, name: name || t('Type importé'), kind: type === 1 ? 'cloze' : 'std',
    flds: flds.map((f, i) => ({ name: f, ord: i })),
    tmpls: tmpls.map((x, i) => ({ name: x.name || t('Carte {n}', { n: i + 1 }), ord: i, qfmt: x.qfmt || '', afmt: x.afmt || '' })),
    css: (css || '').replace(MARK_RE, '').trim(), sortf: sortf || 0, mod: (mod || 0) * 1000,
  };
  if (extra?.kind) Object.assign(nt, { kind: extra.kind, tmpls: extra.tmpls || nt.tmpls }, extra.mcq ? { mcq: extra.mcq } : {}, extra.tf ? { tf: extra.tf } : {});
  return nt;
}

// Lecture tolérante : on lit toutes les colonnes présentes (SELECT *) et on complète celles qui manquent,
// car certains générateurs d'.apkg produisent des tables incomplètes.
export function readCollectionDb(db) {
  const tables = new Set(rowsOf(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
  const all = (tbl, order = '') => {
    if (!tables.has(tbl)) return [];
    try { return rowsOf(db, `SELECT * FROM "${tbl}"${order}`); } catch { return []; }
  };
  const parse = s => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
  if (!tables.has('notes')) throw new Error(t('Collection Anki vide ou illisible.'));
  const col = all('col')[0] || {};
  const crt = Number(col.crt) > 0 ? Number(col.crt) : Math.floor(Date.now() / 1000);
  const crtDay = dayNumber(crt * 1000 + 12 * 3600e3);
  const modern = tables.has('notetypes');
  const notetypes = [], decks = [];
  const filtered = new Set();
  if (modern) {
    const flds = all('fields', ' ORDER BY ntid, ord');
    const tmpls = all('templates', ' ORDER BY ntid, ord');
    for (const r of all('notetypes')) {
      const c = pbDecode(r.config);
      notetypes.push(ntFrom(r.id, r.name, Number(c[1]?.[0] ?? 0), flds.filter(f => f.ntid === r.id).map(f => f.name),
        tmpls.filter(x => x.ntid === r.id).map(x => { const tc = pbDecode(x.config); return { name: x.name, qfmt: pbStr(tc[1]?.[0]), afmt: pbStr(tc[2]?.[0]) }; }),
        pbStr(c[3]?.[0]), Number(c[2]?.[0] ?? 0), r.mtime_secs));
    }
    for (const r of all('decks')) {
      if (pbDecode(r.kind)[2]) { filtered.add(r.id); continue; }
      decks.push({ id: r.id, name: String(r.name ?? '').replace(/\x1f/g, '::') || t('Paquet importé') });
    }
  }
  if (!notetypes.length) {
    for (const m of Object.values(parse(col.models))) {
      if (!m || typeof m !== 'object') continue;
      const flds = (m.flds || []).slice().sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0)).map((f, i) => f.name || t('Champ {n}', { n: i + 1 }));
      const tm = (m.tmpls || []).slice().sort((a, b) => (a.ord ?? 0) - (b.ord ?? 0));
      notetypes.push(ntFrom(m.id, m.name, m.type, flds, tm, m.css, m.sortf, m.mod));
    }
  }
  if (!decks.length) {
    for (const d of Object.values(parse(col.decks))) {
      if (!d || typeof d !== 'object') continue;
      if (d.dyn) { filtered.add(+d.id); continue; }
      decks.push({ id: +d.id, name: d.name || t('Paquet importé') });
    }
  }
  const notes = all('notes').map(n => ({
    id: n.id, guid: n.guid || guid(), mid: n.mid, flds: String(n.flds ?? '').split('\x1f'),
    tags: String(n.tags || '').trim().split(/\s+/).filter(Boolean), mod: (n.mod || 0) * 1000,
  }));
  // Notes dont le type est absent : on crée un type générique pour ne rien perdre
  const known = new Set(notetypes.map(n => n.id));
  const orphans = new Map();
  for (const n of notes) if (!known.has(n.mid)) orphans.set(n.mid, Math.max(orphans.get(n.mid) || 1, n.flds.length));
  for (const [mid, nf] of orphans) {
    const names = Array.from({ length: nf }, (_, i) => t('Champ {n}', { n: i + 1 }));
    const back = names.slice(1).map(x => `{{${x}}}`).join('<br>');
    notetypes.push(ntFrom(mid, t('Type importé'), 0, names, [{ name: t('Carte {n}', { n: 1 }), qfmt: `{{${names[0]}}}`, afmt: `{{FrontSide}}\n\n<hr id=answer>\n\n${back}` }], '.card { font-family: var(--card-font); font-size: var(--card-size); text-align: var(--card-align); }', 0, 0));
  }
  const revlog = all('revlog').map(l => ({
    id: l.id, cid: l.cid, ease: l.ease ?? l.button_chosen ?? l.button ?? null, ivl: l.ivl ?? 0, lastIvl: l.lastIvl ?? l.lastivl ?? l.last_interval ?? 0,
    factor: l.factor ?? 0, time: l.time ?? l.taken_millis ?? 0, type: l.type ?? l.kind ?? 1,
  })).filter(l => l.id != null && l.cid != null && l.ease != null);
  const lastRev = new Map();
  for (const l of revlog) if (l.ease >= 1 && (lastRev.get(l.cid) ?? 0) < l.id) lastRev.set(l.cid, l.id);
  const dp = defaultPreset();
  const cards = all('cards').filter(c => c.id != null && c.nid != null).map(c => {
    let did = c.did ?? decks[0]?.id ?? 1, due = Number(c.due) || 0;
    if (c.odid) { did = c.odid; due = Number(c.odue) || 0; }
    const type = [0, 1, 2, 3].includes(c.type) ? c.type : 0;
    const learnTs = (type === 1 || type === 3) && due > 1e9;
    const nd = type === 0 ? due : learnTs ? due * 1000 : crtDay + due;
    const queue = c.queue === -1 ? -1 : type === 0 ? 0 : type === 2 ? 2 : learnTs ? 1 : 3;
    let data = {};
    try { data = c.data ? JSON.parse(c.data) : {}; } catch {}
    const steps = type === 3 ? dp.relearnSteps : dp.learnSteps;
    const remaining = (c.left || 0) % 1000;
    const ivl = Math.max(0, c.ivl || 0);
    return {
      id: c.id, nid: c.nid, did, ord: c.ord || 0, type, queue, due: nd, ivl, factor: c.factor || 0,
      reps: c.reps || 0, lapses: c.lapses || 0, step: Math.max(0, Math.min(steps.length - 1, steps.length - remaining)),
      flags: (c.flags || 0) & 7, s: Number.isFinite(data.s) ? data.s : null, d: Number.isFinite(data.d) ? data.d : null,
      lastRev: lastRev.get(c.id) ?? (type === 2 ? dayStart(nd - ivl) : null), mod: (c.mod || 0) * 1000,
    };
  });
  return { notetypes, decks, notes, cards, revlog, filtered };
}

export async function readApkg(file, progress = () => {}) {
  const JSZip = await getJSZip();
  progress(t('Lecture de l\'archive…'));
  const zip = await JSZip.loadAsync(file);
  const colName = ['collection.anki21b', 'collection.anki21', 'collection.anki2'].find(n => zip.file(n));
  if (!colName) throw new Error(t('Archive invalide : aucune collection Anki trouvée.'));
  let bytes = await zip.file(colName).async('uint8array');
  if (isZstd(bytes)) { progress(t('Décompression…')); bytes = (await getZstd()).decompress(bytes); }
  progress(t('Ouverture de la base Anki…'));
  const SQL = await getSQL();
  const db = new SQL.Database(bytes);
  let frag;
  try { frag = readCollectionDb(db); } finally { db.close(); }
  frag.defaultDeckName = String(file?.name || '').replace(/\.[^.]+$/, '') || null;
  frag.media = await apkgMediaEntries(zip);
  frag.loadMedia = async (name, zipName) => {
    const f = zip.file(zipName); if (!f) return null;
    let data = await f.async('uint8array');
    if (isZstd(data)) data = (await getZstd()).decompress(data);
    return new Blob([data], { type: mimeOf(name) });
  };
  return frag;
}
async function apkgMediaEntries(zip) {
  const mf = zip.file('media');
  if (!mf) return [];
  let raw = await mf.async('uint8array');
  try {
    const j = JSON.parse(new TextDecoder().decode(raw));
    return Object.entries(j).map(([zipName, name]) => ({ zipName, name }));
  } catch {}
  if (isZstd(raw)) raw = (await getZstd()).decompress(raw);
  return (pbDecode(raw)[1] || []).map((b, i) => {
    const e = pbDecode(b);
    return { zipName: String(e[255]?.[0] ?? i), name: pbStr(e[1]?.[0]) };
  }).filter(e => e.name);
}

// ---------- fusion d'un fragment de collection ----------
const fit = (arr, n) => { const a = arr.slice(0, n); while (a.length < n) a.push(''); if (arr.length > n) a[n - 1] += arr.slice(n).filter(Boolean).map(x => '<br>' + x).join(''); return a; };

export async function mergeFragment(frag, { keepSched = true, dup = 'update', progress = () => {} } = {}) {
  const res = { notesAdded: 0, notesUpdated: 0, notesSkipped: 0, cardsAdded: 0, media: 0 };
  const ntMap = new Map();
  const same = (x, nt) => x && x.kind === nt.kind && x.flds.length === nt.flds.length && x.flds.every((f, i) => f.name === nt.flds[i].name);
  for (const nt of frag.notetypes) {
    const local = S.notetypes.get(nt.id);
    if (same(local, nt)) { ntMap.set(nt.id, local.id); continue; }
    const byName = [...S.notetypes.values()].find(x => x.name === nt.name && same(x, nt));
    if (byName) { ntMap.set(nt.id, byName.id); continue; }
    const copy = { ...structuredClone(nt), id: (!nt.id || S.notetypes.has(nt.id)) ? newId() : nt.id, name: uniqueNotetypeName(nt.name) };
    bumpIdFloor(copy.id);
    S.notetypes.set(copy.id, copy); saveNotetype(copy); ntMap.set(nt.id, copy.id);
  }
  const dMap = new Map();
  // On ne crée que les paquets réellement utilisés (et leurs parents) ; le paquet 1 d'Anki devient notre paquet par défaut
  const used = new Set([...(frag.cards || []).map(c => c.did), ...frag.notes.map(n => n.did).filter(x => x != null)]);
  for (const d of frag.decks) {
    if (!used.has(d.id) && !d.folder) continue;
    const id = +d.id === 1 && S.decks.has(1) ? 1 : deckByName(d.name); dMap.set(d.id, id);
    if (d.folder) { const x = S.decks.get(id); if (!x.folder) { x.folder = true; persist.put('decks', x); } }
  }
  const fallbackDeck = frag.decks.length ? dMap.get(frag.decks[0].id) : frag.defaultDeckName ? deckByName(frag.defaultDeckName) : (frag.defaultDeck ?? 1);
  const deckFor = did => dMap.get(did) ?? fallbackDeck ?? 1;
  const byGuid = new Map(); for (const n of S.notes.values()) byGuid.set(n.guid, n);
  const cardsOf = new Map();
  for (const c of frag.cards || []) { if (!cardsOf.has(c.nid)) cardsOf.set(c.nid, []); cardsOf.get(c.nid).push(c); }
  const cidMap = new Map();
  const posBase = S.meta.nextPos; let posMax = posBase;
  let i = 0;
  for (const n of frag.notes) {
    if (++i % 500 === 0) { progress(t('Notes : {a} / {b}', { a: i, b: frag.notes.length })); await new Promise(r => setTimeout(r)); }
    const mid = ntMap.get(n.mid); if (mid == null) continue;
    const nt = S.notetypes.get(mid);
    const existing = byGuid.get(n.guid);
    if (existing && dup !== 'new') {
      if (dup === 'update' && existing.mid === mid && (n.mod || 0) >= (existing.mod || 0) - 1000 && existing.flds.join('\x1f') !== fit(n.flds, nt.flds.length).join('\x1f')) {
        existing.flds = fit(n.flds, nt.flds.length);
        existing.tags = [...new Set([...existing.tags, ...n.tags])];
        updateNote(existing); res.notesUpdated++;
      } else res.notesSkipped++;
      continue;
    }
    const note = { id: S.notes.has(n.id) || !n.id ? newId() : n.id, guid: existing ? guid() : (n.guid || guid()), mid, flds: fit(n.flds, nt.flds.length), tags: n.tags.slice(), mod: n.mod || Date.now() };
    bumpIdFloor(note.id);
    S.notes.set(note.id, note); persist.put('notes', note); byGuid.set(note.guid, note); res.notesAdded++;
    const cs = cardsOf.get(n.id) || [];
    for (const c of cs) {
      const card = { ...c, id: S.cards.has(c.id) || !c.id ? newId() : c.id, nid: note.id, did: deckFor(c.did) };
      bumpIdFloor(card.id);
      if (!keepSched) Object.assign(card, { type: 0, queue: 0, due: posBase + (c.type === 0 ? c.due : 0), ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0, s: null, d: null, lastRev: null, flags: 0 });
      else if (card.type === 0) card.due = posBase + (c.due || 0);
      if (card.type === 0) posMax = Math.max(posMax, card.due + 1);
      addCardObj(card); cidMap.set(c.id, card.id); res.cardsAdded++;
    }
    S.meta.nextPos = Math.max(S.meta.nextPos, posMax);
    if (!cs.length) res.cardsAdded += genCards(note, deckFor(n.did ?? null));
  }
  if (keepSched && frag.revlog?.length) {
    const ids = new Set(S.revlog.map(l => l.id));
    for (const l of frag.revlog) {
      const cid = cidMap.get(l.cid); if (cid == null) continue;
      const e = { id: l.id, cid, ease: l.ease, ivl: l.ivl, lastIvl: l.lastIvl, factor: l.factor, time: l.time, type: l.type };
      while (ids.has(e.id)) e.id++;
      ids.add(e.id); S.revlog.push(e); persist.put('revlog', e);
    }
    S.revlog.sort((a, b) => a.id - b.id);
  }
  saveMeta();
  if (frag.media?.length && frag.loadMedia) {
    const { putMediaMany } = await import('./db.js');
    let batch = [];
    for (let k = 0; k < frag.media.length; k++) {
      const e = frag.media[k];
      const blob = await frag.loadMedia(e.name, e.zipName);
      if (blob) { batch.push({ name: e.name, blob }); res.media++; }
      if (batch.length >= 40 || k === frag.media.length - 1) {
        progress(t('Médias : {a} / {b}', { a: k + 1, b: frag.media.length }));
        if (batch.length) await putMediaMany(batch);
        batch = [];
      }
    }
  }
  return res;
}

// ---------- texte délimité (CSV, TSV, export texte d'Anki) ----------
const SEP_NAMES = { comma: ',', semicolon: ';', tab: '\t', space: ' ', pipe: '|', colon: ':' };
export function parseDelimited(text, d) {
  const rows = []; let row = [], cell = '', i = 0, q = false, quotedCell = false;
  while (i < text.length) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
      cell += ch; i++; continue;
    }
    if (ch === '"' && cell === '' && !quotedCell) { q = true; quotedCell = true; i++; continue; }
    if (ch === d) { row.push(cell); cell = ''; quotedCell = false; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; quotedCell = false; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
function sniff(lines) {
  let best = '\t', score = -1;
  for (const d of ['\t', ';', ',', '|']) {
    const counts = lines.slice(0, 20).map(l => parseDelimited(l, d)[0]?.length || 1);
    if (!counts.length) continue;
    const min = Math.min(...counts);
    const consistent = counts.filter(c => c === counts[0]).length / counts.length;
    const s = (min - 1) * 10 + consistent * 5 + (d === '\t' ? 0.5 : 0);
    if (min > 1 && s > score) { score = s; best = d; }
  }
  return best;
}
export function analyzeDelimited(text, forcedDelim = null) {
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/);
  const meta = {}; let start = 0;
  for (; start < lines.length; start++) {
    const m = lines[start].match(/^#([a-z ]+):(.*)$/i);
    if (!m) break;
    meta[m[1].trim().toLowerCase()] = m[2].trim();
  }
  const body = lines.slice(start).join('\n');
  let delim = forcedDelim;
  if (!delim && meta.separator) delim = SEP_NAMES[meta.separator.toLowerCase()] || meta.separator[0];
  if (!delim) delim = sniff(lines.slice(start).filter(l => l.trim()));
  const rows = parseDelimited(body, delim);
  const html = meta.html ? meta.html.toLowerCase() === 'true' : rows.slice(0, 50).some(r => r.some(c => /<\/?[a-z][\s\S]*?>|&[a-z]+;/i.test(c)));
  let header = meta.columns ? parseDelimited(meta.columns, delim)[0] : null;
  const col = k => meta[k] ? Math.max(0, +meta[k] - 1) : -1;
  return { delim, rows, header, html, meta, notetypeName: meta.notetype || null, deckName: meta.deck || null,
    tags: (meta.tags || '').split(/\s+/).filter(Boolean), tagsCol: col('tags column'), deckCol: col('deck column'), guidCol: col('guid column'), notetypeCol: col('notetype column') };
}

const SYN = {
  0: ['front', 'recto', 'question', 'q', 'term', 'terme', 'word', 'mot', 'vorderseite', 'frage', 'affirmation', 'statement', 'texte', 'text', 'prompt'],
  1: ['back', 'verso', 'answer', 'réponse', 'reponse', 'a', 'definition', 'définition', 'rückseite', 'antwort', 'meaning', 'sens', 'traduction', 'translation'],
  choices: ['choix', 'choices', 'options', 'propositions', 'answers', 'alternatives'],
  correct: ['réponse', 'reponse', 'correct', 'correct_answer', 'correctanswer', 'solution', 'answer', 'bonne réponse', 'key', 'truth', 'vrai'],
  expl: ['explication', 'explanation', 'remarques', 'notes', 'extra', 'feedback', 'commentaire', 'erklärung'],
  tags: ['tags', 'étiquettes', 'etiquettes', 'tag'], deck: ['deck', 'paquet', 'category', 'catégorie'],
};
const norm = s => String(s || '').toLowerCase().trim();
export function findBuiltin(key) {
  return [...S.notetypes.values()].find(n => n.builtin === key) || null;
}
export function guessNotetype(header) {
  const h = (header || []).map(norm);
  if (h.some(x => SYN.choices.includes(x))) return findBuiltin('mcq');
  if (h.some(x => ['affirmation', 'statement', 'true', 'vrai'].includes(x))) return findBuiltin('tf');
  return null;
}
export function guessMapping(header, nt, nCols) {
  const h = (header || []).map(norm);
  const used = new Set();
  const take = list => { const i = h.findIndex((x, k) => !used.has(k) && list.includes(x)); if (i >= 0) used.add(i); return i; };
  const map = nt.flds.map(() => -1);
  nt.flds.forEach((f, i) => { const k = h.indexOf(norm(f.name)); if (k >= 0 && !used.has(k)) { map[i] = k; used.add(k); } });
  if (header) {
    nt.flds.forEach((f, i) => {
      if (map[i] >= 0) return;
      const n = norm(f.name);
      if (nt.mcq && n === norm(nt.mcq.choices)) map[i] = take(SYN.choices);
      else if ((nt.mcq && n === norm(nt.mcq.answer)) || (nt.tf && n === norm(nt.tf.answer))) map[i] = take(SYN.correct);
      else if (SYN.expl.includes(n)) map[i] = take(SYN.expl);
      else if (i === 0) map[i] = take(SYN[0]);
      else if (i === 1) map[i] = take(SYN[1]);
    });
  }
  let next = 0;
  const tagsCol = header ? take(SYN.tags) : -1, deckCol = header ? take(SYN.deck) : -1;
  if (!header) nt.flds.forEach((f, i) => { while (used.has(next)) next++; if (map[i] < 0 && next < nCols) { map[i] = next; used.add(next++); } });
  return { map, tagsCol, deckCol };
}

export function importRows(rows, { mid, did, map, tagsCol = -1, deckCol = -1, guidCol = -1, html = true, tags = [], dup = 'update' }) {
  const nt = S.notetypes.get(mid);
  const res = { notesAdded: 0, notesUpdated: 0, notesSkipped: 0, cardsAdded: 0, empty: 0 };
  const key = n => n.mid + '\x1f' + stripHtml(n.flds[0] || '').toLowerCase();
  const byKey = new Map(), byGuid = new Map();
  for (const n of S.notes.values()) { if (n.mid === mid) byKey.set(key(n), n); byGuid.set(n.guid, n); }
  const choicesIdx = nt.mcq ? nt.flds.findIndex(f => f.name === nt.mcq.choices) : -1;
  for (const row of rows) {
    let flds = nt.flds.map((f, i) => {
      const c = map[i]; let v = c >= 0 ? (row[c] ?? '') : '';
      if (i === choicesIdx && !/<br|\n/i.test(v) && v.includes('|')) v = v.split('|').map(s => s.trim()).join('\n');
      return html ? v.replace(/\r?\n/g, '<br>') : textToHtml(v);
    });
    if (!flds.some(v => stripHtml(v))) { res.empty++; continue; }
    const rowTags = [...tags, ...(tagsCol >= 0 ? String(row[tagsCol] || '').split(/\s+/).filter(Boolean) : [])];
    const deck = deckCol >= 0 && row[deckCol]?.trim() ? deckByName(row[deckCol]) : did;
    const g = guidCol >= 0 ? row[guidCol] : null;
    const note = newNote(mid, flds, [...new Set(rowTags)]);
    if (g) note.guid = g;
    const existing = (g && byGuid.get(g)) || (dup !== 'allow' ? byKey.get(key(note)) : null);
    if (existing && dup !== 'allow') {
      if (dup === 'update' && existing.mid === mid) {
        if (existing.flds.join('\x1f') !== flds.join('\x1f')) { existing.flds = flds; existing.tags = [...new Set([...existing.tags, ...note.tags])]; res.cardsAdded += updateNote(existing); res.notesUpdated++; }
        else res.notesSkipped++;
      } else res.notesSkipped++;
      continue;
    }
    const n = addNote(note, deck);
    if (!n) { S.notes.delete(note.id); persist.del('notes', note.id); res.empty++; continue; }
    byKey.set(key(note), note); byGuid.set(note.guid, note);
    res.notesAdded++; res.cardsAdded += n;
  }
  return res;
}

// Export texte d'Anki avec colonne « type de note » : chaque ligne utilise son propre type
export function importAnkiText(a, { did, dup = 'update', tags = [] }) {
  const res = { notesAdded: 0, notesUpdated: 0, notesSkipped: 0, cardsAdded: 0, empty: 0 };
  const special = new Set([a.notetypeCol, a.deckCol, a.tagsCol, a.guidCol].filter(i => i >= 0));
  const groups = new Map();
  for (const row of a.rows) {
    const name = row[a.notetypeCol];
    const nt = [...S.notetypes.values()].find(n => n.name === name) || findBuiltin('basic') || ensureBuiltin('basic');
    if (!groups.has(nt.id)) groups.set(nt.id, []);
    groups.get(nt.id).push(row);
  }
  for (const [mid, rows] of groups) {
    const nt = S.notetypes.get(mid);
    const cols = []; for (let i = 0; i < (rows[0]?.length || 0) + 8; i++) if (!special.has(i)) cols.push(i);
    const r = importRows(rows, { mid, did, map: nt.flds.map((_, i) => cols[i] ?? -1), tagsCol: a.tagsCol, deckCol: a.deckCol, guidCol: a.guidCol, html: a.html, tags, dup });
    for (const k in res) res[k] += r[k] || 0;
  }
  return res;
}

// ---------- notes « simples » (Markdown, GIFT, Aiken…) ----------
export function ensureBuiltin(key) {
  let nt = findBuiltin(key);
  if (!nt) {
    nt = builtinNotetypes(getLang()).find(n => n.builtin === key);
    nt.name = uniqueNotetypeName(nt.name);
    S.notetypes.set(nt.id, nt); saveNotetype(nt);
  }
  return nt;
}
export function importSimple(list, { did, tags = [], dup = 'update' }) {
  const base = S.decks.get(did)?.name || '';
  const res = { notesAdded: 0, notesUpdated: 0, notesSkipped: 0, cardsAdded: 0, empty: 0 };
  const groups = new Map();
  for (const s of list) {
    let nt, flds;
    if (s.type === 'basic' || s.type === 'reversed') { nt = ensureBuiltin(s.type === 'basic' ? 'basic' : 'reversed'); flds = [s.front, s.back]; }
    else if (s.type === 'cloze') { nt = ensureBuiltin('cloze'); flds = [s.text, s.extra || '']; }
    else if (s.type === 'mcq') {
      nt = ensureBuiltin('mcq');
      flds = [s.question, s.choices.join('<br>'), s.correct.map(i => String.fromCharCode(65 + i)).join(','), s.expl || ''];
    } else if (s.type === 'tf') { nt = ensureBuiltin('tf'); flds = [s.statement, t(s.answer ? 'Vrai' : 'Faux'), s.expl || '']; }
    else continue;
    if (!groups.has(nt.id)) groups.set(nt.id, []);
    groups.get(nt.id).push([...flds, (s.tags || []).join(' '), s.deck ? (base ? base + '::' + s.deck : s.deck) : '']);
  }
  for (const [mid, rows] of groups) {
    const nt = S.notetypes.get(mid); const n = nt.flds.length;
    const r = importRows(rows, { mid, did, map: nt.flds.map((_, i) => i), tagsCol: n, deckCol: n + 1, html: true, tags, dup });
    for (const k in res) res[k] += r[k] || 0;
  }
  return res;
}

// ---------- Markdown (Q/R, ::, ?, ==trous==, cases à cocher) ----------
function mdInline(s) {
  const math = [];
  s = s.replace(/\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g, (m, a, b) => { math.push(a != null ? `\\[${a}\\]` : `\\(${b}\\)`); return `\u0000${math.length - 1}\u0000`; });
  s = s.replace(/&(?![a-z]+;|#\d+;)/gi, '&amp;').replace(/<(?![a-z/!])/gi, '&lt;');
  s = s.replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '<img src="$1">')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, '<img src="$2" alt="$1">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '<a href="$2">$1</a>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*|__(.+?)__/g, (m, a, b) => `<b>${a ?? b}</b>`)
    .replace(/(^|[^*\w])\*(?!\s)(.+?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^_\w])_(?!\s)(.+?)_(?!\w)/g, '$1<i>$2</i>')
    .replace(/~~(.+?)~~/g, '<s>$1</s>');
  return s.replace(/\u0000(\d+)\u0000/g, (m, i) => math[+i]);
}
function mdBlock(lines) {
  let out = '', inList = null;
  for (const l of lines) {
    const li = l.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      const tag = /\d/.test(li[1]) ? 'ol' : 'ul';
      if (inList !== tag) { if (inList) out += `</${inList}>`; out += `<${tag}>`; inList = tag; }
      out += `<li>${mdInline(li[2])}</li>`;
    } else {
      if (inList) { out += `</${inList}>`; inList = null; }
      const hm = l.match(/^#{1,6}\s+(.*)$/);
      out += (out && !out.endsWith('>') ? '<br>' : '') + (hm ? `<b>${mdInline(hm[1])}</b>` : mdInline(l.trim()));
    }
  }
  if (inList) out += `</${inList}>`;
  return out;
}
export function parseMarkdown(text) {
  let lines = text.replace(/\r/g, '').split('\n');
  if (lines[0]?.trim() === '---') { const e = lines.indexOf('---', 1); if (e > 0) lines = lines.slice(e + 1); }
  const notes = [];
  const isCardish = l => /^\s*\?{1,2}\s*$/.test(l) || /\S\s*:{2,3}\s*\S/.test(l) || /^\s*(Q|Question)\s*:/i.test(l) || /==[^=\n]+==/.test(l) || /^\s*[-*] \[[ xX]\]/.test(l) || /\{\{c\d+::/.test(l);
  if (lines.some(isCardish)) {
    const blocks = []; let cur = [];
    for (const l of lines) {
      if (!l.trim() || /^\s*(---|\*\*\*)\s*$/.test(l) || /^#{1,6}\s/.test(l)) { if (cur.length) blocks.push(cur); cur = []; continue; }
      cur.push(l);
    }
    if (cur.length) blocks.push(cur);
    for (const b of blocks) {
      const qi = b.findIndex(l => /^\s*\?{1,2}\s*$/.test(l));
      if (qi > 0) { notes.push({ type: b[qi].trim() === '??' ? 'reversed' : 'basic', front: mdBlock(b.slice(0, qi)), back: mdBlock(b.slice(qi + 1)) }); continue; }
      const qm = b[0].match(/^\s*(?:Q|Question)\s*:\s*(.*)$/i);
      const ai = b.findIndex(l => /^\s*(?:A|R|Réponse|Reponse|Answer)\s*:/i.test(l));
      if (qm && ai > 0) {
        notes.push({ type: 'basic', front: mdBlock([qm[1], ...b.slice(1, ai)]), back: mdBlock([b[ai].replace(/^\s*(?:A|R|Réponse|Reponse|Answer)\s*:\s*/i, ''), ...b.slice(ai + 1)]) });
        continue;
      }
      const boxes = b.map((l, i) => [l.match(/^\s*[-*] \[([ xX])\]\s+(.*)$/), i]).filter(x => x[0]);
      if (boxes.length >= 2) {
        const first = boxes[0][1], last = boxes[boxes.length - 1][1];
        const after = b.slice(last + 1).map(l => l.replace(/^\s*(>|Explication\s*:|Explanation\s*:)\s*/i, ''));
        notes.push({ type: 'mcq', question: mdBlock(b.slice(0, first)), choices: boxes.map(x => mdInline(x[0][2])),
          correct: boxes.map((x, k) => x[0][1] !== ' ' ? k : -1).filter(k => k >= 0), expl: mdBlock(after) });
        continue;
      }
      if (b.some(l => /==[^=\n]+==|\{\{c\d+::/.test(l))) {
        let n = 0; const txt = b.join('\n').replace(/==([^=\n]+)==/g, (m, x) => `{{c${++n}::${x}}}`);
        notes.push({ type: 'cloze', text: mdBlock(txt.split('\n')) }); continue;
      }
      for (const l of b) {
        const m = l.match(/^(.*?\S)\s*(:{2,3})\s*(\S.*)$/);
        if (!m) continue;
        const back = m[3].trim();
        const tf = /^(vrai|faux|true|false)$/i.test(back) ? /^(vrai|true)$/i.test(back) : null;
        if (tf != null) notes.push({ type: 'tf', statement: mdInline(m[1].replace(/^\s*[-*]\s+/, '')), answer: tf });
        else notes.push({ type: m[2] === ':::' ? 'reversed' : 'basic', front: mdInline(m[1].replace(/^\s*[-*]\s+/, '')), back: mdInline(back) });
      }
    }
  } else {
    let cur = null;
    for (const l of lines) {
      const hm = l.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { if (cur?.body.some(x => x.trim())) notes.push({ type: 'basic', front: mdInline(cur.title), back: mdBlock(cur.body.filter(x => x.trim())) }); cur = { title: hm[2], body: [] }; }
      else if (cur) cur.body.push(l);
    }
    if (cur?.body.some(x => x.trim())) notes.push({ type: 'basic', front: mdInline(cur.title), back: mdBlock(cur.body.filter(x => x.trim())) });
  }
  return notes;
}

// ---------- GIFT (Moodle) ----------
const unescGift = s => s.replace(/\\n/g, '<br>').replace(/\\([:~=#{}])/g, '$1').trim();
function giftFormat(s) {
  const m = s.match(/^\s*\[(html|markdown|plain|moodle)\]\s*/i);
  if (!m) return esc(unescGift(s)).replace(/&lt;br&gt;/g, '<br>');
  const body = s.slice(m[0].length);
  if (m[1].toLowerCase() === 'html') return unescGift(body);
  if (m[1].toLowerCase() === 'markdown') return mdInline(unescGift(body));
  return esc(unescGift(body));
}
function splitUnescaped(s, chars) {
  const out = []; let cur = '', mark = null;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; continue; }
    if (chars.includes(s[i])) { if (mark !== null || cur.trim()) out.push({ mark, text: cur }); mark = s[i]; cur = ''; continue; }
    cur += s[i];
  }
  if (mark !== null || cur.trim()) out.push({ mark, text: cur });
  return out;
}
export function parseGift(text) {
  const src = text.replace(/\r/g, '').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const chunks = []; let cur = '', depth = 0;
  for (const line of src.split('\n')) {
    if (!line.trim() && depth === 0) { if (cur.trim()) chunks.push(cur); cur = ''; continue; }
    cur += line + '\n';
    for (let i = 0; i < line.length; i++) { if (line[i] === '\\') { i++; continue; } if (line[i] === '{') depth++; else if (line[i] === '}') depth = Math.max(0, depth - 1); }
  }
  if (cur.trim()) chunks.push(cur);
  const notes = []; let category = '';
  for (let q of chunks) {
    q = q.trim();
    const cat = q.match(/^\$CATEGORY:\s*(.*)$/m);
    if (cat) { category = cat[1].replace(/^\$(course|system|module)\$\/?/i, '').replace(/^top\/?/i, '').split('/').filter(Boolean).join('::'); q = q.replace(cat[0], '').trim(); if (!q) continue; }
    q = q.replace(/^::(?:\\.|[^:])*?::\s*/, '');
    let open = -1, close = -1, d = 0;
    for (let i = 0; i < q.length; i++) {
      if (q[i] === '\\') { i++; continue; }
      if (q[i] === '{') { if (d === 0) open = i; d++; }
      else if (q[i] === '}') { d--; if (d === 0) { close = i; break; } }
    }
    if (open < 0 || close < 0) continue;
    const before = q.slice(0, open).trim(), after = q.slice(close + 1).trim();
    const stem = giftFormat(before) + (after ? ' _____ ' + giftFormat(after) : '');
    let inner = q.slice(open + 1, close).trim();
    let expl = '';
    const gf = inner.indexOf('####');
    if (gf >= 0) { expl = giftFormat(inner.slice(gf + 4)); inner = inner.slice(0, gf).trim(); }
    const deck = category || '';
    const tfm = inner.match(/^(TRUE|FALSE|T|F)\b\s*(?:#(.*))?$/is);
    if (tfm) {
      notes.push({ type: 'tf', statement: stem, answer: /^T/i.test(tfm[1]), expl: expl || (tfm[2] ? giftFormat(tfm[2].split('#')[0]) : ''), deck });
      continue;
    }
    if (inner.startsWith('#')) { notes.push({ type: 'basic', front: stem, back: esc(unescGift(inner.slice(1))), deck }); continue; }
    if (!inner) { continue; }
    const items = splitUnescaped(inner, '=~').filter(x => x.mark);
    if (!items.length) continue;
    const parsed = items.map(x => {
      let t = x.text; let w = null;
      const wm = t.match(/^\s*%(-?\d+(?:\.\d+)?)%/); if (wm) { w = +wm[1]; t = t.slice(wm[0].length); }
      const fb = splitUnescaped(t, '#');
      return { correct: x.mark === '=' || (w != null && w > 0), wrong: x.mark === '~' && !(w > 0), text: fb[0]?.text ?? t };
    });
    if (parsed.some(p => /(?<!\\)->/.test(p.text))) {
      const pairs = parsed.map(p => p.text.split(/(?<!\\)->/).map(s => giftFormat(s)));
      notes.push({ type: 'basic', front: stem, back: pairs.map(([a, b]) => `${a} → ${b}`).join('<br>'), deck });
    } else if (!items.some(x => x.mark === '~')) {
      notes.push({ type: 'basic', front: stem, back: parsed.map(p => giftFormat(p.text)).join(' / '), deck });
    } else {
      notes.push({ type: 'mcq', question: stem, choices: parsed.map(p => giftFormat(p.text)), correct: parsed.map((p, i) => p.correct ? i : -1).filter(i => i >= 0), expl, deck });
    }
  }
  return notes;
}

// ---------- Aiken ----------
export const looksAiken = t => /^\s*ANSWER\s*:\s*[A-Z]/im.test(t) && /^\s*[A-Z][.)]\s+\S/m.test(t);
export function parseAiken(text) {
  const notes = []; let q = [], opts = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const t = raw.trim(); if (!t) continue;
    const am = t.match(/^ANSWER\s*:\s*([A-Z](?:\s*[,;]\s*[A-Z])*)\s*$/i);
    if (am) {
      if (q.length && opts.length) {
        const letters = am[1].toUpperCase().split(/[\s,;]+/);
        notes.push({ type: 'mcq', question: q.map(esc).join('<br>'), choices: opts.map(o => esc(o.text)), correct: opts.map((o, i) => letters.includes(o.letter) ? i : -1).filter(i => i >= 0) });
      }
      q = []; opts = []; continue;
    }
    const om = t.match(/^([A-Z])[.)]\s+(.*)$/);
    if (om && q.length) opts.push({ letter: om[1], text: om[2] });
    else { if (opts.length) { q = []; opts = []; } q.push(t); }
  }
  return notes;
}

// ---------- HTML (tableaux, listes de définitions) ----------
export function htmlToRows(text) {
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const rows = [];
  for (const tr of doc.querySelectorAll('tr')) {
    const cells = [...tr.children].filter(c => /^(TD|TH)$/.test(c.tagName));
    if (cells.length >= 2 && !cells.every(c => c.tagName === 'TH')) rows.push(cells.map(c => c.innerHTML.trim()));
  }
  if (!rows.length) for (const dt of doc.querySelectorAll('dt')) { const dd = dt.nextElementSibling; if (dd?.tagName === 'DD') rows.push([dt.innerHTML.trim(), dd.innerHTML.trim()]); }
  const head = doc.querySelector('tr') && [...doc.querySelector('tr').children].every(c => c.tagName === 'TH') ? [...doc.querySelector('tr').children].map(c => c.textContent.trim()) : null;
  return { rows, header: head };
}

// ---------- JSON ----------
const cellStr = v => v == null ? '' : Array.isArray(v) ? v.map(cellStr).join('\n') : typeof v === 'object' ? JSON.stringify(v) : String(v);
export function jsonToRows(data) {
  let arr = Array.isArray(data) ? data : (data.cards || data.notes || data.items || data.questions || data.flashcards || data.terms || data.data || Object.values(data).find(Array.isArray));
  if (!Array.isArray(arr) || !arr.length) throw new Error(t('Aucune liste de cartes trouvée dans ce JSON.'));
  if (Array.isArray(arr[0])) return { header: null, rows: arr.map(r => r.map(cellStr)) };
  if (typeof arr[0] !== 'object') return { header: null, rows: arr.map(x => [cellStr(x)]) };
  const keys = []; for (const o of arr) for (const k of Object.keys(o || {})) if (!keys.includes(k)) keys.push(k);
  return { header: keys, rows: arr.map(o => keys.map(k => cellStr(o?.[k]))) };
}
export function crowdAnkiToFrag(deck, mediaZip = null) {
  const notetypes = [], decks = [], notes = [];
  const ntIds = new Map();
  for (const m of deck.note_models || []) {
    const id = newId(); ntIds.set(m.crowdanki_uuid, id);
    notetypes.push(ntFrom(id, m.name, m.type, (m.flds || []).sort((a, b) => a.ord - b.ord).map(f => f.name), (m.tmpls || []).sort((a, b) => a.ord - b.ord), m.css, m.sortf, 0));
  }
  const walk = (d, prefix) => {
    const name = prefix ? `${prefix}::${d.name}` : d.name;
    const id = newId(); decks.push({ id, name });
    for (const n of d.notes || []) notes.push({ id: newId(), guid: n.guid || guid(), mid: ntIds.get(n.note_model_uuid), flds: n.fields || [], tags: n.tags || [], mod: Date.now(), did: id });
    for (const c of d.children || []) walk(c, name);
  };
  walk(deck, '');
  const frag = { notetypes, decks, notes, cards: [], revlog: [] };
  if (mediaZip) {
    frag.media = (deck.media_files || []).map(name => ({ name, zipName: Object.keys(mediaZip.files).find(p => p.endsWith('media/' + name)) })).filter(e => e.zipName);
    frag.loadMedia = async (name, zipName) => new Blob([await mediaZip.file(zipName).async('uint8array')], { type: mimeOf(name) });
  }
  return frag;
}

// ---------- sauvegarde Mnemo ----------
export function isMnemoJson(j) { return j && j.format === 'mnemo'; }
export function mnemoToFrag(j) {
  return { notetypes: j.notetypes || [], decks: j.decks || [], notes: j.notes || [], cards: j.cards || [], revlog: j.revlog || [] };
}
export async function restoreBackup(j, mediaLoader, progress = () => {}) {
  const { wipeAll, flush, putMediaMany } = await import('./db.js');
  await wipeAll();
  for (const nt of j.notetypes || []) S.notetypes.set(nt.id, nt);
  for (const d of j.decks || []) S.decks.set(d.id, d);
  for (const p of j.presets || []) S.presets.set(p.id, { ...defaultPreset(p.id, p.name), ...p });
  for (const n of j.notes || []) S.notes.set(n.id, n);
  for (const c of j.cards || []) S.cards.set(c.id, c);
  S.revlog = (j.revlog || []).sort((a, b) => a.id - b.id);
  S.settings = { ...structuredClone(DEFAULT_SETTINGS), ...(j.settings || {}) };
  S.settings.gestures = { ...DEFAULT_SETTINGS.gestures, ...(j.settings?.gestures || {}) };
  S.meta = { nextPos: 1, ...(j.meta || {}) };
  if (!S.presets.size) S.presets.set(1, defaultPreset());
  if (!S.decks.has(1)) S.decks.set(1, { id: 1, name: t('Par défaut'), conf: 1, desc: '', collapsed: false, mod: Date.now() });
  for (const [store, map] of [['notetypes', S.notetypes], ['decks', S.decks], ['presets', S.presets], ['notes', S.notes], ['cards', S.cards]]) for (const v of map.values()) { persist.put(store, v); bumpIdFloor(v.id); }
  for (const l of S.revlog) persist.put('revlog', l);
  persist.putKV('settings', S.settings); persist.putKV('meta', S.meta);
  invalidateDecks(); indexCards(); setRollover(S.settings.rollover);
  progress(t('Écriture de la base…'));
  await flush();
  if (mediaLoader) {
    const names = mediaLoader.names; let batch = [];
    for (let k = 0; k < names.length; k++) {
      batch.push({ name: names[k], blob: await mediaLoader.load(names[k]) });
      if (batch.length >= 40 || k === names.length - 1) { progress(t('Médias : {a} / {b}', { a: k + 1, b: names.length })); await putMediaMany(batch); batch = []; }
    }
  }
}

// ---------- détection du format ----------
export async function detectFile(file) {
  const name = file.name || 'fichier';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4B;
  if (ext === 'apkg' || ext === 'colpkg') return { kind: 'apkg' };
  if (isZip) {
    const JSZip = await getJSZip();
    const zip = await JSZip.loadAsync(file);
    if (zip.file('mnemo.json')) return { kind: 'backup', zip };
    if (zip.file('collection.anki2') || zip.file('collection.anki21') || zip.file('collection.anki21b')) return { kind: 'apkg' };
    const deckJson = Object.keys(zip.files).find(p => p.endsWith('deck.json'));
    if (deckJson) return { kind: 'crowdanki', data: JSON.parse(await zip.file(deckJson).async('string')), zip };
    throw new Error(t('Archive ZIP non reconnue (ni .apkg, ni sauvegarde Mnemo, ni CrowdAnki).'));
  }
  const text = (await file.text()).replace(/^\uFEFF/, '');
  return detectText(text, ext);
}
export function detectText(text, ext = '') {
  if (ext === 'json' || /^\s*[[{]/.test(text)) {
    let j = null; try { j = JSON.parse(text); } catch {}
    if (j) {
      if (isMnemoJson(j)) return { kind: j.kind === 'backup' ? 'backup-json' : 'mnemo', data: j };
      if (j.__type__ === 'Deck') return { kind: 'crowdanki', data: j };
      return { kind: 'rows', source: 'JSON', ...jsonToRows(j), html: true };
    }
  }
  if (ext === 'gift' || /\{\s*(=|~|T\s*\}|F\s*\}|TRUE|FALSE)/.test(text) && /\}\s*$/m.test(text) && !/\t/.test(text.split('\n')[0])) {
    const notes = parseGift(text);
    if (notes.length) return { kind: 'simple', source: 'GIFT', notes };
  }
  if (looksAiken(text)) { const notes = parseAiken(text); if (notes.length) return { kind: 'simple', source: 'Aiken', notes }; }
  if (ext === 'html' || ext === 'htm' || /^\s*<(!doctype|html|table|dl)/i.test(text)) {
    const r = htmlToRows(text);
    if (r.rows.length) return { kind: 'rows', source: 'HTML', rows: r.rows, header: r.header, html: true };
  }
  if (ext === 'md' || ext === 'markdown') {
    const notes = parseMarkdown(text);
    if (notes.length) return { kind: 'simple', source: 'Markdown', notes };
  }
  const a = analyzeDelimited(text);
  const multi = a.rows.length && a.rows.filter(r => r.length >= 2).length >= Math.max(1, a.rows.length * 0.6);
  if (!multi) {
    const notes = parseMarkdown(text);
    if (notes.length) return { kind: 'simple', source: 'Markdown', notes };
  }
  if (!a.rows.length) throw new Error(t('Aucune carte reconnue dans ce texte.'));
  return { kind: 'rows', source: ext === 'tsv' ? 'TSV' : ext === 'csv' ? 'CSV' : t('Texte'), ...a, _text: text };
}
