// Mnemo — recherche avec la syntaxe d'Anki
import { S } from './state.js';
import { stripHtml, today, dayStart } from './util.js';
import { t, getLang } from './i18n.js';

function tokenize(q) {
  const toks = []; let i = 0;
  while (i < q.length) {
    const ch = q[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { toks.push({ t: ch }); i++; continue; }
    let neg = false;
    if (ch === '-' && i + 1 < q.length && !/\s/.test(q[i + 1])) { neg = true; i++; }
    if (q[i] === '(') { toks.push({ t: 'neg' }); continue; }
    let s = '', quoted = false;
    while (i < q.length && !/\s/.test(q[i]) && q[i] !== '(' && q[i] !== ')') {
      if (q[i] === '"') {
        quoted = true; i++;
        while (i < q.length && q[i] !== '"') { if (q[i] === '\\' && q[i + 1] === '"') { s += '"'; i += 2; } else s += q[i++]; }
        i++;
      } else s += q[i++];
    }
    const low = s.toLowerCase();
    if (!quoted && !neg && (low === 'or' || low === 'and')) toks.push({ t: low });
    else toks.push({ t: 'term', v: s, neg });
  }
  return toks;
}

function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  function or() {
    let left = and();
    while (peek()?.t === 'or') { i++; const r = and(); const l = left; left = (c, n) => l(c, n) || r(c, n); }
    return left;
  }
  function and() {
    const items = [];
    while (i < toks.length && peek().t !== ')' && peek().t !== 'or') {
      if (peek().t === 'and') { i++; continue; }
      items.push(unary());
    }
    return items.length ? (c, n) => items.every(f => f(c, n)) : () => true;
  }
  function unary() {
    const t = toks[i++];
    if (t.t === 'neg') { const f = unary(); return (c, n) => !f(c, n); }
    if (t.t === '(') { const f = or(); if (peek()?.t === ')') i++; return f; }
    if (t.t === ')') return () => true;
    const f = term(t.v);
    return t.neg ? (c, n) => !f(c, n) : f;
  }
  return or();
}

const reEsc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function glob(pat, { whole = true, sub = false } = {}) {
  const body = reEsc(pat).replace(/\*/g, '.*').replace(/_/g, '.');
  return new RegExp(whole ? `^${body}${sub ? '(::.*)?' : ''}$` : body, 'i');
}
const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function cmp(op, a, b) {
  switch (op) { case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; case '!=': return a !== b; default: return a === b; }
}

let fieldCache = new Map();
const noteText = n => {
  let t = fieldCache.get(n.id);
  if (t === undefined) { t = n.flds.map(stripHtml).join(' \u2002 '); fieldCache.set(n.id, t); }
  return t;
};

