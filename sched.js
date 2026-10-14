// Mnemo — planificateur (SM-2 façon Anki et FSRS-5), files d'étude et sessions
import { S, persist, presetOf, deckSubtree, deckChildren, deckAncestors, saveCard, saveDeck, saveMeta, noteCards, addTags, DEFAULT_W } from './state.js';
import { dayNumber, dayStart, today, hash32, rng, fmtIvl, shuffle } from './util.js';

// ---------- FSRS-5 ----------
const DECAY = -0.5, FACTOR = 19 / 81;
const clampD = d => Math.min(10, Math.max(1, d));
const W = p => (p.weights?.length >= 19 && p.weights.every(Number.isFinite)) ? p.weights : DEFAULT_W;
export const fsrs = {
  R: (t, s) => Math.pow(1 + FACTOR * t / s, DECAY),
  ivl: (s, r) => s / FACTOR * (Math.pow(r, 1 / DECAY) - 1),
  s0: (w, g) => Math.max(0.1, w[g - 1]),
  d0: (w, g) => clampD(w[4] - Math.exp(w[5] * (g - 1)) + 1),
  nextD(w, d, g) {
    const dp = d - w[6] * (g - 3) * (10 - d) / 9;
    return clampD(w[7] * fsrs.d0(w, 4) + (1 - w[7]) * dp);
  },
  sRecall(w, d, s, r, g) {
    const hard = g === 2 ? w[15] : 1, easy = g === 4 ? w[16] : 1;
    return s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9]) * (Math.exp(w[10] * (1 - r)) - 1) * hard * easy);
  },
  sForget(w, d, s, r) {
    const sf = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp(w[14] * (1 - r));
    return Math.min(sf, s / Math.exp(w[17] * w[18]));
  },
  sShort: (w, s, g) => s * Math.exp(w[17] * (g - 3 + w[18])),
};
const clampS = s => Math.min(36500, Math.max(0.1, s));

function step(mem, g, elapsed, w) {
  if (!mem) return { s: fsrs.s0(w, g), d: fsrs.d0(w, g) };
  let s;
  if (elapsed <= 0) s = fsrs.sShort(w, mem.s, g);
  else {
    const r = fsrs.R(elapsed, mem.s);
    s = g === 1 ? fsrs.sForget(w, mem.d, mem.s, r) : fsrs.sRecall(w, mem.d, mem.s, r, g);
  }
  return { s: clampS(s), d: fsrs.nextD(w, mem.d, g) };
}

// Reconstitue l'état mémoire à partir de l'historique (comme Anki lors du passage à FSRS)
export function memoryFromHistory(card, w = DEFAULT_W) {
  const logs = S.revlog.filter(l => l.cid === card.id).sort((a, b) => a.id - b.id);
  let mem = null, last = null;
  for (const l of logs) {
    if (l.ease === 0) { if (l.type === 4 && !l.ivl) { mem = null; last = null; } continue; }
    if (l.type === 3 || l.ease > 4) continue;
    mem = step(mem, l.ease, last == null ? 0 : dayNumber(l.id) - dayNumber(last), w);
    last = l.id;
  }
  if (mem) return { ...mem, lastRev: last };
  if (card.type === 2 || card.type === 3) {
    const f = (card.factor || 2500) / 1000;
    return { s: clampS(Math.max(1, card.ivl)), d: clampD(10 - (f - 1.3) / 2.2 * 9), lastRev: card.lastRev || dayStart(card.due - card.ivl) };
  }
  return null;
}
export function ensureMemory(card, p) {
  if (card.s != null && card.d != null) return;
  const m = memoryFromHistory(card, W(p));
  if (m) { card.s = m.s; card.d = m.d; card.lastRev ??= m.lastRev; }
}
export function retrievability(card, now = Date.now()) {
  if (card.s == null || !card.lastRev) return null;
  return fsrs.R(Math.max(0, dayNumber(now) - dayNumber(card.lastRev)), card.s);
}

