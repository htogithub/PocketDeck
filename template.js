// Mnemo — moteur de modèles compatible Anki (+ QCM et vrai/faux)
import { S } from './state.js';
import { esc, stripHtml, rng, shuffle } from './util.js';
import { t } from './i18n.js';

// ---------- analyse des modèles {{...}} ----------
const astCache = new Map();
export function parseTemplate(src) {
  if (astCache.has(src)) return astCache.get(src);
  const root = { children: [] }; const stack = [root];
  const re = /\{\{([\s\S]*?)\}\}/g; let last = 0, m;
  while ((m = re.exec(src))) {
    const cur = stack[stack.length - 1];
    if (m.index > last) cur.children.push({ t: 'text', v: src.slice(last, m.index) });
    last = re.lastIndex;
    const tag = m[1].trim();
    if (tag[0] === '#' || tag[0] === '^') {
      const node = { t: 'sec', inv: tag[0] === '^', key: tag.slice(1).trim(), children: [] };
      cur.children.push(node); stack.push(node);
    } else if (tag[0] === '/') {
      const key = tag.slice(1).trim();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].key === key) { stack.length = i; break; }
    } else if (tag[0] !== '!') cur.children.push({ t: 'var', v: tag });
  }
  if (last < src.length) stack[stack.length - 1].children.push({ t: 'text', v: src.slice(last) });
  if (astCache.size > 300) astCache.clear();
  astCache.set(src, root.children);
  return root.children;
}

const nonEmpty = v => !!(stripHtml(v) || /<(img|audio|video|svg|object)\b|\[sound:/i.test(v || ''));

function special(name, ctx) {
  switch (name) {
    case 'Tags': return esc((ctx.tags || []).join(' '));
    case 'Type': return esc(ctx.nt?.name || '');
    case 'Deck': return esc(ctx.deck || '');
    case 'Subdeck': return esc((ctx.deck || '').split('::').pop());
    case 'Card': return esc(ctx.tmplName || '');
    case 'CardFlag': return ctx.flag ? 'flag' + ctx.flag : '';
    case 'CardID': return String(ctx.card?.id ?? '');
  }
  return undefined;
}

export function renderAst(nodes, ctx) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.v;
    else if (n.t === 'sec') {
      const v = ctx.fields[n.key] ?? special(n.key, ctx) ?? '';
      if (nonEmpty(v) !== n.inv) out += renderAst(n.children, ctx);
    } else out += renderVar(n.v, ctx);
  }
  return out;
}

function renderVar(tag, ctx) {
  const parts = tag.split(':');
  const name = parts.pop().trim();
  const filters = parts.map(s => s.trim().toLowerCase());
  if (name === 'FrontSide') return ctx.frontSide ?? '';
  let val = ctx.fields[name];
  if (val === undefined) {
    val = special(name, ctx);
    if (val === undefined) return `<span class="mn-err">{{${esc(tag)}}} : ${t('champ introuvable')}</span>`;
    return val;
  }
  if (filters.includes('type')) return typeFilter(val, filters, ctx);
  for (let i = filters.length - 1; i >= 0; i--) val = applyFilter(filters[i], val, ctx);
  return val;
}

function applyFilter(f, val, ctx) {
  if (f.startsWith('tts')) return val;
  switch (f) {
    case 'text': return esc(stripHtml(val));
    case 'cloze': return renderCloze(val, (ctx.ord ?? 0) + 1, ctx.side);
    case 'cloze-only': return esc(clozeOnly(val, (ctx.ord ?? 0) + 1));
    case 'hint': return nonEmpty(val) ? `<a class="hint" href="#" data-mn-hint>${t('Indice')}</a><div class="hint-body" hidden>${val}</div>` : '';
    case 'furigana': return val.replace(/ ?([^ >]+?)\[(.+?)\]/g, '<ruby><rb>$1</rb><rt>$2</rt></ruby>');
    case 'kana': return val.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$2');
    case 'kanji': return val.replace(/ ?([^ >]+?)\[(.+?)\]/g, '$1');
    case 'mcq': return renderMcq(val, ctx);
    case 'tf': return renderTf(val, ctx);
    default: return val;
  }
}

function typeFilter(val, filters, ctx) {
  if (ctx.inFront) return '';
  const expected = filters.includes('cloze') ? clozeOnly(val, (ctx.ord ?? 0) + 1) : stripHtml(val);
  ctx.out.typeExpected = expected;
  if (ctx.side === 'q') return '<input class="mn-typein" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="' + esc(t('Votre réponse')) + '">';
  return '<div class="mn-typecmp"></div>';
}

