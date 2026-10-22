// Mnemo — composants d'interface partagés (en-têtes, feuilles, dialogues, éditeur de notes)
import { S, saveSettings, notetypeOf, noteCards, newNote, addNote, updateNote, saveCard, parseTags, allTags, findDuplicate, deckDepth, deckLeaf, topDecks, deckChildren } from './state.js';
import { h, ic, esc, stripHtml, toast, debounce, today, fmtIvl, dateTime, dayLabel, fmtDuration } from './util.js';
import { t, tn } from './i18n.js';
import { cardOrdsFor, parseChoices, parseAnswer, templateFor } from './template.js';
import { mountCard, sanitize } from './cardview.js';
import { putMedia, getMediaUrl, uniqueMediaName } from './db.js';
import { retrievability } from './sched.js';

export const go = r => { location.hash = '#/' + r; };

export function header({ title, back = null, actions = [], cls = '' }) {
  return h('header', { class: 'top ' + cls },
    back != null ? h('button', { class: 'icon-btn', onclick: () => typeof back === 'function' ? back() : go(back), 'aria-label': t('Retour') }, ic('back')) : null,
    h('h1', null, title),
    h('div', { class: 'top-actions' }, ...actions));
}
export const iconBtn = (icon, label, onclick, extra = {}) => h('button', { class: 'icon-btn', onclick, 'aria-label': label, title: label, ...extra }, ic(icon));

// ---------- feuilles modales ----------
const openSheets = new Set();
export function closeAllSheets() { for (const c of [...openSheets]) c(); }
export function sheet(title, content, { onClose, cls = '' } = {}) {
  let closed = false;
  const close = () => {
    if (closed) return; closed = true; openSheets.delete(close);
    document.removeEventListener('keydown', key);
    wrap.classList.remove('open');
    setTimeout(() => wrap.remove(), 220);
    onClose?.();
  };
  const key = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const panel = h('div', { class: 'sheet ' + cls, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', null, title), iconBtn('close', t('Fermer'), () => close())),
    h('div', { class: 'sheet-body' }, content));
  const wrap = h('div', { class: 'sheet-wrap' }, h('div', { class: 'sheet-back', onclick: () => close() }), panel);
  document.body.append(wrap);
  document.addEventListener('keydown', key);
  requestAnimationFrame(() => wrap.classList.add('open'));
  openSheets.add(close);
  return close;
}
export const sheetOpen = () => openSheets.size > 0;

export function menu(title, items) {
  let close;
  const list = h('div', { class: 'menu' }, items.filter(Boolean).map(it => it.sep ? h('div', { class: 'menu-sep' }) :
    it.node ? it.node :
    h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), disabled: it.disabled, onclick: () => { close(); it.onclick?.(); } },
      it.icon ? ic(it.icon, 20) : h('span', { class: 'ic' }), h('span', null, it.label), it.hint ? h('kbd', null, it.hint) : null)));
  close = sheet(title, list);
  return close;
}

export function ask(title, { value = '', placeholder = '', ok = t('Valider'), label = '', type = 'text' } = {}) {
  return new Promise(res => {
    let done = false;
    const input = h('input', { class: 'input', type, value, placeholder, 'aria-label': label || title });
    const submit = () => { done = true; close(); res(input.value.trim()); };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
    const close = sheet(title, h('div', { class: 'form' }, label ? h('p', { class: 'muted' }, label) : null, input,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, t('Annuler')), h('button', { class: 'btn primary', onclick: submit }, ok))),
      { onClose: () => { if (!done) res(null); } });
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}
export function confirmBox(message, { ok = t('Confirmer'), danger = false, title = t('Confirmation') } = {}) {
  return new Promise(res => {
    let done = false;
    const close = sheet(title, h('div', { class: 'form' }, h('p', null, message),
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => close() }, t('Annuler')),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => { done = true; close(); res(true); } }, ok))),
      { onClose: () => { if (!done) res(false); } });
  });
}