// ---------- intervalles ----------
function fuzzRange(ivl) {
  if (ivl < 2.5) return [ivl, ivl];
  const delta = 1 + 0.15 * Math.max(0, Math.min(ivl, 7) - 2.5) + 0.1 * Math.max(0, Math.min(ivl, 20) - 7) + 0.05 * Math.max(0, ivl - 20);
  return [Math.max(2, Math.round(ivl - delta)), Math.round(ivl + delta)];
}
function fuzz(ivl, card, salt) {
  const [lo, hi] = fuzzRange(ivl);
  if (hi <= lo) return Math.round(ivl);
  const r = rng(hash32(card.id, card.reps, salt))();
  return lo + Math.floor(r * (hi - lo + 1));
}
const clampIvl = (x, p) => Math.max(1, Math.min(p.maxIvl || 36500, Math.round(x)));
const fsrsIvl = (s, p) => Math.max(1, Math.round(fsrs.ivl(s, Math.min(0.99, Math.max(0.7, p.retention || 0.9)))));

function reviewIntervals(card, elapsed, p) {
  let hard, good, easy;
  if (p.algo === 'fsrs') {
    const w = W(p);
    const mk = g => clampS(elapsed <= 0 ? fsrs.sShort(w, card.s, g) : fsrs.sRecall(w, card.d, card.s, fsrs.R(elapsed, card.s), g));
    hard = fsrsIvl(mk(2), p); good = fsrsIvl(mk(3), p); easy = fsrsIvl(mk(4), p);
  } else {
    const ivl = Math.max(1, card.ivl || 1), fct = (card.factor || 2500) / 1000, mod = p.ivlMod || 1;
    const delay = elapsed - ivl;
    if (delay >= 0) {
      hard = p.hardIvl > 1 ? Math.max(ivl + 1, ivl * p.hardIvl * mod) : ivl * p.hardIvl * mod;
      good = Math.max(hard + 1, (ivl + delay / 2) * fct * mod);
      easy = Math.max(good + 1, (ivl + delay) * fct * p.easyBonus * mod);
    } else {
      const base = Math.max(1, elapsed);
      hard = Math.max(1, base * p.hardIvl * mod);
      good = Math.max(hard + 1, base * fct * mod, Math.min(ivl, base * 1.2));
      easy = Math.max(good + 1, base * fct * p.easyBonus * mod);
    }
  }
  hard = clampIvl(fuzz(hard, card, 2), p);
  good = clampIvl(fuzz(good, card, 3), p);
  easy = clampIvl(fuzz(easy, card, 4), p);
  if (p.algo === 'fsrs') hard = Math.min(hard, good);
  good = Math.min(p.maxIvl || 36500, Math.max(good, hard + 1));
  easy = Math.min(p.maxIvl || 36500, Math.max(easy, good + 1));
  return { 2: hard, 3: good, 4: easy };
}

function setLearn(c, minutes, now, day) {
  if (minutes >= 1440) { c.queue = 3; c.due = day + Math.max(1, Math.round(minutes / 1440)); }
  else { c.queue = 1; c.due = now + Math.round(minutes * 60000); }
}

