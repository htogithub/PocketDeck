// Mnemo — état de la collection (en mémoire) et opérations de base
import { newId, guid, today, stripHtml } from './util.js';
import { cardOrdsFor } from './template.js';
import { t, getLang, detectLang } from './i18n.js';

export const S = {
  decks: new Map(), presets: new Map(), notetypes: new Map(),
  notes: new Map(), cards: new Map(), revlog: [],
  nc: new Map(),           // nid -> Set(cid)
  settings: {}, meta: {},
};

// Couche de persistance branchée par db.js (no-op pour les tests)
export const persist = { put() {}, del() {}, putKV() {} };

export const DEFAULT_W = [0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192,
  1.01925, 1.9395, 0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621];

export const DEFAULT_SETTINGS = {
  lang: null, theme: 'system', accent: '#8C7CF0', uiFont: 'instrument', cardFont: 'palatino', customCardFont: '',
  cardSize: 22, cardAlign: 'center', forceCardFont: true, adaptCardColors: true, cardWidth: 680,
  buttons: 4, showIntervals: true, showCounts: true, showTimer: false, autoplay: true,
  tapToReveal: true, revealOnChoice: true, suggestGrade: true, buttonSize: 'normal',
  gestures: { left: 'again', right: 'good', up: 'none', down: 'none', dbl: 'none', long: 'edit' },
  rollover: 4, learnAhead: 20, runScripts: false, dollarMath: false,
  lastDeck: 1, lastNotetype: null, browseSort: 'added', browseMode: 'cards',
};

export function defaultPreset(id = 1, name = t('Par défaut')) {
  return {
    id, name, algo: 'sm2', newPerDay: 20, revPerDay: 200,
    learnSteps: [1, 10], relearnSteps: [10], gradIvl: 1, easyIvl: 4,
    startEase: 2.5, easyBonus: 1.3, ivlMod: 1, hardIvl: 1.2, lapseMult: 0, minIvl: 1, maxIvl: 36500,
    leechThreshold: 8, leechAction: 'tag', newOrder: 'added', revOrder: 'due', mix: 'mix',
    buryNew: false, buryRev: false, retention: 0.9, weights: DEFAULT_W.slice(),
  };
}

