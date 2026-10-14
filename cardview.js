// Mnemo — affichage d'une carte (Shadow DOM isolé : CSS du type de note, médias, maths, audio)
import { S } from './state.js';
import { renderCard, compareTyped } from './template.js';
import { getMediaUrl } from './db.js';
import { getKatex, CDN, esc } from './util.js';
import { t } from './i18n.js';

const CARD_BASE = `
:host { display:block; color: var(--fg); }
.card { color: var(--fg); background: transparent; word-wrap: break-word; overflow-wrap: anywhere; }
.card img { max-width: 100%; height: auto; }
.card table { border-collapse: collapse; margin: .6em auto; }
.card td, .card th { border: 1px solid var(--line); padding: .3em .6em; }
hr#answer, hr { border: 0; border-top: 1px solid var(--line-strong); margin: 1.1em 0; }
.cloze { font-weight: 650; color: var(--accent); }
.cloze-inactive { }
a { color: var(--accent); }
.hint { font-size: .8em; color: var(--accent); text-decoration: none; border-bottom: 1px dashed currentColor; }
.hint-body { margin-top: .3em; }
.mn-err { font: 14px var(--ui-font); color: var(--again); margin: .6em 0; }
.mn-typein { font: inherit; font-size: .9em; width: min(100%, 26em); box-sizing: border-box; margin: 1em auto 0; display: block;
  padding: .55em .8em; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg); text-align: center; outline: none; }
.mn-typein:focus { border-color: var(--accent); }
code.typeans { font-family: var(--mono); font-size: .85em; display: inline-block; margin-top: .4em; line-height: 1.6; }
.typeGood { color: var(--good); } .typeBad { color: var(--again); text-decoration: line-through; } .typeMissed { color: var(--muted); }
.typearrow { color: var(--muted); }
.mn-sound { display:inline-flex; align-items:center; justify-content:center; width:2.2em; height:2.2em; border-radius:50%; border:1px solid var(--line-strong);
  background: transparent; color: var(--accent); vertical-align: middle; cursor:pointer; margin: 0 .15em; padding:0; }
.mn-sound svg { width: 1em; height: 1em; }
.q { margin-bottom: 1em; }
.expl { margin-top: 1.2em; padding-top: 1em; border-top: 1px solid var(--line); font-size: .85em; color: var(--fg-soft); text-align: left; }
.mn-multi { font: 13px var(--ui-font); color: var(--muted); margin-bottom: .6em; }
.mn-mcq { display: grid; gap: .5em; text-align: left; max-width: 32em; margin: 0 auto; }
.mn-opt { all: unset; box-sizing: border-box; display: flex; gap: .75em; align-items: flex-start; padding: .7em .85em; border-radius: 14px;
  border: 1px solid var(--line-strong); cursor: pointer; font-size: .85em; line-height: 1.4; transition: border-color .15s, background .15s; }
.mn-opt .mn-key { font: 600 12px var(--ui-font); width: 1.9em; height: 1.9em; flex: none; display: grid; place-items: center; border-radius: 50%; border: 1px solid var(--line-strong); margin-top: .05em; }
.mn-opt .mn-txt { flex: 1; }
.mn-opt.is-selected { border-color: var(--accent); background: var(--accent-soft); }
.mn-opt.is-selected .mn-key { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.is-answered .mn-opt { cursor: default; }
.mn-opt.is-correct { border-color: var(--good); background: var(--good-soft); }
.mn-opt.is-correct .mn-key { background: var(--good); color: #fff; border-color: var(--good); }
.mn-opt.is-wrong { border-color: var(--again); background: var(--again-soft); }
.mn-opt.is-wrong .mn-key { background: var(--again); color: #fff; border-color: var(--again); }
.mn-tf { display: flex; gap: .6em; justify-content: center; margin-top: .4em; }
.mn-tfb { all: unset; box-sizing: border-box; cursor: pointer; min-width: 7em; text-align: center; padding: .65em 1.2em; border-radius: 999px;
  border: 1px solid var(--line-strong); font: 600 15px var(--ui-font); }
.mn-tfb.is-selected { border-color: var(--accent); background: var(--accent-soft); }
.mn-tfb.is-correct { border-color: var(--good); background: var(--good-soft); }
.mn-tfb.is-wrong { border-color: var(--again); background: var(--again-soft); }
.is-answered .mn-tfb { cursor: default; }
.mn-verdict { font: 600 14px var(--ui-font); margin-top: .9em; color: var(--muted); }
.mn-verdict.ok { color: var(--good); } .mn-verdict.ko { color: var(--again); }
.katex { font-size: 1.05em; }
.katex-display { overflow-x: auto; overflow-y: hidden; padding: .2em 0; }
`;