// Calcule l'état d'une carte après une réponse (fonction pure)
export function computeAnswer(card, ease, now, p) {
  const c = { ...card };
  const day = dayNumber(now);
  const isFsrs = p.algo === 'fsrs';
  const w = W(p);
  const prevType = card.type;
  const lastDay = card.lastRev ? dayNumber(card.lastRev) : (card.type === 2 ? card.due - card.ivl : day);
  const elapsed = Math.max(0, day - lastDay);
  if (isFsrs) {
    const prior = card.type === 0 ? null : (card.s != null && card.d != null ? { s: card.s, d: card.d } : memoryFromHistory(card, w));
    const m = step(prior, ease, prior ? elapsed : 0, w);
    c.s = m.s; c.d = m.d;
  }
  c.reps = (card.reps || 0) + 1;
  c.lastRev = now;
  let leech = false;
  if (card.type === 0) { c.type = 1; c.step = 0; c.factor = Math.round((p.startEase || 2.5) * 1000); }

  if (c.type === 1 || c.type === 3) {
    const relearn = c.type === 3;
    const steps = (relearn ? p.relearnSteps : p.learnSteps) || [];
    const i = Math.min(c.step || 0, Math.max(0, steps.length - 1));
    const graduate = easy => {
      c.type = 2; c.queue = 2; c.step = 0;
      let ivl;
      if (isFsrs) ivl = fsrsIvl(c.s, p);
      else if (relearn) ivl = Math.max(p.minIvl || 1, c.ivl || 1) + (easy ? 1 : 0);
      else ivl = easy ? Math.max(p.easyIvl, p.gradIvl + 1) : p.gradIvl;
      if (isFsrs && easy && !relearn) {
        const goodIvl = fsrsIvl(step(null, 3, 0, w).s, p);
        ivl = Math.max(ivl, goodIvl + 1);
      }
      c.ivl = clampIvl(fuzz(ivl, card, easy ? 4 : 3), p);
      c.due = day + c.ivl;
    };
    if (ease === 1) { c.step = 0; setLearn(c, steps[0] ?? 1, now, day); }
    else if (ease === 4) graduate(true);
    else if (ease === 2) {
      const s0 = steps[0] ?? 1;
      const delay = i === 0 ? (steps.length > 1 ? (steps[0] + steps[1]) / 2 : Math.min(s0 * 1.5, s0 + 1440)) : steps[i];
      c.step = i; setLearn(c, delay, now, day);
    } else if (i + 1 < steps.length) { c.step = i + 1; setLearn(c, steps[i + 1], now, day); }
    else graduate(false);
  } else {
    if (ease === 1) {
      c.lapses = (card.lapses || 0) + 1;
      if (!isFsrs) c.factor = Math.max(1300, (card.factor || 2500) - 200);
      c.ivl = isFsrs ? clampIvl(fsrsIvl(c.s, p), p) : Math.max(p.minIvl || 1, Math.round((card.ivl || 1) * (p.lapseMult || 0)));
      const t = p.leechThreshold || 0;
      if (t > 0 && c.lapses >= t && (c.lapses - t) % Math.max(1, Math.ceil(t / 2)) === 0) leech = true;
      if (p.relearnSteps?.length) { c.type = 3; c.step = 0; setLearn(c, p.relearnSteps[0], now, day); }
      else { c.type = 2; c.queue = 2; c.due = day + c.ivl; }
    } else {
      const mem = isFsrs ? (card.s != null ? card : { ...card, ...memoryFromHistory(card, w) }) : card;
      const ivls = reviewIntervals(mem, elapsed, p);
      if (!isFsrs) c.factor = Math.max(1300, (card.factor || 2500) + (ease === 2 ? -150 : ease === 4 ? 150 : 0));
      c.ivl = ivls[ease]; c.type = 2; c.queue = 2; c.due = day + c.ivl;
    }
  }
  const log = {
    id: now, cid: card.id, ease,
    ivl: c.queue === 1 ? -Math.round((c.due - now) / 1000) : c.ivl,
    lastIvl: prevType === 2 ? card.ivl : (card.queue === 1 ? -Math.round(((p.learnSteps?.[card.step] ?? 1) * 60)) : 0),
    factor: c.factor || 0, time: 0,
    type: prevType === 0 || prevType === 1 ? 0 : prevType === 2 ? 1 : 2,
  };
  return { card: c, log, leech };
}

// Durée (en jours, fractionnaire) jusqu'à la prochaine échéance pour chaque bouton
export function previewIntervals(card, now = Date.now()) {
  const p = presetOf(card.did);
  const out = {};
  for (const e of [1, 2, 3, 4]) {
    const { card: c } = computeAnswer(card, e, now, p);
    out[e] = c.queue === 1 ? (c.due - now) / 864e5 : (c.due - dayNumber(now));
  }
  return out;
}
export const ivlLabel = days => fmtIvl(days);

// ---------- application d'une réponse ----------
let lastLogId = 0;
function logId(now) { let id = Math.max(now, lastLogId + 1); for (const l of S.revlog.slice(-3)) if (l.id >= id) id = l.id + 1; lastLogId = id; return id; }