function term(raw) {
  const i = raw.indexOf(':');
  const key = i > 0 ? raw.slice(0, i).toLowerCase() : '';
  const val = i > 0 ? raw.slice(i + 1) : raw;
  const day = today();
  switch (key) {
    case 'deck': {
      if (val === '*') return () => true;
      const re = glob(val, { sub: true });
      const ok = new Set([...S.decks.values()].filter(d => re.test(d.name)).map(d => d.id));
      return c => ok.has(c.did);
    }
    case 'tag': {
      if (val.toLowerCase() === 'none') return (c, n) => !n.tags.length;
      const re = glob(val, { sub: true });
      return (c, n) => n.tags.some(t => re.test(t));
    }
    case 'note': case 'notetype': {
      const re = glob(val);
      const ok = new Set([...S.notetypes.values()].filter(nt => re.test(nt.name)).map(nt => nt.id));
      return (c, n) => ok.has(n.mid);
    }
    case 'card': {
      if (/^\d+$/.test(val)) return c => c.ord === +val - 1;
      const re = glob(val);
      return (c, n) => { const nt = S.notetypes.get(n.mid); const t = nt?.kind === 'cloze' ? nt.tmpls[0] : nt?.tmpls[c.ord]; return !!t && re.test(t.name); };
    }
    case 'is': {
      const v = val.toLowerCase();
      const endTs = dayStart(day + 1);
      const m = {
        new: c => c.type === 0, learn: c => c.type === 1 || c.type === 3, review: c => c.type === 2 || c.type === 3,
        due: c => ((c.queue === 2 || c.queue === 3) && c.due <= day) || (c.queue === 1 && c.due < endTs),
        suspended: c => c.queue === -1, buried: c => c.queue === -2 || c.queue === -3,
        marked: (c, n) => n.tags.some(t => t.toLowerCase() === 'marked'),
        leech: (c, n) => n.tags.some(t => t.toLowerCase() === 'leech'),
        flagged: c => (c.flags & 7) > 0,
      };
      return m[v] || (() => false);
    }
    case 'flag': { const f = +val; return c => (c.flags & 7) === f; }
    case 'added': { const since = dayStart(day - Math.max(1, +val || 1) + 1); return c => c.id >= since; }
    case 'edited': { const since = dayStart(day - Math.max(1, +val || 1) + 1); return (c, n) => n.mod >= since; }
    case 'rated': case 'introduced': {
      const [d, e] = val.split(':');
      const since = dayStart(day - Math.max(1, Math.min(3650, +d || 1)) + 1);
      const ids = new Set();
      if (key === 'rated') { for (const l of S.revlog) if (l.id >= since && l.ease >= 1 && (!e || l.ease === +e)) ids.add(l.cid); }
      else {
        const first = new Map();
        for (const l of S.revlog) if (l.ease >= 1 && !first.has(l.cid)) first.set(l.cid, l.id);
        for (const [cid, ts] of first) if (ts >= since) ids.add(cid);
      }
      return c => ids.has(c.id);
    }
    case 'prop': {
      const m = val.match(/^([a-z]+)(<=|>=|!=|=|<|>)(-?[\d.]+)$/i);
      if (!m) return () => false;
      const [, p, op, num] = m; const x = +num;
      const get = {
        ivl: c => c.ivl, due: c => (c.queue === 2 || c.queue === 3) ? c.due - day : null,
        reps: c => c.reps, lapses: c => c.lapses, ease: c => c.factor / 1000,
        s: c => c.s, d: c => c.d, pos: c => c.type === 0 ? c.due : null,
      }[p.toLowerCase()];
      if (!get) return () => false;
      return c => { const v = get(c); return v != null && cmp(op, v, x); };
    }
    case 'nid': { const ids = new Set(val.split(',').map(Number)); return (c, n) => ids.has(n.id); }
    case 'cid': { const ids = new Set(val.split(',').map(Number)); return c => ids.has(c.id); }
    case 're': { let re; try { re = new RegExp(val, 'i'); } catch { return () => false; } return (c, n) => re.test(n.flds.join(' ')); }
    case 'nc': { const t = normalize(val.toLowerCase()); return (c, n) => normalize(noteText(n).toLowerCase()).includes(t); }
    case '': break;
    default: {
      // champ:valeur
      const fieldName = raw.slice(0, i);
      const re = glob(val);
      return (c, n) => {
        const nt = S.notetypes.get(n.mid); if (!nt) return false;
        const k = nt.flds.findIndex(f => f.name.toLowerCase() === fieldName.toLowerCase());
        return k >= 0 && re.test(stripHtml(n.flds[k] ?? ''));
      };
    }
  }
  const re = glob(raw, { whole: false });
  return (c, n) => re.test(noteText(n));
}

export function compileSearch(q) {
  fieldCache = new Map();
  const toks = tokenize(String(q || '').trim());
  if (!toks.length) return () => true;
  return parse(toks);
}

export function searchCards(q) {
  const f = compileSearch(q);
  const out = [];
  for (const c of S.cards.values()) { const n = S.notes.get(c.nid); if (n && f(c, n)) out.push(c); }
  return out;
}

export function searchHelp() {
  return [
    ['chat', t('Notes contenant « chat »')],
    ['"le chat noir"', t('Expression exacte')],
    ['chat -chien', t('Contient chat mais pas chien')],
    ['chat or chien', t("L'un ou l'autre")],
    ['deck:Physique', t('Paquet et ses sous-paquets')],
    ['tag:méca*', t('Étiquette (joker *)')],
    ['note:QCM', t('Type de note')],
    [t('Recto:*force*'), t("Contenu d'un champ")],
    ['is:due', t("À réviser aujourd'hui")],
    ['is:new  is:learn  is:review', t('État de la carte')],
    ['is:suspended  is:buried', t('Suspendues, enfouies')],
    ['flag:1', t('Drapeau rouge (1 à 7)')],
    ['added:7', t('Ajoutées ces 7 derniers jours')],
    ['rated:1:1', t("Ratées aujourd'hui")],
    ['prop:ivl>=30', t("Intervalle d'au moins 30 j")],
    ['prop:due<=3', t('Échéance dans 3 j ou moins')],
    ['re:\\d{4}', t('Expression régulière')],
  ].map(([q, d]) => [getLang() === 'en' ? q.replace('chat', 'cat').replace('chien', 'dog').replace('le cat noir', 'the black cat').replace('Physique', 'Physics').replace('méca', 'mech').replace('note:QCM', 'note:Multiple*') : q, d]);
}
