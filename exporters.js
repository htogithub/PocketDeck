// Mnemo — exportation : .apkg (compatible Anki), texte TSV/CSV, JSON Mnemo, sauvegarde complète
import { S, deckSubtree, presetOf } from './state.js';
import { getSQL, getJSZip, stripHtml, today, dayStart, sha1Hex } from './util.js';
import { getMedia, mediaNames } from './db.js';
import { t } from './i18n.js';

const SCHEMA = `
CREATE TABLE col (id integer primary key, crt integer not null, mod integer not null, scm integer not null, ver integer not null,
  dty integer not null, usn integer not null, ls integer not null, conf text not null, models text not null, decks text not null,
  dconf text not null, tags text not null);
CREATE TABLE notes (id integer primary key, guid text not null, mid integer not null, mod integer not null, usn integer not null,
  tags text not null, flds text not null, sfld integer not null, csum integer not null, flags integer not null, data text not null);
CREATE TABLE cards (id integer primary key, nid integer not null, did integer not null, ord integer not null, mod integer not null,
  usn integer not null, type integer not null, queue integer not null, due integer not null, ivl integer not null, factor integer not null,
  reps integer not null, lapses integer not null, left integer not null, odue integer not null, odid integer not null,
  flags integer not null, data text not null);
CREATE TABLE revlog (id integer primary key, cid integer not null, usn integer not null, ease integer not null, ivl integer not null,
  lastIvl integer not null, factor integer not null, time integer not null, type integer not null);
CREATE TABLE graves (usn integer not null, oid integer not null, type integer not null);
CREATE INDEX ix_notes_usn on notes (usn);
CREATE INDEX ix_cards_usn on cards (usn);
CREATE INDEX ix_revlog_usn on revlog (usn);
CREATE INDEX ix_cards_nid on cards (nid);
CREATE INDEX ix_cards_sched on cards (did, queue, due);
CREATE INDEX ix_revlog_cid on revlog (cid);
CREATE INDEX ix_notes_csum on notes (csum);
`;
const LATEX_PRE = '\\documentclass[12pt]{article}\n\\special{papersize=3in,5in}\n\\usepackage[utf8]{inputenc}\n\\usepackage{amssymb,amsmath}\n\\pagestyle{empty}\n\\setlength{\\parindent}{0in}\n\\begin{document}\n';
const sec = ms => Math.floor((ms || Date.now()) / 1000);
const b64 = str => { const b = new TextEncoder().encode(str); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };

function dconf(p) {
  return {
    id: 1, name: 'Default', mod: sec(), usn: -1, maxTaken: 60, autoplay: true, timer: 0, replayq: true, dyn: false,
    new: { bury: !!p.buryNew, delays: p.learnSteps, initialFactor: Math.round(p.startEase * 1000), ints: [p.gradIvl, p.easyIvl, 0], order: 1, perDay: p.newPerDay },
    rev: { bury: !!p.buryRev, ease4: p.easyBonus, ivlFct: p.ivlMod, maxIvl: p.maxIvl, perDay: p.revPerDay, hardFactor: p.hardIvl },
    lapse: { delays: p.relearnSteps, leechAction: p.leechAction === 'suspend' ? 0 : 1, leechFails: p.leechThreshold, minInt: p.minIvl, mult: p.lapseMult },
  };
}
// Les QCM et vrai/faux deviennent des cartes Anki lisibles ; un marqueur permet de les restaurer à la réimportation
function ankiTemplates(nt) {
  if (nt.kind !== 'mcq' && nt.kind !== 'tf') return nt.tmpls;
  return nt.tmpls.map(x => {
    let q = x.qfmt, a = x.afmt;
    if (nt.kind === 'mcq') {
      const ans = nt.mcq?.answer || 'Réponse';
      q = q.replace(/\{\{mcq:([^}]+)\}\}/g, '<div class="mcq-choices">{{$1}}</div>');
      a = a.replace(/\{\{mcq:([^}]+)\}\}/g, `<div class="mcq-choices">{{$1}}</div>\n<hr id=answer>\n<div class="mcq-answer">{{${ans}}}</div>`);
    } else {
      q = q.replace(/\{\{tf:([^}]+)\}\}/g, `<div class="tf-prompt">${t('Vrai ou faux ?')}</div>`);
      a = a.replace(/\{\{tf:([^}]+)\}\}/g, '<hr id=answer>\n<div class="tf-answer">{{$1}}</div>');
    }
    return { ...x, qfmt: q, afmt: a };
  });
}
function ankiCss(nt) {
  if (nt.kind !== 'mcq' && nt.kind !== 'tf') return nt.css;
  const extra = nt.kind === 'mcq'
    ? '\n.mcq-choices { text-align: left; display: inline-block; }\n.mcq-answer { font-weight: bold; }\n'
    : '\n.tf-prompt { opacity: .6; font-size: .8em; }\n.tf-answer { font-weight: bold; }\n';
  return nt.css + extra + `\n/*mnemo:${b64(JSON.stringify({ kind: nt.kind, tmpls: nt.tmpls, mcq: nt.mcq, tf: nt.tf }))}*/`;
}