function bump(did, kind, delta) {
  const day = today();
  for (const id of [did, ...deckAncestors(did)]) {
    const d = S.decks.get(id); if (!d) continue;
    if (d.today?.day !== day) d.today = { day, new: 0, rev: 0 };
    d.today[kind] = (d.today[kind] || 0) + delta;
    saveDeck(d);
  }
}
export function studiedToday(did, kind) {
  const d = S.decks.get(did);
  return d?.today?.day === today() ? (d.today[kind] || 0) : 0;
}
export function extendLimit(did, kind, n) { bump(did, kind, -n); }

export function applyAnswer(card, ease, timeMs, now = Date.now()) {
  const p = presetOf(card.did);
  if (p.algo === 'fsrs' && card.type !== 0) ensureMemory(card, p);
  const before = { ...card };
  const { card: nc, log, leech } = computeAnswer(card, ease, now, p);
  log.id = logId(now); log.time = Math.max(0, Math.min(Math.round(timeMs || 0), 60000));
  const note = S.notes.get(card.nid);
  const undo = { card: before, logId: log.id, kind: null, buried: [], tags: null };
  if (leech && note) {
    undo.tags = note.tags.slice();
    addTags(note, ['leech']);
    if (p.leechAction === 'suspend') nc.queue = -1;
  }
  Object.assign(card, nc); saveCard(card);
  S.revlog.push(log); persist.put('revlog', log);
  const kind = before.type === 0 ? 'new' : (before.queue === 2 || before.queue === 3) ? 'rev' : null;
  if (kind) { bump(card.did, kind, 1); undo.kind = kind; }
  if (p.buryNew || p.buryRev) {
    for (const sib of noteCards(card.nid)) {
      if (sib.id === card.id) continue;
      if ((sib.queue === 0 && p.buryNew) || ((sib.queue === 2 || sib.queue === 3) && p.buryRev)) {
        undo.buried.push({ id: sib.id, queue: sib.queue }); sib.queue = -2; saveCard(sib);
      }
    }
  }
  return { undo, leech };
}
export function undoAnswer(u) {
  const card = S.cards.get(u.card.id); if (!card) return null;
  Object.assign(card, u.card); saveCard(card);
  const i = S.revlog.findIndex(l => l.id === u.logId);
  if (i >= 0) S.revlog.splice(i, 1);
  persist.del('revlog', u.logId);
  if (u.kind) bump(card.did, u.kind, -1);
  for (const b of u.buried) { const s = S.cards.get(b.id); if (s) { s.queue = b.queue; saveCard(s); } }
  if (u.tags) { const n = S.notes.get(card.nid); if (n) { n.tags = u.tags; persist.put('notes', n); } }
  return card;
}

// ---------- états manuels ----------
export function restoreQueue(c) {
  c.queue = c.type === 0 ? 0 : c.type === 2 ? 2 : (c.due > 1e10 ? 1 : 3);
}
export function unburyIfNewDay() {
  const day = today();
  if (S.meta.lastUnbury === day) return;
  for (const c of S.cards.values()) if (c.queue === -2 || c.queue === -3) { restoreQueue(c); saveCard(c); }
  S.meta.lastUnbury = day; saveMeta();
}
export function setSuspended(cards, on) {
  for (const c of cards) {
    if (on && c.queue !== -1) { c.queue = -1; saveCard(c); }
    else if (!on && c.queue === -1) { restoreQueue(c); saveCard(c); }
  }
}
export function bury(cards) { for (const c of cards) if (c.queue >= 0) { c.queue = -3; saveCard(c); } }
export function forget(cards) {
  const now = Date.now();
  for (const c of cards) {
    Object.assign(c, { type: 0, queue: 0, due: S.meta.nextPos++, ivl: 0, factor: 0, reps: 0, lapses: 0, step: 0, s: null, d: null, lastRev: null });
    saveCard(c);
    const log = { id: logId(now), cid: c.id, ease: 0, ivl: 0, lastIvl: 0, factor: 0, time: 0, type: 4 };
    S.revlog.push(log); persist.put('revlog', log);
  }
  saveMeta();
}
export function setFlag(cards, f) { for (const c of cards) { c.flags = (c.flags & ~7) | (f & 7); saveCard(c); } }
export function recomputeMemory(presetId) {
  const p = S.presets.get(presetId); let n = 0;
  const decks = new Set([...S.decks.values()].filter(d => d.conf === presetId).map(d => d.id));
  for (const c of S.cards.values()) {
    if (!decks.has(c.did) || c.type === 0) continue;
    const m = memoryFromHistory(c, W(p));
    if (m) { c.s = m.s; c.d = m.d; c.lastRev = m.lastRev; saveCard(c); n++; }
  }
  return n;
}