// ---------- contrôles ----------
export function deckOptions(selected, { all = false, allLabel = t('Toute la collection'), folders = false } = {}) {
  const out = [];
  if (all) out.push(h('option', { value: '', selected: selected == null }, allLabel));
  const walk = ids => { for (const id of ids) { const d = S.decks.get(id); out.push(h('option', { value: id, selected: id === selected, disabled: !!d.folder && !folders }, '\u2003'.repeat(deckDepth(d.name)) + (d.folder ? '▸ ' : '') + deckLeaf(d.name))); walk(deckChildren(id)); } };
  walk(topDecks());
  return out;
}
export function deckSelect(selected, onchange, opts) {
  return h('select', { class: 'select', onchange: e => onchange(e.target.value === '' ? null : +e.target.value) }, deckOptions(selected, opts));
}
export function seg(options, value, onchange, { small = false } = {}) {
  const el = h('div', { class: 'seg' + (small ? ' small' : ''), role: 'radiogroup' });
  const render = v => el.replaceChildren(...options.map(([val, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(val === v), class: val === v ? 'on' : '',
    onclick: () => { render(val); onchange(val); },
  }, label)));
  render(value);
  return el;
}
export function toggle(checked, onchange, label = '') {
  return h('label', { class: 'switch' }, h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: e => onchange(e.target.checked) }), h('span'));
}
export function setRow(label, control, hint = null) {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('span', null, label), hint ? h('small', null, hint) : null), control);
}
export function linkRow(label, onclick, hint = null) {
  return h('button', { class: 'set-row link', onclick }, h('div', { class: 'set-label' }, h('span', null, label), hint ? h('small', null, hint) : null), ic('chevron', 18));
}
export const section = (title, ...rows) => h('section', { class: 'set-sec' }, title ? h('h2', null, title) : null, h('div', { class: 'set-list' }, ...rows));

// ---------- état des cartes ----------
export function cardStatus(c) {
  if (c.queue === -1) return t('Suspendue');
  if (c.queue < -1) return t('Enfouie');
  if (c.type === 0) return t('Nouvelle');
  if (c.queue === 1) return t('En apprentissage');
  const d = c.due - today();
  return d < 0 ? t('En retard de {n}', { n: fmtIvl(-d) }) : d === 0 ? t("Aujourd'hui") : d === 1 ? t('Demain') : t('Dans {n}', { n: fmtIvl(d) });
}
export function templateName(c) {
  const n = S.notes.get(c.nid), nt = n && notetypeOf(n);
  if (!nt) return '';
  return nt.kind === 'cloze' ? t('Trou {n}', { n: c.ord + 1 }) : (templateFor(c, nt)?.name || '');
}
export function cardInfo(c) {
  const n = S.notes.get(c.nid), nt = notetypeOf(n);
  const logs = S.revlog.filter(l => l.cid === c.id).sort((a, b) => b.id - a.id);
  const rated = logs.filter(l => l.ease >= 1);
  const rows = [
    [t('Ajoutée le'), dateTime(c.id)],
    [t('Première révision'), rated.length ? dateTime(rated[rated.length - 1].id) : '–'],
    [t('Dernière révision'), rated.length ? dateTime(rated[0].id) : '–'],
    [t('État'), cardStatus(c)],
    c.type === 2 || c.type === 3 ? [t('Échéance'), dayLabel(c.due)] : null,
    c.type !== 0 ? [t('Intervalle'), fmtIvl(c.ivl)] : null,
    c.s != null ? [t('Stabilité'), fmtIvl(c.s)] : null,
    c.d != null ? [t('Difficulté'), Math.round((c.d - 1) / 9 * 100) + ' %'] : null,
    c.s != null ? [t('Rappel estimé'), (retrievability(c) != null ? Math.round(retrievability(c) * 100) + ' %' : '–')] : null,
    c.factor && c.s == null ? [t('Facilité'), (c.factor / 10) + ' %'] : null,
    [t('Révisions'), String(c.reps)], [t('Oublis'), String(c.lapses)],
    rated.length ? [t('Temps total'), fmtDuration(rated.reduce((s, l) => s + l.time, 0))] : null,
    [t('Type de note'), nt?.name || '–'], [t('Carte'), templateName(c)], [t('Paquet'), S.decks.get(c.did)?.name || '–'],
    [t('ID de la carte'), String(c.id)],
  ].filter(Boolean);
  const types = [t('Apprentissage'), t('Révision'), t('Réapprentissage'), t('Session libre'), t('Manuel')];
  const btn = [t('Réinitialisée'), t('À revoir'), t('Difficile'), t('Correct'), t('Facile')];
  sheet(t('Infos de la carte'), h('div', { class: 'info' },
    h('dl', null, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    logs.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'revtable' },
      h('thead', null, h('tr', null, [t('Date'), t('Type'), t('Réponse'), t('Intervalle'), t('Temps')].map(x => h('th', null, x)))),
      h('tbody', null, logs.map(l => h('tr', { class: 'e' + l.ease }, h('td', null, dateTime(l.id)), h('td', null, types[l.type] ?? '–'),
        h('td', null, btn[l.ease] ?? '–'), h('td', null, l.ivl < 0 ? fmtIvl(-l.ivl / 86400) : l.ivl ? fmtIvl(l.ivl) : '–'), h('td', null, l.time ? fmtDuration(l.time) : '–')))))) : null));
}