// ---------- texte à trous (imbrication supportée) ----------
function clozeTree(text) {
  const root = { kids: [] }; const stack = [root];
  const re = /\{\{c(\d+)::|\}\}/g; let last = 0, m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m.index > last) top.kids.push(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[1] !== undefined) { const node = { n: +m[1], kids: [], start: m.index }; top.kids.push(node); stack.push(node); }
    else if (stack.length > 1) stack.pop();
    else top.kids.push('}}');
  }
  if (last < text.length) stack[stack.length - 1].kids.push(text.slice(last));
  return root.kids;
}
function splitHint(node) {
  const kids = node.kids.slice();
  for (let i = kids.length - 1; i >= 0; i--) {
    if (typeof kids[i] === 'string' && kids[i].includes('::')) {
      const j = kids[i].indexOf('::');
      const hint = kids[i].slice(j + 2) + kids.slice(i + 1).map(k => typeof k === 'string' ? k : '').join('');
      kids[i] = kids[i].slice(0, j); kids.length = i + 1;
      return { kids, hint };
    }
  }
  return { kids, hint: '' };
}
function mathRanges(text) {
  const out = []; const re = /\\\(([\s\S]*?)\\\)|\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g; let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}
export function clozeNumbers(text) {
  const set = new Set();
  const walk = kids => { for (const k of kids) if (typeof k !== 'string') { set.add(k.n); walk(k.kids); } };
  walk(clozeTree(text || ''));
  return set;
}
export function clozeOnly(text, ord) {
  const out = [];
  const flat = kids => kids.map(k => typeof k === 'string' ? k : flat(splitHint(k).kids)).join('');
  const walk = kids => { for (const k of kids) if (typeof k !== 'string') { if (k.n === ord) out.push(stripHtml(flat(splitHint(k).kids))); else walk(k.kids); } };
  walk(clozeTree(text || ''));
  return out.join(', ');
}
export function renderCloze(text, ord, side) {
  const ranges = mathRanges(text || '');
  const inMath = i => ranges.some(([a, b]) => i > a && i < b);
  const render = kids => kids.map(k => typeof k === 'string' ? k : node(k)).join('');
  function node(k) {
    const { kids, hint } = splitHint(k);
    const inner = render(kids);
    const math = inMath(k.start);
    if (k.n !== ord) return math ? inner : `<span class="cloze-inactive" data-ordinal="${k.n}">${inner}</span>`;
    if (side === 'q') {
      if (math) return hint ? `\\htmlClass{cloze}{[\\text{${hint}}]}` : '\\htmlClass{cloze}{[\\dots]}';
      return `<span class="cloze" data-ordinal="${k.n}">[${hint ? esc(stripHtml(hint)) : '...'}]</span>`;
    }
    return math ? `\\htmlClass{cloze}{${inner}}` : `<span class="cloze" data-ordinal="${k.n}">${inner}</span>`;
  }
  return render(clozeTree(text || ''));
}

// ---------- réponse à taper : comparaison caractère par caractère ----------
export function compareTyped(typed, expected) {
  typed = (typed || '').trim(); expected = (expected || '').trim();
  if (!typed) return `<code class="typeans"><span class="typeMissed">${esc(expected)}</span></code>`;
  if (typed === expected) return `<code class="typeans"><span class="typeGood">${esc(expected)}</span></code>`;
  const a = [...typed], b = [...expected];
  if (a.length * b.length > 250000) return `<code class="typeans"><span class="typeBad">${esc(typed)}</span><br><span class="typearrow">↓</span><br>${esc(expected)}</code>`;
  const n = a.length, m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  let i = 0, j = 0; const top = [], bot = [];
  const push = (arr, cls, ch) => { const last = arr[arr.length - 1]; if (last && last.c === cls) last.s += ch; else arr.push({ c: cls, s: ch }); };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(top, 'typeGood', a[i]); push(bot, 'typeGood', b[j]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { push(top, 'typeBad', a[i]); i++; }
    else { push(top, 'typeMissed', '-'); push(bot, 'typeMissed', b[j]); j++; }
  }
  while (i < n) push(top, 'typeBad', a[i++]);
  while (j < m) { push(top, 'typeMissed', '-'); push(bot, 'typeMissed', b[j++]); }
  const s = arr => arr.map(x => `<span class="${x.c}">${esc(x.s)}</span>`).join('');
  return `<code class="typeans">${s(top)}<br><span class="typearrow">↓</span><br>${s(bot)}</code>`;
}