// ---------- types de notes intégrés ----------
const BASE_CSS = `.card {
  font-family: var(--card-font);
  font-size: var(--card-size);
  text-align: var(--card-align);
  line-height: 1.5;
}
`;
const BUILTIN = {
  fr: {
    basic: ['Basique', ['Recto', 'Verso'], ['Carte 1']],
    reversed: ['Basique (avec carte inversée)', ['Recto', 'Verso'], ['Carte 1', 'Carte 2']],
    optional: ['Basique (carte inversée optionnelle)', ['Recto', 'Verso', 'Ajouter inversée'], ['Carte 1', 'Carte 2']],
    typein: ['Basique (réponse à taper)', ['Recto', 'Verso'], ['Carte 1']],
    cloze: ['Texte à trous', ['Texte', 'Remarques'], ['Texte à trous']],
    mcq: ['QCM', ['Question', 'Choix', 'Réponse', 'Explication'], ['QCM']],
    tf: ['Vrai ou faux', ['Affirmation', 'Réponse', 'Explication'], ['Vrai ou faux']],
  },
  en: {
    basic: ['Basic', ['Front', 'Back'], ['Card 1']],
    reversed: ['Basic (and reversed card)', ['Front', 'Back'], ['Card 1', 'Card 2']],
    optional: ['Basic (optional reversed card)', ['Front', 'Back', 'Add Reverse'], ['Card 1', 'Card 2']],
    typein: ['Basic (type in the answer)', ['Front', 'Back'], ['Card 1']],
    cloze: ['Cloze', ['Text', 'Back Extra'], ['Cloze']],
    mcq: ['Multiple choice', ['Question', 'Choices', 'Answer', 'Explanation'], ['Multiple choice']],
    tf: ['True or false', ['Statement', 'Answer', 'Explanation'], ['True or false']],
  },
};
export const BUILTIN_KEYS = Object.keys(BUILTIN.fr);
// Définition d'un type intégré dans une langue (sans identifiant)
export function builtinDef(key, lang = getLang()) {
  const [name, f, tn] = BUILTIN[lang === 'en' ? 'en' : 'fr'][key];
  const A = '\n\n<hr id=answer>\n\n';
  const tmpl = (i, qfmt, afmt) => ({ name: tn[i], ord: i, qfmt, afmt });
  const expl = x => `{{#${x}}}<div class="expl">{{${x}}}</div>{{/${x}}}`;
  const def = { builtin: key, name, kind: 'std', flds: f.map((name, ord) => ({ name, ord })), css: BASE_CSS, sortf: 0 };
  switch (key) {
    case 'basic': def.tmpls = [tmpl(0, `{{${f[0]}}}`, `{{FrontSide}}${A}{{${f[1]}}}`)]; break;
    case 'reversed': def.tmpls = [tmpl(0, `{{${f[0]}}}`, `{{FrontSide}}${A}{{${f[1]}}}`), tmpl(1, `{{${f[1]}}}`, `{{FrontSide}}${A}{{${f[0]}}}`)]; break;
    case 'optional': def.tmpls = [tmpl(0, `{{${f[0]}}}`, `{{FrontSide}}${A}{{${f[1]}}}`), tmpl(1, `{{#${f[2]}}}{{${f[1]}}}{{/${f[2]}}}`, `{{FrontSide}}${A}{{${f[0]}}}`)]; break;
    case 'typein': def.tmpls = [tmpl(0, `{{${f[0]}}}\n\n{{type:${f[1]}}}`, `{{${f[0]}}}${A}{{type:${f[1]}}}`)]; break;
    case 'cloze': def.kind = 'cloze'; def.tmpls = [tmpl(0, `{{cloze:${f[0]}}}`, `{{cloze:${f[0]}}}<br>\n{{${f[1]}}}`)]; break;
    case 'mcq': def.kind = 'mcq'; def.mcq = { choices: f[1], answer: f[2], shuffle: true };
      def.tmpls = [tmpl(0, `<div class="q">{{${f[0]}}}</div>\n{{mcq:${f[1]}}}`, `<div class="q">{{${f[0]}}}</div>\n{{mcq:${f[1]}}}\n${expl(f[3])}`)]; break;
    case 'tf': def.kind = 'tf'; def.tf = { answer: f[1] };
      def.tmpls = [tmpl(0, `<div class="q">{{${f[0]}}}</div>\n{{tf:${f[1]}}}`, `<div class="q">{{${f[0]}}}</div>\n{{tf:${f[1]}}}\n${expl(f[2])}`)]; break;
  }
  return def;
}
export function builtinNotetypes(lang = getLang()) {
  return BUILTIN_KEYS.map(k => ({ id: newId(), ...builtinDef(k, lang), mod: Date.now() }));
}
// Après un changement de langue : traduit les types intégrés restés intacts et le paquet par défaut
export function localizeDefaults(lang) {
  const other = lang === 'en' ? 'fr' : 'en';
  const sig = d => JSON.stringify([d.name, d.flds.map(f => f.name), d.tmpls.map(x => [x.name, x.qfmt, x.afmt])]);
  for (const nt of S.notetypes.values()) {
    if (!nt.builtin || !BUILTIN.fr[nt.builtin]) continue;
    const from = builtinDef(nt.builtin, other);
    if (sig(nt) !== sig(from)) continue;
    const to = builtinDef(nt.builtin, lang);
    Object.assign(nt, { name: uniqueNotetypeName(to.name, nt.id), flds: to.flds, tmpls: to.tmpls });
    if (to.mcq) nt.mcq = to.mcq; if (to.tf) nt.tf = to.tf;
    saveNotetype(nt);
  }
  const names = { fr: 'Par défaut', en: 'Default' };
  const d1 = S.decks.get(1);
  if (d1 && d1.name === names[other] && deckByName(names[lang], false) == null) renameDeck(1, names[lang]);
  const p1 = S.presets.get(1);
  if (p1 && p1.name === names[other]) { p1.name = names[lang]; persist.put('presets', p1); }
}

export function initCollection() {
  S.settings = structuredClone(DEFAULT_SETTINGS);
  S.settings.lang = getLang();
  S.meta = { nextPos: 1, lastUnbury: today(), created: Date.now() };
  const p = defaultPreset(); S.presets.set(p.id, p); persist.put('presets', p);
  const d = { id: 1, name: t('Par défaut'), conf: 1, desc: '', collapsed: false, mod: Date.now() };
  S.decks.set(1, d); persist.put('decks', d);
  for (const nt of builtinNotetypes()) { S.notetypes.set(nt.id, nt); persist.put('notetypes', nt); }
  S.settings.lastNotetype = [...S.notetypes.keys()][0];
  saveSettings(); saveMeta();
}
export const saveSettings = () => persist.putKV('settings', S.settings);
export const saveMeta = () => persist.putKV('meta', S.meta);