// ---------- éditeur de champs ----------
const ALLOWED = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'SUB', 'SUP', 'BR', 'DIV', 'P', 'UL', 'OL', 'LI', 'IMG', 'A', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'CODE', 'PRE', 'S', 'SPAN', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'HR']);
function cleanPaste(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.replace(/<!--[\s\S]*?-->/g, '');
  tpl.content.querySelectorAll('style,script,meta,link,title,head').forEach(e => e.remove());
  const walk = node => {
    for (const el of [...node.children]) {
      walk(el);
      if (!ALLOWED.has(el.tagName)) { el.replaceWith(...el.childNodes); continue; }
      for (const a of [...el.attributes]) if (!((el.tagName === 'IMG' && a.name === 'src') || (el.tagName === 'A' && a.name === 'href'))) el.removeAttribute(a.name);
      if (el.tagName === 'SPAN') el.replaceWith(...el.childNodes);
    }
  };
  walk(tpl.content);
  return tpl.innerHTML;
}
export function getFieldHtml(ed) {
  if (ed.tagName === 'TEXTAREA') return ed.value.trim();
  const c = ed.cloneNode(true);
  c.querySelectorAll('img[data-mn-src]').forEach(img => { img.setAttribute('src', img.dataset.mnSrc); img.removeAttribute('data-mn-src'); });
  let html = c.innerHTML;
  if (/^(\s|<br\s*\/?>|&nbsp;|<div><br><\/div>)*$/i.test(html)) return '';
  return html.replace(/(<br\s*\/?>)+$/i, '').trim();
}
export function setFieldHtml(ed, html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  sanitize(tpl.content);
  const imgs = [];
  tpl.content.querySelectorAll('img[src]').forEach(img => {
    const src = img.getAttribute('src');
    if (/^(https?:|data:|blob:)/i.test(src)) return;
    img.dataset.mnSrc = src; img.setAttribute('src', ''); imgs.push(img);
  });
  ed.replaceChildren(document.importNode(tpl.content, true));
  ed.querySelectorAll('img[data-mn-src]').forEach(img => getMediaUrl(img.dataset.mnSrc).then(u => { if (u) img.src = u; }));
}
const maxCloze = vals => Math.max(0, ...vals.flatMap(v => [...String(v).matchAll(/\{\{c(\d+)::/g)].map(m => +m[1])));

// Éditeur complet d'une note (ajout ou modification)
export function noteEditor({ note = null, onSaved = null, inSheet = false } = {}) {
  const editing = !!note;
  let mid = editing ? note.mid : (S.notetypes.has(S.settings.lastNotetype) ? S.settings.lastNotetype : [...S.notetypes.keys()][0]);
  let did = editing ? (noteCards(note.id)[0]?.did ?? 1) : (S.decks.has(S.settings.lastDeck) && !S.decks.get(S.settings.lastDeck).folder ? S.settings.lastDeck : 1);
  let values = editing ? note.flds.slice() : [];
  let htmlMode = false, active = null, savedRange = null;
  let getters = [];
  const root = h('div', { class: 'editor' });
  const tagsInput = h('input', { class: 'input', placeholder: t('étiquettes séparées par des espaces'), list: 'mn-tags', autocapitalize: 'off', value: editing ? note.tags.join(' ') : (S.settings.lastTags || '') });
  const dupEl = h('p', { class: 'warn', hidden: true });
  const fileInput = h('input', { type: 'file', accept: 'image/*,audio/*', multiple: true, hidden: true, onchange: async e => { for (const f of e.target.files) await insertMedia(f); e.target.value = ''; } });

  function collect() { const nt = S.notetypes.get(mid); const v = nt.flds.map(() => ''); for (const g of getters) g(v); return v; }
  function remember(ed) { active = ed; }
  function saveSel() {
    const s = getSelection();
    savedRange = s.rangeCount && active?.contains(s.anchorNode) ? s.getRangeAt(0).cloneRange() : null;
  }
  function restoreSel() {
    if (!active) return false;
    active.focus();
    if (savedRange) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
    return true;
  }
  function insertHtml(html) {
    if (!active) { toast(t("Placez d'abord le curseur dans un champ.")); return; }
    if (active.tagName === 'TEXTAREA') {
      const a = active, s = a.selectionStart, e = a.selectionEnd;
      a.value = a.value.slice(0, s) + html + a.value.slice(e); a.selectionStart = a.selectionEnd = s + html.length; a.focus(); return;
    }
    active.focus();
    document.execCommand('insertHTML', false, html);
  }
  function wrap(before, after) {
    if (!active) { toast(t("Placez d'abord le curseur dans un champ.")); return; }
    if (active.tagName === 'TEXTAREA') {
      const a = active, s = a.selectionStart, e = a.selectionEnd;
      a.value = a.value.slice(0, s) + before + a.value.slice(s, e) + after + a.value.slice(e);
      a.selectionStart = s + before.length; a.selectionEnd = e + before.length; a.focus(); return;
    }
    active.focus();
    const sel = getSelection();
    let inner = '';
    if (sel.rangeCount && active.contains(sel.anchorNode)) { const d = document.createElement('div'); d.append(sel.getRangeAt(0).cloneContents()); inner = d.innerHTML; }
    document.execCommand('insertHTML', false, before + inner + after);
  }
  async function insertMedia(file) {
    const name = await uniqueMediaName(file.name && file.name !== 'image.png' ? file.name : `img-${Date.now()}.${(file.type.split('/')[1] || 'png').replace('jpeg', 'jpg')}`);
    await putMedia(name, file);
    const url = await getMediaUrl(name);
    restoreSel();
    if (/^audio\//.test(file.type)) insertHtml(`[sound:${esc(name)}]`);
    else if (active?.tagName === 'TEXTAREA') insertHtml(`<img src="${esc(name)}">`);
    else insertHtml(`<img src="${url}" data-mn-src="${esc(name)}">`);
  }
  function onPaste(e) {
    const dt = e.clipboardData; if (!dt) return;
    const files = [...dt.files].filter(f => /^image\//.test(f.type));
    if (files.length) { e.preventDefault(); (async () => { for (const f of files) await insertMedia(f); })(); return; }
    if (e.currentTarget.tagName === 'TEXTAREA') return;
    e.preventDefault();
    const html = dt.getData('text/html');
    if (html) document.execCommand('insertHTML', false, cleanPaste(html));
    else document.execCommand('insertText', false, dt.getData('text/plain'));
  }
  function clozeCmd(same) {
    const n = maxCloze(collect());
    wrap(`{{c${same ? Math.max(1, n) : n + 1}::`, '}}');
  }
  function fieldKeys(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === 'C' || e.key === 'c')) { e.preventDefault(); clozeCmd(e.altKey); }
    else if (mod && e.key === 'm') { e.preventDefault(); wrap('\\(', '\\)'); }
  }
  function richInput(label, html, onInput) {
    let ed;
    if (htmlMode) {
      ed = h('textarea', { class: 'field-input code', rows: 3, spellcheck: 'false', 'aria-label': label });
      ed.value = html || '';
    } else {
      ed = h('div', { class: 'field-input', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true', 'aria-label': label });
      setFieldHtml(ed, html);
    }
    ed.addEventListener('focus', () => remember(ed));
    ed.addEventListener('blur', saveSel);
    ed.addEventListener('paste', onPaste);
    ed.addEventListener('keydown', fieldKeys);
    if (onInput) ed.addEventListener('input', onInput);
    return ed;
  }
  const field = (label, control, extra = null) => h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), control, extra);

  const checkDup = debounce(() => {
    if (!getters.length) return;
    const tmp = { id: note?.id ?? -1, mid, flds: collect() };
    const d = findDuplicate(tmp);
    dupEl.hidden = !d;
    dupEl.textContent = d ? t('Une note identique existe déjà dans ce type de note.') : '';
  }, 400);

  function mcqBlock(nt, vals) {
    const ci = nt.flds.findIndex(f => f.name === nt.mcq?.choices), ai = nt.flds.findIndex(f => f.name === nt.mcq?.answer);
    if (ci < 0 || ai < 0) return null;
    const { options, marked } = parseChoices(vals[ci] || '');
    const correct = parseAnswer(vals[ai] || '', options, marked);
    let rows = options.length ? options.map((o, i) => ({ html: o, ok: correct.has(i) })) : [{ html: '', ok: true }, { html: '', ok: false }, { html: '', ok: false }];
    const list = h('div', { class: 'opts' });
    const render = () => {
      list.replaceChildren(...rows.map((r, i) => {
        r.ed = richInput(t('Choix {n}', { n: String.fromCharCode(65 + i) }), r.html, () => { r.html = getFieldHtml(r.ed); });
        return h('div', { class: 'opt-row' + (r.ok ? ' ok' : '') },
          h('button', { type: 'button', class: 'opt-check', 'aria-pressed': String(r.ok), title: t('Bonne réponse'), onclick: () => { r.html = getFieldHtml(r.ed); r.ok = !r.ok; render(); } }, ic('check', 18)),
          r.ed,
          h('button', { type: 'button', class: 'icon-btn small', 'aria-label': t('Retirer ce choix'), onclick: () => { rows.forEach(x => x.html = getFieldHtml(x.ed)); rows.splice(i, 1); render(); } }, ic('close', 18)));
      }));
    };
    render();
    getters.push(v => {
      const kept = rows.map(r => ({ html: getFieldHtml(r.ed), ok: r.ok })).filter(r => stripHtml(r.html) || /<img/i.test(r.html));
      v[ci] = kept.map(r => r.html).join('<br>');
      v[ai] = kept.map((r, i) => r.ok ? String.fromCharCode(65 + i) : null).filter(Boolean).join(',');
    });
    return field(t('Choix — cochez la ou les bonnes réponses'), h('div', null, list,
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => { rows.forEach(x => x.html = getFieldHtml(x.ed)); rows.push({ html: '', ok: false }); render(); setTimeout(() => rows[rows.length - 1].ed.focus(), 30); } }, ic('plus', 18), t('Ajouter un choix'))));
  }
  function tfBlock(nt, vals) {
    const ai = nt.flds.findIndex(f => f.name === nt.tf?.answer);
    if (ai < 0) return null;
    const v0 = stripHtml(vals[ai] || '').toLowerCase();
    let val = /^(faux|f|false|0|non|no)$/.test(v0) ? 0 : 1;
    getters.push(v => { v[ai] = val ? t('Vrai') : t('Faux'); });
    return field(t('Réponse'), seg([[1, t('Vrai')], [0, t('Faux')]], val, x => { val = x; }));
  }

  function render() {
    const nt = S.notetypes.get(mid);
    getters = []; active = null;
    const fieldsBox = h('div', { class: 'fields' });
    const special = new Set();
    let mcq = null, tf = null;
    if (nt.kind === 'mcq' && !htmlMode) { mcq = mcqBlock(nt, values); if (mcq) { special.add(nt.mcq.choices); special.add(nt.mcq.answer); } }
    if (nt.kind === 'tf' && !htmlMode) { tf = tfBlock(nt, values); if (tf) special.add(nt.tf.answer); }
    nt.flds.forEach((f, i) => {
      if (special.has(f.name)) { if (f.name === nt.mcq?.choices) fieldsBox.append(mcq); if (f.name === nt.tf?.answer) fieldsBox.append(tf); return; }
      const ed = richInput(f.name, values[i], i === 0 ? checkDup : null);
      getters.push(v => { v[i] = getFieldHtml(ed); });
      fieldsBox.append(field(f.name, ed, i === 0 ? dupEl : null));
    });
    const tb = (label, title, fn, extra = {}) => h('button', { type: 'button', class: 'tool', title, 'aria-label': title, onpointerdown: e => e.preventDefault(), onclick: fn, ...extra }, label);
    const cmd = c => () => { if (active && active.tagName !== 'TEXTAREA') { active.focus(); document.execCommand(c); } };
    const toolbar = h('div', { class: 'toolbar', role: 'toolbar' },
      tb(h('b', null, 'B'), t('Gras'), cmd('bold')), tb(h('i', null, 'I'), t('Italique'), cmd('italic')), tb(h('u', null, 'U'), t('Souligné'), cmd('underline')),
      tb('x²', t('Exposant'), cmd('superscript')), tb('x₂', t('Indice inférieur'), cmd('subscript')),
      nt.kind === 'cloze' ? tb('[…]', t('Nouveau trou (Ctrl+Maj+C)'), () => clozeCmd(false)) : null,
      nt.kind === 'cloze' ? tb('[…]=', t('Trou avec le même numéro'), () => clozeCmd(true)) : null,
      tb(ic('sigma', 18), t('Formule LaTeX (Ctrl+M)'), () => wrap('\\(', '\\)')),
      tb(ic('image', 18), t('Insérer une image ou un son'), () => { saveSel(); fileInput.click(); }),
      tb(ic('code', 18), t('Modifier le HTML'), () => { values = collect(); htmlMode = !htmlMode; render(); }, { 'aria-pressed': String(htmlMode), class: 'tool' + (htmlMode ? ' on' : '') }),
      tb('Tx', t('Effacer la mise en forme'), cmd('removeFormat')));
    const top = h('div', { class: 'editor-top' },
      h('label', { class: 'mini' }, h('span', null, t('Type')), editing ? h('span', { class: 'static' }, nt.name) :
        h('select', { class: 'select', onchange: e => { values = collect(); mid = +e.target.value; render(); } },
          [...S.notetypes.values()].sort((a, b) => a.name.localeCompare(b.name)).map(x => h('option', { value: x.id, selected: x.id === mid }, x.name)))),
      h('label', { class: 'mini' }, h('span', null, t('Paquet')), deckSelect(did, v => { did = v; })));
    const tagsList = h('datalist', { id: 'mn-tags' }, allTags().map(x => h('option', { value: x })));
    root.replaceChildren(top, toolbar, fieldsBox,
      field(t('Étiquettes'), tagsInput), tagsList, fileInput,
      h('div', { class: 'actions sticky' + (inSheet ? ' in-sheet' : '') },
        h('button', { class: 'btn', onclick: preview }, ic('eye', 18), t('Aperçu')),
        h('button', { class: 'btn primary', onclick: save }, editing ? t('Enregistrer') : t('Ajouter'))));
  }

  function draftNote() {
    const n = { id: note?.id ?? -1, mid, flds: collect(), tags: parseTags(tagsInput.value) };
    return n;
  }
  function preview() {
    const n = draftNote(); const nt = S.notetypes.get(mid);
    const ords = cardOrdsFor(n, nt);
    if (!ords.length) { toast(nt.kind === 'cloze' ? t('Ajoutez au moins un trou : {{c1::…}}') : t('Aucune carte ne serait créée : remplissez le premier champ.')); return; }
    let i = 0, side = 'q';
    const host = h('div', { class: 'card-host preview' });
    const label = h('span', { class: 'muted' });
    const st = { seed: 1 };
    const draw = () => {
      label.textContent = `${nt.kind === 'cloze' ? t('Trou {n}', { n: ords[i] + 1 }) : nt.tmpls[ords[i]]?.name} — ${side === 'q' ? t('Recto') : t('Verso')}`;
      mountCard(host, { id: 0, nid: n.id, did, ord: ords[i], flags: 0, reps: 0 }, side, st, { autoplay: false, focusInput: false }, n);
    };
    sheet(t('Aperçu'), h('div', { class: 'preview-wrap' }, h('div', { class: 'row between' }, label,
      h('div', { class: 'row' },
        ords.length > 1 ? h('button', { class: 'btn small', onclick: () => { i = (i + 1) % ords.length; side = 'q'; Object.keys(st).forEach(k => k !== 'seed' && delete st[k]); draw(); } }, t('Carte suivante')) : null,
        h('button', { class: 'btn small', onclick: () => { side = side === 'q' ? 'a' : 'q'; draw(); } }, t('Retourner')))), host));
    draw();
  }

  function save() {
    const nt = S.notetypes.get(mid);
    const flds = collect();
    if (!flds.some(v => stripHtml(v) || /<img|\[sound:/i.test(v))) { toast(t('La note est vide.')); return; }
    const tags = parseTags(tagsInput.value);
    if (editing) {
      note.flds = flds; note.tags = tags;
      updateNote(note);
      for (const c of noteCards(note.id)) if (c.did !== did) { c.did = did; saveCard(c); }
      toast(t('Note enregistrée'));
      onSaved?.(note);
      return;
    }
    const n = newNote(mid, flds, tags);
    if (!cardOrdsFor(n, nt).length) { toast(nt.kind === 'cloze' ? t('Ajoutez au moins un trou : {{c1::…}}') : t('Aucune carte ne serait créée : remplissez le premier champ.')); return; }
    const k = addNote(n, did);
    Object.assign(S.settings, { lastNotetype: mid, lastDeck: did, lastTags: tagsInput.value.trim() });
    saveSettings();
    toast(tn(k, 'Note ajoutée ({n} carte)', 'Note ajoutée ({n} cartes)'));
    values = []; render();
    setTimeout(() => root.querySelector('.field-input')?.focus(), 50);
    onSaved?.(n);
  }
  root.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
  render();
  return root;
}