// ---------- QCM ----------
const LABEL = /^\s*(?:[A-Za-z]|\d{1,2})\s*[).:]\s+/;
export function parseChoices(html) {
  let parts = String(html || '')
    .split(/<br\s*\/?>|\n|<\/div>\s*<div[^>]*>|<\/?div[^>]*>|<\/p>\s*<p[^>]*>|<\/?p>|<\/li>\s*<li[^>]*>|<\/?(?:ul|ol|li)[^>]*>/i)
    .map(s => s.trim()).filter(s => stripHtml(s) || /<img/i.test(s));
  const marked = new Set();
  parts = parts.map((p, i) => {
    let m = p.match(/^(?:\*|\[[xX]\])\s*/);
    if (m) { marked.add(i); return p.slice(m[0].length); }
    m = p.match(/^\[ \]\s*/);
    return m ? p.slice(m[0].length) : p;
  });
  if (parts.length > 1 && parts.every(p => LABEL.test(p))) parts = parts.map(p => p.replace(LABEL, ''));
  return { options: parts, marked };
}
export function parseAnswer(ans, options, marked = new Set()) {
  const t = stripHtml(ans).trim();
  const set = new Set();
  if (!t) return new Set(marked);
  const n = options.length;
  if (/^[A-Za-z](\s*[,;/ ]\s*[A-Za-z])*$/.test(t) || (/^[A-Za-z]+$/.test(t) && t.length <= n && !options.some(o => stripHtml(o).toLowerCase() === t.toLowerCase()))) {
    for (const ch of t.replace(/[^A-Za-z]/g, '').toUpperCase()) { const k = ch.charCodeAt(0) - 65; if (k >= 0 && k < n) set.add(k); }
    if (set.size) return set;
  }
  if (/^\d+(\s*[,;/ ]\s*\d+)*$/.test(t)) {
    for (const x of t.split(/[^\d]+/)) { const k = +x - 1; if (k >= 0 && k < n) set.add(k); }
    if (set.size) return set;
  }
  const norm = s => stripHtml(s).toLowerCase().replace(/\s+/g, ' ').trim();
  const wanted = t.split(/\s*(?:\||;|\n)\s*/).map(s => s.toLowerCase());
  options.forEach((o, i) => { if (wanted.includes(norm(o))) set.add(i); });
  if (!set.size) options.forEach((o, i) => { if (norm(o) === t.toLowerCase()) set.add(i); });
  return set.size ? set : new Set(marked);
}
export function parseBool(v) {
  const t = stripHtml(v).toLowerCase().trim();
  if (/^(vrai|v|true|t|1|oui|o|yes|y|wahr|richtig|r|w|juste|correct)$/.test(t)) return true;
  if (/^(faux|f|false|0|non|n|no|falsch|incorrect)$/.test(t)) return false;
  return null;
}
const setsEqual = (a, b) => a.size === b.size && [...a].every(x => b.has(x));

function renderMcq(val, ctx) {
  const nt = ctx.nt; const st = ctx.st;
  const ansField = nt?.mcq?.answer || 'Réponse';
  const { options, marked } = parseChoices(val);
  if (!options.length) return `<div class="mn-err">${t('Aucun choix défini')}</div>`;
  const correct = parseAnswer(ctx.fields[ansField] ?? '', options, marked);
  if (!st.order || st.order.length !== options.length) {
    st.order = options.map((_, i) => i);
    if (nt?.mcq?.shuffle !== false) shuffle(st.order, rng(st.seed ?? 1));
  }
  st.selected ??= new Set();
  st.correct = correct; st.multi = correct.size > 1;
  const answered = ctx.side === 'a' || ctx.inFront;
  let html = !answered && st.multi ? `<div class="mn-multi">${t('Plusieurs réponses possibles')}</div>` : '';
  html += `<div class="mn-mcq${answered ? ' is-answered' : ''}" data-multi="${st.multi ? 1 : 0}">`;
  st.order.forEach((oi, k) => {
    const cls = ['mn-opt'];
    const sel = st.selected.has(oi);
    if (sel) cls.push('is-selected');
    if (answered) { if (correct.has(oi)) cls.push('is-correct'); else if (sel) cls.push('is-wrong'); }
    html += `<button type="button" class="${cls.join(' ')}" data-opt="${oi}"><span class="mn-key">${String.fromCharCode(65 + k)}</span><span class="mn-txt">${options[oi]}</span></button>`;
  });
  html += '</div>';
  if (answered && !ctx.inFront) {
    if (!correct.size) html += `<div class="mn-err">${t('Bonne réponse non définie (champ « {f} »)', { f: esc(ansField) })}</div>`;
    else if (st.selected.size) {
      st.verdict = setsEqual(st.selected, correct);
      html += `<div class="mn-verdict ${st.verdict ? 'ok' : 'ko'}">${t(st.verdict ? 'Bonne réponse' : 'Mauvaise réponse')}</div>`;
    }
  }
  return html;
}