// ---------- files d'attente ----------
function indexByDeck(day) {
  const idx = new Map();
  const get = did => { if (!idx.has(did)) idx.set(did, { new: [], rev: [], lrn: [] }); return idx.get(did); };
  for (const c of S.cards.values()) {
    if (c.queue === 0) get(c.did).new.push(c);
    else if ((c.queue === 2 || c.queue === 3) && c.due <= day) get(c.did).rev.push(c);
    else if (c.queue === 1) get(c.did).lrn.push(c);
  }
  return idx;
}
function sortNew(arr, p, day) {
  if (p.newOrder === 'random') return arr.sort((a, b) => hash32(a.id, day) - hash32(b.id, day));
  return arr.sort((a, b) => a.due - b.due || a.ord - b.ord || a.id - b.id);
}
function sortRev(arr, p, day) {
  const r = c => hash32(c.id, day);
  if (p.revOrder === 'random') return arr.sort((a, b) => r(a) - r(b));
  if (p.revOrder === 'retrievability') {
    const now = Date.now();
    const R = c => retrievability(c, now) ?? (1 - 1 / (1 + Math.max(0, c.ivl - (day - c.due))));
    return arr.sort((a, b) => R(a) - R(b) || r(a) - r(b));
  }
  if (p.revOrder === 'ivl') return arr.sort((a, b) => a.ivl - b.ivl || r(a) - r(b));
  return arr.sort((a, b) => a.due - b.due || r(a) - r(b));
}
function gather(rootDid, kind, day, idx) {
  const out = [];
  const rec = (did, parentRem) => {
    const p = presetOf(did);
    const lim = (kind === 'new' ? p.newPerDay : p.revPerDay) - studiedToday(did, kind);
    const rem = Math.max(0, Math.min(parentRem, lim));
    let taken = 0;
    const own = idx.get(did)?.[kind] || [];
    if (rem > 0 && own.length) {
      const sorted = kind === 'new' ? sortNew(own.slice(), p, day) : sortRev(own.slice(), p, day);
      for (const c of sorted) { if (taken >= rem) break; out.push(c); taken++; }
    }
    for (const ch of deckChildren(did)) { if (taken >= rem) break; taken += rec(ch, rem - taken); }
    return taken;
  };
  rec(rootDid, Infinity);
  return out;
}
function interleave(revs, news, mode) {
  if (mode === 'newFirst') return [...news, ...revs];
  if (mode === 'reviewFirst' || !news.length) return [...revs, ...news];
  if (!revs.length) return news;
  const total = revs.length + news.length;
  const pos = new Set(news.map((_, k) => Math.floor((k + 0.5) * total / news.length)));
  const out = []; let ri = 0, ni = 0;
  for (let i = 0; i < total; i++) out.push(pos.has(i) && ni < news.length ? news[ni++] : (ri < revs.length ? revs[ri++] : news[ni++]));
  return out;
}

export function deckCounts() {
  unburyIfNewDay();
  const day = today(), end = dayStart(day + 1);
  const idx = indexByDeck(day);
  const res = new Map();
  const lrnCount = did => deckSubtree(did).reduce((n, id) => n + (idx.get(id)?.lrn.filter(c => c.due < end).length || 0), 0);
  for (const did of S.decks.keys()) {
    res.set(did, { new: gather(did, 'new', day, idx).length, rev: gather(did, 'rev', day, idx).length, learn: lrnCount(did) });
  }
  return res;
}