// ---------- paquets ----------
let treeCache = null;
export function invalidateDecks() { treeCache = null; }
function tree() {
  if (treeCache) return treeCache;
  const byName = new Map(), children = new Map(), parent = new Map();
  for (const d of S.decks.values()) byName.set(d.name, d.id);
  for (const d of S.decks.values()) {
    const i = d.name.lastIndexOf('::');
    const pid = i > 0 ? byName.get(d.name.slice(0, i)) : undefined;
    parent.set(d.id, pid ?? null);
    const key = pid ?? 0;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(d.id);
  }
  const coll = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });
  for (const arr of children.values()) arr.sort((a, b) => coll.compare(S.decks.get(a).name, S.decks.get(b).name));
  return treeCache = { byName, children, parent };
}
export const topDecks = () => tree().children.get(0) || [];
export const deckChildren = did => tree().children.get(did) || [];
export const deckParent = did => tree().parent.get(did) ?? null;
export function deckSubtree(did) {
  const out = [did];
  for (let i = 0; i < out.length; i++) out.push(...deckChildren(out[i]));
  return out;
}
export function deckAncestors(did) {
  const out = []; let p = deckParent(did);
  while (p != null) { out.push(p); p = deckParent(p); }
  return out;
}
export const deckLeaf = name => name.split('::').pop();
export const deckDepth = name => name.split('::').length - 1;
export function cleanDeckName(name) {
  return String(name).split('::').map(s => s.trim()).filter(Boolean).join('::') || t('Sans nom');
}
export function deckByName(name, create = true) {
  name = cleanDeckName(name);
  const id = tree().byName.get(name);
  if (id != null || !create) return id ?? null;
  const parts = name.split('::');
  let did = null;
  for (let i = 1; i <= parts.length; i++) {
    const sub = parts.slice(0, i).join('::');
    did = tree().byName.get(sub);
    if (did == null) {
      const d = { id: newId(), name: sub, conf: 1, desc: '', collapsed: false, mod: Date.now() };
      S.decks.set(d.id, d); persist.put('decks', d); invalidateDecks();
      did = d.id;
    }
  }
  return did;
}
export function saveDeck(d) { d.mod = Date.now(); persist.put('decks', d); invalidateDecks(); }
export function renameDeck(did, newName) {
  newName = cleanDeckName(newName);
  const d = S.decks.get(did); const old = d.name;
  if (old === newName) return;
  if (tree().byName.has(newName)) throw new Error(t('Un paquet porte déjà ce nom.'));
  for (const x of S.decks.values()) {
    if (x.name === old || x.name.startsWith(old + '::')) { x.name = newName + x.name.slice(old.length); saveDeck(x); }
  }
  invalidateDecks();
  const i = newName.lastIndexOf('::');
  if (i > 0) deckByName(newName.slice(0, i));
}
export function presetOf(did) {
  const d = S.decks.get(did);
  return S.presets.get(d?.conf) || S.presets.get(1) || S.presets.values().next().value;
}

// ---------- notes et cartes ----------
export function notetypeOf(note) { return S.notetypes.get(note.mid); }
export function fieldMap(note, nt = notetypeOf(note)) {
  const m = {};
  nt.flds.forEach((f, i) => { m[f.name] = note.flds[i] ?? ''; });
  return m;
}
export function sortText(note) {
  const nt = notetypeOf(note);
  return stripHtml(String(note.flds[nt?.sortf ?? 0] ?? note.flds[0] ?? '').replace(/\{\{c\d+::([\s\S]*?)(?:::[^}]*)?\}\}/g, '$1'));
}
export function noteCards(nid) {
  return [...(S.nc.get(nid) || [])].map(id => S.cards.get(id)).filter(Boolean);
}
function link(c) {
  if (!S.nc.has(c.nid)) S.nc.set(c.nid, new Set());
  S.nc.get(c.nid).add(c.id);
}
export function indexCards() { S.nc.clear(); for (const c of S.cards.values()) link(c); }