function overrides() {
  const st = S.settings;
  let css = '';
  if (st.adaptCardColors) css += `.card { background: transparent !important; color: var(--fg) !important; }\n`;
  if (st.forceCardFont) css += `.card { font-family: var(--card-font) !important; font-size: var(--card-size) !important; }\n`;
  return css;
}

const PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>';
function preprocess(html) {
  return html
    .replace(/\[sound:([^\]]+)\]/g, (m, f) => `<button type="button" class="mn-sound" data-sound="${esc(f.trim())}" aria-label="${t('Lire le son')}">${PLAY}</button>`)
    .replace(/\[\$\$\]([\s\S]*?)\[\/\$\$\]/g, '\\[$1\\]')
    .replace(/\[\$\]([\s\S]*?)\[\/\$\]/g, '\\($1\\)')
    .replace(/\[latex\]([\s\S]*?)\[\/latex\]/gi, (m, t) => {
      const s = t.replace(/<br\s*\/?>/gi, ' ');
      return /\$/.test(s) ? s.replace(/\$\$([\s\S]+?)\$\$/g, '\\[$1\\]').replace(/\$([^$]+)\$/g, '\\($1\\)') : `\\(${s}\\)`;
    });
}

async function resolveMedia(root) {
  const els = [...root.querySelectorAll('[src]')];
  await Promise.all(els.map(async el => {
    const src = el.getAttribute('src');
    if (!src || /^(https?:|data:|blob:|\/\/)/i.test(src)) return;
    const url = await getMediaUrl(src);
    if (url) el.setAttribute('src', url);
  }));
}
export async function resolveCssUrls(css) {
  const names = [...new Set([...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map(m => m[1]).filter(u => !/^(https?:|data:|blob:)/i.test(u)))];
  for (const n of names) { const u = await getMediaUrl(n); if (u) css = css.split(n).join(u); }
  return css;
}

// Lecture audio
let audio = null;
export function playSound(name) {
  return getMediaUrl(name).then(url => new Promise(res => {
    if (!url) return res();
    audio ??= new Audio();
    audio.src = url; audio.onended = res; audio.onerror = res;
    audio.play().catch(res);
  }));
}
export function stopAudio() { if (audio) { audio.pause(); audio.onended?.(); } }
export async function playAll(root, skipFront) {
  const btns = [...root.querySelectorAll('.mn-sound')].filter(b => !(skipFront && b.closest('.mn-front')));
  for (const b of btns) { if (!b.isConnected) return; await playSound(b.dataset.sound); }
}

export async function typeset(el) {
  const text = el.textContent;
  const dollar = S.settings.dollarMath;
  if (!/\\\(|\\\[|\$\$|\\begin\{/.test(text) && !(dollar && /\$[^$]+\$/.test(text))) return;
  try { await getKatex(); } catch { return; }
  if (!globalThis.renderMathInElement) return;
  const delimiters = [
    { left: '$$', right: '$$', display: true },
    { left: '\\[', right: '\\]', display: true },
    { left: '\\(', right: '\\)', display: false },
    { left: '\\begin{equation}', right: '\\end{equation}', display: true },
    { left: '\\begin{align}', right: '\\end{align}', display: true },
    { left: '\\begin{align*}', right: '\\end{align*}', display: true },
  ];
  if (dollar) delimiters.push({ left: '$', right: '$', display: false });
  globalThis.renderMathInElement(el, {
    delimiters, throwOnError: false, strict: 'ignore',
    trust: ctx => ctx.command === '\\htmlClass',
    macros: { '\\R': '\\mathbb{R}', '\\N': '\\mathbb{N}', '\\Z': '\\mathbb{Z}', '\\Q': '\\mathbb{Q}', '\\C': '\\mathbb{C}' },
  });
}

export function sanitize(root) {
  root.querySelectorAll('script, iframe[srcdoc], object, embed').forEach(e => e.remove());
  for (const el of root.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|formaction)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
}

function runScripts(root) {
  for (const old of root.querySelectorAll('script')) {
    const s = document.createElement('script');
    for (const a of old.attributes) s.setAttribute(a.name, a.value);
    s.textContent = old.textContent;
    old.replaceWith(s);
  }
}

// Monte une carte dans `host`. `st` conserve l'état de la carte (QCM, réponse tapée…)
export async function mountCard(host, card, side, st, handlers = {}, noteOverride = null) {
  const root = host.shadowRoot || host.attachShadow({ mode: 'open' });
  const { html, css, out } = renderCard(card, side, st, noteOverride);
  if (out.typeExpected != null) st.typeExpected = out.typeExpected;
  const dark = document.documentElement.dataset.mode === 'dark';
  const tpl = document.createElement('template');
  tpl.innerHTML = `<div class="card card${card.ord + 1}${dark ? ' nightMode night_mode' : ''}"><div id="qa">${preprocess(html)}</div></div>`;
  if (!S.settings.runScripts) sanitize(tpl.content);
  await resolveMedia(tpl.content);
  const wrap = document.importNode(tpl.content.firstElementChild, true);
  const cssResolved = await resolveCssUrls(css || '');
  if (side === 'a') {
    const cmp = wrap.querySelector('.mn-typecmp');
    if (cmp) cmp.innerHTML = compareTyped(st.typed || '', st.typeExpected || '');
  }
  const frag = document.createDocumentFragment();
  const katexLink = document.createElement('link');
  katexLink.rel = 'stylesheet'; katexLink.href = CDN.katex + 'katex.min.css';
  const s1 = document.createElement('style'); s1.textContent = CARD_BASE;
  const s2 = document.createElement('style'); s2.textContent = cssResolved;
  const s3 = document.createElement('style'); s3.textContent = overrides();
  frag.append(katexLink, s1, s2, s3, wrap);
  if (handlers.stale?.()) return null;
  root.replaceChildren(frag);
  await typeset(wrap);
  if (S.settings.runScripts) runScripts(wrap);
  host._handlers = handlers;
  if (!root._bound) {
    root._bound = true;
    root.addEventListener('click', e => onClick(e, host));
    root.addEventListener('keydown', e => {
      if (e.target.classList?.contains('mn-typein') && e.key === 'Enter') { e.preventDefault(); host._handlers.reveal?.(); }
    });
    root.addEventListener('input', e => { if (e.target.classList?.contains('mn-typein')) host._st.typed = e.target.value; });
  }
  host._st = st;
  const input = wrap.querySelector('.mn-typein');
  if (input) { input.value = st.typed || ''; if (handlers.focusInput !== false) setTimeout(() => input.focus({ preventScroll: true }), 30); }
  if (S.settings.autoplay && handlers.autoplay !== false) playAll(wrap, side === 'a');
  return wrap;
}

function onClick(e, host) {
  const st = host._st, h = host._handlers || {};
  const t = e.target.closest?.('[data-sound],[data-mn-hint],[data-opt],[data-tf]');
  if (!t) return;
  if (t.dataset.sound) { e.stopPropagation(); playSound(t.dataset.sound); return; }
  if (t.hasAttribute('data-mn-hint')) {
    e.preventDefault(); e.stopPropagation();
    t.nextElementSibling?.removeAttribute('hidden'); t.remove(); return;
  }
  if (t.closest('.is-answered')) return;
  e.stopPropagation();
  if (t.dataset.opt != null) {
    const i = +t.dataset.opt;
    st.selected ??= new Set();
    if (st.multi) { st.selected.has(i) ? st.selected.delete(i) : st.selected.add(i); t.classList.toggle('is-selected'); h.changed?.(); }
    else {
      st.selected = new Set([i]);
      t.parentElement.querySelectorAll('.mn-opt').forEach(b => b.classList.toggle('is-selected', b === t));
      h.changed?.();
      if (S.settings.revealOnChoice) setTimeout(() => h.reveal?.(), 120);
    }
  } else if (t.dataset.tf != null) {
    st.selected = new Set([+t.dataset.tf]);
    t.parentElement.querySelectorAll('.mn-tfb').forEach(b => b.classList.toggle('is-selected', b === t));
    h.changed?.();
    setTimeout(() => h.reveal?.(), 120);
  }
}

// Sélection au clavier dans un QCM (1-9 / A-Z) avant d'afficher la réponse
export function keySelect(host, key) {
  const root = host.shadowRoot; if (!root) return false;
  const opts = [...root.querySelectorAll('.mn-mcq:not(.is-answered) .mn-opt, .mn-tf:not(.is-answered) .mn-tfb')];
  if (!opts.length) return false;
  let k = -1;
  if (/^[1-9]$/.test(key)) k = +key - 1;
  else if (/^[a-z]$/i.test(key) && opts[0].classList.contains('mn-opt')) k = key.toUpperCase().charCodeAt(0) - 65;
  else if (/^[vt]$/i.test(key)) k = 0; else if (/^f$/i.test(key)) k = 1;
  if (k < 0 || k >= opts.length) return false;
  opts[k].click();
  return true;
}