function referencedMedia(notes, notetypes) {
  const set = new Set();
  const scan = s => {
    for (const m of String(s || '').matchAll(/\bsrc\s*=\s*["']?([^"'>\s]+)/gi)) set.add(m[1]);
    for (const m of String(s || '').matchAll(/\[sound:([^\]]+)\]/g)) set.add(m[1].trim());
    for (const m of String(s || '').matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) set.add(m[1]);
    for (const m of String(s || '').matchAll(/["'(\s](_[^"'()\s]+\.\w{2,5})/g)) set.add(m[1]);
  };
  for (const n of notes) n.flds.forEach(scan);
  for (const nt of notetypes) { scan(nt.css); nt.tmpls.forEach(x => { scan(x.qfmt); scan(x.afmt); }); }
  return [...set].filter(n => !/^(https?:|data:|blob:|\/\/)/i.test(n));
}

function scope(did) {
  const decks = did == null ? [...S.decks.keys()] : deckSubtree(did);
  const dset = new Set(decks);
  const cards = [...S.cards.values()].filter(c => dset.has(c.did));
  const nids = [...new Set(cards.map(c => c.nid))];
  const notes = nids.map(id => S.notes.get(id)).filter(Boolean);
  const notetypes = [...new Set(notes.map(n => n.mid))].map(id => S.notetypes.get(id)).filter(Boolean);
  return { decks, cards, notes, notetypes };
}

export async function exportApkg({ did = null, sched = true, media = true, progress = () => {} } = {}) {
  const [SQL, JSZip] = await Promise.all([getSQL(), getJSZip()]);
  const { decks, cards, notes, notetypes } = scope(did);
  progress(t('Préparation de la base…'));
  const day = today();
  let crtDay = day;
  if (sched) for (const c of cards) if (c.due < 1e10 && c.type !== 0) crtDay = Math.min(crtDay, c.due);
  crtDay -= 1;
  const crt = sec(dayStart(crtDay));
  const db = new SQL.Database();
  db.run(SCHEMA);
  const models = {};
  for (const nt of notetypes) {
    const tm = ankiTemplates(nt);
    models[nt.id] = {
      id: nt.id, name: nt.name, type: nt.kind === 'cloze' ? 1 : 0, mod: sec(nt.mod), usn: -1, sortf: nt.sortf || 0, did: decks[0] ?? 1,
      tmpls: tm.map((x, i) => ({ name: x.name, ord: i, qfmt: x.qfmt, afmt: x.afmt, bqfmt: '', bafmt: '', did: null, bfont: '', bsize: 0 })),
      flds: nt.flds.map((f, i) => ({ name: f.name, ord: i, sticky: false, rtl: false, font: 'Arial', size: 20, media: [] })),
      css: ankiCss(nt), latexPre: LATEX_PRE, latexPost: '\\end{document}', latexsvg: false,
      req: tm.map((x, i) => [i, 'any', [0]]), tags: [], vers: [],
    };
  }
  const deckJson = {};
  const mkDeck = (id, name) => ({ id, name, mod: sec(), usn: -1, lrnToday: [0, 0], revToday: [0, 0], newToday: [0, 0], timeToday: [0, 0],
    collapsed: false, browserCollapsed: false, desc: S.decks.get(id)?.desc || '', dyn: 0, conf: 1, extendNew: 0, extendRev: 0 });
  deckJson[1] = mkDeck(1, S.decks.get(1)?.name || 'Default');
  for (const id of decks) deckJson[id] = mkDeck(id, S.decks.get(id).name);
  const conf = { activeDecks: [1], curDeck: 1, newSpread: 0, collapseTime: 1200, timeLim: 0, estTimes: true, dueCounts: true, curModel: null, nextPos: S.meta.nextPos || 1, sortType: 'noteFld', sortBackwards: false, addToCur: true };
  const p = did != null ? presetOf(did) : S.presets.get(1);
  db.run('INSERT INTO col VALUES (1,?,?,?,11,0,0,0,?,?,?,?,?)', [crt, Date.now(), Date.now(), JSON.stringify(conf), JSON.stringify(models), JSON.stringify(deckJson), JSON.stringify({ 1: dconf(p) }), '{}']);

  progress(t('Écriture des notes…'));
  db.run('BEGIN');
  const ins = db.prepare('INSERT INTO notes VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (let i = 0; i < notes.length; i += 200) {
    const chunk = notes.slice(i, i + 200);
    const sums = await Promise.all(chunk.map(n => sha1Hex(stripHtml(n.flds[0] || ''))));
    chunk.forEach((n, k) => {
      const nt = S.notetypes.get(n.mid);
      ins.run([n.id, n.guid, n.mid, sec(n.mod), -1, n.tags.length ? ` ${n.tags.join(' ')} ` : '', n.flds.join('\x1f'),
        stripHtml(n.flds[nt?.sortf || 0] || ''), parseInt(sums[k].slice(0, 8), 16), 0, '']);
    });
  }
  ins.free();
  const insC = db.prepare('INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  let pos = 0;
  for (const c of cards.slice().sort((a, b) => a.due - b.due)) {
    let type = 0, queue = 0, due = ++pos, ivl = 0, factor = 0, reps = 0, lapses = 0, left = 0, data = '';
    if (sched) {
      const pp = presetOf(c.did);
      type = c.type; ivl = c.ivl || 0; factor = c.factor || 0; reps = c.reps || 0; lapses = c.lapses || 0;
      queue = c.queue === -3 || c.queue === -2 ? c.queue : c.queue;
      if (c.type === 0) due = c.due;
      else if (c.due > 1e10) due = sec(c.due);
      else due = c.due - crtDay;
      if (c.type === 1 || c.type === 3) {
        const steps = (c.type === 3 ? pp.relearnSteps : pp.learnSteps) || [];
        const rem = Math.max(1, steps.length - (c.step || 0));
        left = rem * 1000 + rem;
      }
      if (c.s != null && c.d != null) data = JSON.stringify({ s: +c.s.toFixed(4), d: +c.d.toFixed(4), dr: pp.retention });
    }
    insC.run([c.id, c.nid, c.did, c.ord, sec(c.mod), -1, type, queue, due, ivl, factor, reps, lapses, left, 0, 0, sched ? (c.flags & 7) : 0, data]);
  }
  insC.free();
  if (sched) {
    const ids = new Set(cards.map(c => c.id));
    const insR = db.prepare('INSERT INTO revlog VALUES (?,?,?,?,?,?,?,?,?)');
    for (const l of S.revlog) if (ids.has(l.cid)) insR.run([l.id, l.cid, -1, l.ease, l.ivl, l.lastIvl, l.factor, l.time, l.type]);
    insR.free();
  }
  db.run('COMMIT');
  const bytes = db.export();
  db.close();

  const zip = new JSZip();
  zip.file('collection.anki2', bytes);
  const map = {};
  if (media) {
    const names = referencedMedia(notes, notetypes);
    let i = 0;
    for (const name of names) {
      const blob = await getMedia(name);
      if (!blob) continue;
      zip.file(String(i), blob); map[i] = name; i++;
      if (i % 25 === 0) progress(t('Médias : {a} / {b}', { a: i, b: names.length }));
    }
  }
  zip.file('media', JSON.stringify(map));
  progress(t('Compression…'));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', mimeType: 'application/octet-stream' });
}

// Texte délimité au format « Notes en texte brut » d'Anki
export function exportDelimited({ did = null, sep = '\t' } = {}) {
  const { notes, cards } = scope(did);
  const deckOf = new Map(); for (const c of cards) if (!deckOf.has(c.nid)) deckOf.set(c.nid, S.decks.get(c.did)?.name || '');
  const q = v => /["\n\r]/.test(v) || v.includes(sep) ? `"${v.replace(/"/g, '""')}"` : v;
  const lines = [`#separator:${sep === '\t' ? 'tab' : sep === ',' ? 'comma' : sep === ';' ? 'semicolon' : sep}`, '#html:true', '#guid column:1', '#notetype column:2', '#deck column:3'];
  let maxF = 0;
  for (const n of notes) maxF = Math.max(maxF, n.flds.length);
  lines.push(`#tags column:${4 + maxF}`);
  for (const n of notes) {
    const nt = S.notetypes.get(n.mid);
    const f = n.flds.slice(); while (f.length < maxF) f.push('');
    lines.push([n.guid, nt?.name || '', deckOf.get(n.id), ...f, n.tags.join(' ')].map(x => q(String(x ?? ''))).join(sep));
  }
  return new Blob([lines.join('\n') + '\n'], { type: sep === ',' ? 'text/csv' : 'text/tab-separated-values' });
}

export function exportJson({ did = null, sched = true } = {}) {
  const { decks, cards, notes, notetypes } = scope(did);
  const ids = new Set(cards.map(c => c.id));
  const data = {
    format: 'mnemo', version: 1, kind: 'decks', exported: Date.now(),
    notetypes, decks: decks.map(id => ({ id, name: S.decks.get(id).name, desc: S.decks.get(id).desc || '', folder: !!S.decks.get(id).folder })), notes,
    cards: sched ? cards : cards.map(c => ({ ...c, type: 0, queue: 0, ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0, s: null, d: null, lastRev: null })),
    revlog: sched ? S.revlog.filter(l => ids.has(l.cid)) : [],
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

export async function exportBackup(progress = () => {}) {
  const JSZip = await getJSZip();
  const zip = new JSZip();
  const data = {
    format: 'mnemo', version: 1, kind: 'backup', exported: Date.now(),
    settings: S.settings, meta: S.meta, presets: [...S.presets.values()], decks: [...S.decks.values()],
    notetypes: [...S.notetypes.values()], notes: [...S.notes.values()], cards: [...S.cards.values()], revlog: S.revlog,
  };
  zip.file('mnemo.json', JSON.stringify(data));
  const names = await mediaNames();
  let i = 0;
  for (const n of names) {
    const blob = await getMedia(n);
    if (blob) zip.file('media/' + n, blob);
    if (++i % 25 === 0) progress(t('Médias : {a} / {b}', { a: i, b: names.length }));
  }
  progress(t('Compression…'));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
}