export function blankCard(nid, did, ord) {
  let id = newId();
  while (S.cards.has(id)) id = newId();
  return { id, nid, did, ord, type: 0, queue: 0, due: S.meta.nextPos++, ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0, flags: 0, s: null, d: null, lastRev: null, mod: Date.now() };
}
export function addCardObj(c) { S.cards.set(c.id, c); link(c); persist.put('cards', c); }
export function saveCard(c) { c.mod = Date.now(); persist.put('cards', c); }
export function saveNote(n) { n.mod = Date.now(); persist.put('notes', n); }

export function newNote(mid, flds = [], tags = []) {
  let id = newId();
  while (S.notes.has(id)) id = newId();
  return { id, guid: guid(), mid, flds, tags, mod: Date.now() };
}
// Ajoute une note et génère ses cartes ; renvoie le nombre de cartes créées
export function addNote(note, did) {
  S.notes.set(note.id, note); persist.put('notes', note);
  const n = genCards(note, did);
  saveMeta();
  return n;
}
export function genCards(note, did) {
  const nt = notetypeOf(note);
  const have = new Set(noteCards(note.id).map(c => c.ord));
  const existing = noteCards(note.id)[0];
  const deck = did ?? existing?.did ?? 1;
  let n = 0;
  for (const ord of cardOrdsFor(note, nt)) {
    if (have.has(ord)) continue;
    addCardObj(blankCard(note.id, deck, ord)); n++;
  }
  return n;
}
// Après modification : crée les cartes manquantes, supprime les cartes vides jamais révisées
export function updateNote(note) {
  saveNote(note);
  const nt = notetypeOf(note);
  const ords = new Set(cardOrdsFor(note, nt));
  for (const c of noteCards(note.id)) if (!ords.has(c.ord) && c.type === 0 && ords.size) deleteCard(c.id);
  const n = genCards(note);
  saveMeta();
  return n;
}
export function deleteCard(cid) {
  const c = S.cards.get(cid); if (!c) return;
  S.cards.delete(cid); S.nc.get(c.nid)?.delete(cid); persist.del('cards', cid);
}
export function deleteNotes(nids) {
  for (const nid of nids) {
    for (const c of noteCards(nid)) deleteCard(c.id);
    S.nc.delete(nid); S.notes.delete(nid); persist.del('notes', nid);
  }
}
export function deleteDeck(did) {
  const ids = new Set(deckSubtree(did));
  const touched = new Set();
  for (const c of [...S.cards.values()]) if (ids.has(c.did)) { touched.add(c.nid); deleteCard(c.id); }
  deleteNotes([...touched].filter(nid => !(S.nc.get(nid)?.size)));
  for (const id of ids) { if (id === 1) continue; S.decks.delete(id); persist.del('decks', id); }
  invalidateDecks();
}
export function addTags(note, tags) {
  const set = new Set(note.tags);
  let ch = false;
  for (const t of tags) if (t && !set.has(t)) { set.add(t); ch = true; }
  if (ch) { note.tags = [...set]; saveNote(note); }
}
export function removeTags(note, tags) {
  const low = new Set(tags.map(t => t.toLowerCase()));
  const nt = note.tags.filter(t => !low.has(t.toLowerCase()));
  if (nt.length !== note.tags.length) { note.tags = nt; saveNote(note); }
}
export function parseTags(s) { return String(s || '').split(/[\s,]+/).map(t => t.trim()).filter(Boolean); }
export function allTags() {
  const set = new Set();
  for (const n of S.notes.values()) for (const t of n.tags) set.add(t);
  return [...set].sort((a, b) => a.localeCompare(b, 'fr'));
}
export function findDuplicate(note) {
  const first = stripHtml(note.flds[0] || '').toLowerCase();
  if (!first) return null;
  for (const n of S.notes.values()) {
    if (n.id !== note.id && n.mid === note.mid && stripHtml(n.flds[0] || '').toLowerCase() === first) return n;
  }
  return null;
}
export function notesOfType(mid) { return [...S.notes.values()].filter(n => n.mid === mid); }
export function uniqueNotetypeName(base, exceptId = null) {
  const names = new Set([...S.notetypes.values()].filter(n => n.id !== exceptId).map(n => n.name));
  if (!names.has(base)) return base;
  let i = 2; while (names.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}
export function saveNotetype(nt) { nt.mod = Date.now(); persist.put('notetypes', nt); }