export class Session {
  constructor({ did = null, cids = null, cram = false, title = '' } = {}) {
    this.did = did; this.cram = cram; this.title = title;
    this.cids = cids ? new Set(cids) : null;
    this.scope = did != null ? new Set(deckSubtree(did)) : null;
    this.undoStack = []; this.done = 0; this.again = 0; this.started = Date.now(); this.time = 0;
    this.build();
  }
  inScope(c) { return this.cids ? this.cids.has(c.id) : this.scope.has(c.did); }
  build() {
    unburyIfNewDay();
    const day = today(); this.day = day;
    if (this.cram) {
      this.queue = [...this.cids].filter(id => { const c = S.cards.get(id); return c && c.queue !== -1; });
      return;
    }
    if (this.cids) {
      const cs = [...this.cids].map(id => S.cards.get(id)).filter(c => c && (c.queue === 0 || c.queue === 2 || c.queue === 3));
      const p = presetOf(cs[0]?.did ?? 1);
      this.main = interleave(sortRev(cs.filter(c => c.queue !== 0), p, day), sortNew(cs.filter(c => c.queue === 0), p, day), p.mix).map(c => c.id);
      return;
    }
    const idx = indexByDeck(day); const p = presetOf(this.did);
    const revs = sortRev(gather(this.did, 'rev', day, idx), p, day);
    const news = gather(this.did, 'new', day, idx);
    this.main = interleave(revs, news, p.mix).map(c => c.id);
  }
  learning() {
    const out = [];
    for (const c of S.cards.values()) if (c.queue === 1 && this.inScope(c)) out.push(c);
    return out.sort((a, b) => a.due - b.due);
  }
  valid(c) {
    if (!c) return false;
    if (this.cids && !this.cram) return c.queue === 0 || c.queue === 2 || c.queue === 3;
    return c.queue === 0 || ((c.queue === 2 || c.queue === 3) && c.due <= this.day);
  }
  next(now = Date.now()) {
    if (this.cram) return S.cards.get(this.queue[0]) || null;
    if (today() !== this.day) this.build();
    const lrn = this.learning();
    if (lrn.length && lrn[0].due <= now) return lrn[0];
    while (this.main.length) {
      const c = S.cards.get(this.main[0]);
      if (this.valid(c)) return c;
      this.main.shift();
    }
    if (lrn.length && lrn[0].due <= now + (S.settings.learnAhead ?? 20) * 60000) return lrn[0];
    return null;
  }
  nextLearningDue() { const l = this.learning(); return l.length ? l[0].due : null; }
  counts() {
    if (this.cram) return { new: 0, learn: 0, rev: this.queue.length };
    const end = dayStart(this.day + 1);
    let n = 0, r = 0;
    for (const id of this.main) { const c = S.cards.get(id); if (!this.valid(c)) continue; if (c.queue === 0) n++; else r++; }
    return { new: n, learn: this.learning().filter(c => c.due < end).length, rev: r };
  }
  kindOf(c) { return this.cram ? 'rev' : c.queue === 0 ? 'new' : c.queue === 1 ? 'learn' : 'rev'; }
  answer(card, ease, timeMs) {
    this.done++; this.time += timeMs || 0; if (ease === 1) this.again++;
    if (this.cram) {
      const prev = this.queue.slice();
      this.queue.shift();
      if (ease === 1) this.queue.splice(Math.min(this.queue.length, 3), 0, card.id);
      else if (ease === 2) this.queue.splice(Math.min(this.queue.length, 8), 0, card.id);
      this.undoStack.push({ cram: prev, ease, timeMs });
      return {};
    }
    const idx = this.main.indexOf(card.id);
    const r = applyAnswer(card, ease, timeMs);
    if (idx >= 0) this.main.splice(idx, 1);
    this.undoStack.push({ ...r.undo, idx, ease, timeMs });
    return r;
  }
  canUndo() { return this.undoStack.length > 0; }
  undo() {
    const u = this.undoStack.pop(); if (!u) return null;
    this.done--; this.time -= u.timeMs || 0; if (u.ease === 1) this.again--;
    if (u.cram) { this.queue = u.cram; return S.cards.get(this.queue[0]); }
    const card = undoAnswer(u);
    if (u.idx >= 0) this.main.splice(u.idx, 0, u.card.id);
    return card;
  }
}

export function shuffledIds(ids) { return shuffle(ids.slice()); }