function renderTf(val, ctx) {
  const st = ctx.st; const truth = parseBool(val);
  st.selected ??= new Set(); st.correct = truth == null ? new Set() : new Set([truth ? 1 : 0]);
  const answered = ctx.side === 'a' || ctx.inFront;
  const btn = (v, label) => {
    const cls = ['mn-tfb'];
    const sel = st.selected.has(v);
    if (sel) cls.push('is-selected');
    if (answered && truth != null) { if ((v === 1) === truth) cls.push('is-correct'); else if (sel) cls.push('is-wrong'); }
    return `<button type="button" class="${cls.join(' ')}" data-tf="${v}">${label}</button>`;
  };
  let html = `<div class="mn-tf${answered ? ' is-answered' : ''}">${btn(1, t('Vrai'))}${btn(0, t('Faux'))}</div>`;
  if (answered && !ctx.inFront) {
    if (truth == null) html += `<div class="mn-err">${t('Réponse non reconnue : écrivez « Vrai » ou « Faux »')}</div>`;
    else if (st.selected.size) {
      st.verdict = st.selected.has(truth ? 1 : 0);
      html += `<div class="mn-verdict ${st.verdict ? 'ok' : 'ko'}">${t(st.verdict ? 'Bonne réponse' : 'Mauvaise réponse')} — ${t(truth ? "c'est vrai" : "c'est faux")}</div>`;
    } else html += `<div class="mn-verdict">${t(truth ? "C'est vrai" : "C'est faux")}</div>`;
  }
  return html;
}

// ---------- rendu d'une carte ----------
export function templateFor(card, nt) {
  return nt.kind === 'cloze' ? nt.tmpls[0] : (nt.tmpls[card.ord] || nt.tmpls[0]);
}
export function renderCard(card, side, st = {}, noteOverride = null) {
  const note = noteOverride || S.notes.get(card.nid);
  const nt = note._nt || S.notetypes.get(note.mid);
  const tmpl = templateFor(card, nt);
  const fields = {};
  nt.flds.forEach((f, i) => { fields[f.name] = note.flds[i] ?? ''; });
  const out = {};
  const base = { fields, nt, card, ord: card.ord, tags: note.tags, deck: S.decks.get(card.did)?.name || '', tmplName: tmpl?.name, flag: card.flags & 7, st, out };
  if (!tmpl) return { html: `<div class="mn-err">${t('Modèle de carte manquant')}</div>`, css: nt.css, out };
  const q = renderAst(parseTemplate(tmpl.qfmt), { ...base, side: 'q' });
  if (side === 'q') return { html: q, css: nt.css, out };
  const front = renderAst(parseTemplate(tmpl.qfmt), { ...base, side: 'q', inFront: true, out: {} });
  const a = renderAst(parseTemplate(tmpl.afmt), { ...base, side: 'a', frontSide: `<span class="mn-front">${front}</span>` });
  return { html: a, css: nt.css, out };
}

// Quelles cartes une note doit produire (règle d'Anki : le recto doit contenir un champ non vide)
export function cardOrdsFor(note, nt) {
  if (!nt) return [];
  const fields = {};
  nt.flds.forEach((f, i) => { fields[f.name] = note.flds[i] ?? ''; });
  if (nt.kind === 'cloze') {
    const set = new Set();
    for (const v of Object.values(fields)) for (const n of clozeNumbers(v)) if (n > 0) set.add(n - 1);
    return [...set].sort((a, b) => a - b);
  }
  const empty = {}; for (const k in fields) empty[k] = '';
  const ords = [];
  nt.tmpls.forEach((t, ord) => {
    const ast = parseTemplate(t.qfmt);
    const mk = f => ({ fields: f, nt, ord, side: 'q', st: { seed: 1 }, out: {}, tags: note.tags });
    const full = renderAst(ast, mk(fields)), none = renderAst(ast, mk(empty));
    if (full !== none && (stripHtml(full) || /<img|\[sound:/i.test(full))) ords.push(ord);
  });
  return ords;
}
