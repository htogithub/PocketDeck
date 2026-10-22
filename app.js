// Mnemo — application : démarrage, thème, navigation et écrans
import { S, saveSettings, saveDeck, deckByName, renameDeck, deleteDeck, deckChildren, deckSubtree, topDecks, deckLeaf, presetOf, deckParent, deckAncestors, invalidateDecks,
  notetypeOf, noteCards, sortText, deleteNotes, addTags, removeTags, parseTags, saveCard, persist, defaultPreset, saveNotetype,
  notesOfType, genCards, updateNote, deleteCard, uniqueNotetypeName, builtinDef, BUILTIN_KEYS, localizeDefaults, DEFAULT_W, saveNote } from './state.js';
import { h, ic, $, esc, toast, today, dayStart, fmtIvl, fmtDuration, truncate, hash32, saveFile, debounce, setRollover, newId, stripHtml, dayLabel, dateTime } from './util.js';
import { initSync, sync, syncNow, signIn, signUp, signOut, setConfig, forgetConfig, configured, loggedIn, resetFrom, SETUP_SQL } from './sync.js';
import { t, tn, setLang, getLang, detectLang } from './i18n.js';
import { loadAll, flush, storageInfo, requestPersist, wipeAll } from './db.js';
import { Session, deckCounts, previewIntervals, setSuspended, bury, forget, setFlag, extendLimit, recomputeMemory, unburyIfNewDay } from './sched.js';
import { mountCard, stopAudio, playAll, keySelect } from './cardview.js';
import { compileSearch, searchCards, searchHelp } from './search.js';
import { statsHtml } from './stats.js';
import { cardOrdsFor } from './template.js';
import * as IM from './importers.js';
import * as EX from './exporters.js';
import { go, header, iconBtn, sheet, menu, ask, confirmBox, deckSelect, deckOptions, seg, toggle, setRow, linkRow, section,
  cardStatus, templateName, cardInfo, noteEditor, closeAllSheets, sheetOpen } from './ui.js';

const VERSION = '1.2.0';
let cleanup = null, pendingSession = null, routeToken = 0;

// ---------- thème ----------
const UI_FONTS = {
  instrument: '"Instrument Sans", system-ui, -apple-system, sans-serif',
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  newsreader: '"Newsreader", Georgia, serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
};
const CARD_FONTS = {
  palatino: '"Palatino", "Palatino Linotype", "Book Antiqua", "URW Palladio L", Georgia, serif',
  newsreader: '"Newsreader", Georgia, serif',
  instrument: UI_FONTS.instrument, system: UI_FONTS.system, mono: UI_FONTS.mono,
};
const ACCENTS = ['#8C7CF0', '#5B8DEF', '#2BB3A3', '#4CAF6E', '#E3A23B', '#EF6F5B', '#E36FA8', '#8A94A6'];
function onAccent(hex) {
  const m = hex.replace('#', '').match(/.{2}/g); if (!m) return '#fff';
  const [r, g, b] = m.map(x => parseInt(x, 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.42 ? '#141414' : '#ffffff';
}
function loadGoogleFont(name) {
  if (!name || document.querySelector(`link[data-font="${CSS.escape(name)}"]`)) return;
  document.head.append(h('link', { rel: 'stylesheet', 'data-font': name, href: `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:ital,wght@0,400;0,700;1,400&display=swap` }));
}
export function applyTheme() {
  const st = S.settings, root = document.documentElement;
  const sysDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const theme = st.theme === 'system' ? (sysDark ? 'dark' : 'light') : st.theme;
  root.dataset.theme = theme;
  root.dataset.mode = theme === 'light' ? 'light' : 'dark';
  root.style.setProperty('--accent', st.accent);
  root.style.setProperty('--on-accent', onAccent(st.accent));
  root.style.setProperty('--ui-font', UI_FONTS[st.uiFont] || UI_FONTS.instrument);
  let cf = CARD_FONTS[st.cardFont] || CARD_FONTS.palatino;
  if (st.cardFont === 'custom' && st.customCardFont) { loadGoogleFont(st.customCardFont); cf = `"${st.customCardFont}", ${CARD_FONTS.palatino}`; }
  root.style.setProperty('--card-font', cf);
  root.style.setProperty('--card-size', st.cardSize + 'px');
  root.style.setProperty('--card-align', st.cardAlign);
  root.style.setProperty('--card-width', st.cardWidth + 'px');
  root.classList.toggle('big-buttons', st.buttonSize === 'large');
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg || '#000');
  try { localStorage.setItem('mnemo-theme', JSON.stringify({ theme: st.theme, accent: st.accent })); } catch {}
}

// ---------- navigation ----------
const TABS = [['decks', 'decks', 'Paquets'], ['add', 'plus', 'Ajouter'], ['browse', 'search', 'Parcourir'], ['stats', 'stats', 'Stats'], ['settings', 'settings', 'Réglages']];
function buildTabbar() {
  $('#tabbar').replaceChildren(...TABS.map(([r, i, l]) => h('a', { href: '#/' + r, class: 'tab', 'data-tab': r }, ic(i, 22), h('span', null, t(l)))));
}
const ROUTES = {
  decks: viewDecks, deck: viewDeck, study: viewStudy, add: viewAdd, edit: viewEdit, browse: viewBrowse, stats: viewStats,
  settings: viewSettings, notetypes: viewNotetypes, notetype: viewNotetype, presets: viewPresets, preset: viewPreset,
  import: viewImport, export: viewExport,
};
const TAB_OF = { deck: 'decks', study: 'decks', import: 'decks', export: 'decks', edit: 'browse', notetypes: 'settings', notetype: 'settings', presets: 'settings', preset: 'settings' };
function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  const [name, arg] = path.split('/');
  const fn = ROUTES[name] || viewDecks;
  try { cleanup?.(); } catch {}
  cleanup = null; closeAllSheets(); stopAudio();
  const tab = TAB_OF[name] || (ROUTES[name] ? name : 'decks');
  document.querySelectorAll('.tab').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  document.body.classList.toggle('studying', name === 'study');
  const el = $('#view');
  el.replaceChildren(); window.scrollTo(0, 0);
  const token = ++routeToken;
  Promise.resolve(fn(el, arg ? decodeURIComponent(arg) : null, new URLSearchParams(qs || ''))).then(c => {
    if (typeof c === 'function') { if (token === routeToken) cleanup = c; else c(); }
  }).catch(e => { console.error(e); el.append(h('p', { class: 'error' }, e.message)); });
}
const rerender = () => route();

// ---------- synchronisation (interface) ----------
function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return t("à l'instant");
  const m = Math.round(s / 60);
  return m < 60 ? t('il y a {n} min', { n: m }) : t('le {d}', { d: dateTime(ts) });
}
function syncStatusText() {
  const s = sync.state;
  switch (s.status) {
    case 'syncing': return s.progress || t('Synchronisation…');
    case 'idle': return s.error || (s.lastSync ? t('Synchronisé {t}', { t: ago(s.lastSync) }) : t('Prêt'));
    case 'offline': return t('Hors ligne : synchro au retour du réseau');
    case 'error': return t('Erreur : {e}', { e: s.error });
    case 'loggedout': return s.error || t('Non connecté');
    default: return t('Désactivée');
  }
}
function syncIndicator() {
  if (!configured()) return { el: null, off: () => {} };
  const b = iconBtn('cloud', t('Synchronisation'), () => { if (loggedIn()) { syncNow(); toast(t('Synchronisation…')); } else go('settings'); });
  const upd = () => { b.className = 'icon-btn sync-ind ' + sync.state.status; b.title = syncStatusText(); b.setAttribute('aria-label', b.title); };
  upd();
  return { el: b, off: sync.onChange(upd) };
}
function firstSyncChoice() {
  return new Promise(res => {
    let done = false;
    const pick = v => { done = true; close(); res(v); };
    const close = sheet(t('Première synchronisation'), h('div', { class: 'form' },
      h('p', null, t('Le cloud contient déjà une collection, et cet appareil aussi. Que veux-tu faire ?')),
      h('button', { class: 'btn primary', onclick: () => pick('merge') }, t('Fusionner les deux (recommandé)')),
      h('button', { class: 'btn', onclick: () => pick('cloud') }, t('Garder seulement le cloud')),
      h('button', { class: 'btn', onclick: () => pick('device') }, t('Garder seulement cet appareil')),
      h('p', { class: 'muted small' }, t('« Garder seulement » supprime l\'autre version. Dans le doute, fusionne.'))),
      { onClose: () => { if (!done) res(null); } });
  });
}
function syncGuide() {
  const steps = [
    t('Crée un compte gratuit sur supabase.com, puis un nouveau projet (New project). Choisis la région la plus proche, par exemple Frankfurt. Le mot de passe de la base ne sert pas à Mnemo, mais garde-le.'),
    t('Dans le projet, ouvre SQL Editor, colle le script (bouton ci-dessous) et clique sur Run. « Success » confirme que c\'est bon.'),
    t('Dans Authentication → Sign In / Providers → Email, désactive « Confirm email » pour pouvoir te connecter tout de suite.'),
    t('Clique sur Connect en haut du projet (ou Project Settings → API Keys) et copie l\'URL du projet et la clé publishable (sb_publishable_…). L\'ancienne clé anon fonctionne aussi.'),
    t('Colle l\'URL et la clé dans Mnemo, enregistre, puis crée ton compte. Sur tes autres appareils : même URL, même clé, puis « Se connecter ».'),
  ];
  const ta = h('textarea', { class: 'input code', rows: 10, readonly: true }); ta.value = SETUP_SQL;
  sheet(t('Configurer la synchronisation'), h('div', { class: 'form' },
    h('ol', { class: 'steps' }, steps.map(s => h('li', null, s))),
    h('button', { class: 'btn primary', onclick: async () => {
      try { await navigator.clipboard.writeText(SETUP_SQL); toast(t('Script copié')); }
      catch { ta.closest('details').open = true; ta.focus(); ta.select(); toast(t('Sélectionne le texte et copie-le.')); }
    } }, t('Copier le script SQL')),
    h('details', null, h('summary', null, t('Voir le script')), ta),
    h('p', { class: 'muted small' }, t('Gratuit : 2 projets actifs par compte Supabase. Un projet gratuit se met en pause après une semaine sans utilisation : réactive-le depuis supabase.com. Mnemo reste utilisable hors ligne entre-temps.'))), { cls: 'tall' });
}
function syncSection() {
  const box = h('div', { class: 'set-list' });
  const el = h('section', { class: 'set-sec' }, h('h2', null, t('Synchronisation')), box);
  let mode = null, statusEl = null, syncBtn = null, loginNote = null;
  const modeOf = () => !configured() ? 'cfg' : !loggedIn() ? 'login' : 'on';
  const field = (label, input) => h('label', { class: 'mini' }, h('span', null, label), input);
  function render() {
    mode = modeOf();
    const s = sync.state;
    if (mode === 'cfg') {
      const url = h('input', { class: 'input', placeholder: 'https://xxxx.supabase.co', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
      const key = h('input', { class: 'input', placeholder: 'sb_publishable_…', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
      box.replaceChildren(
        h('div', { class: 'set-row col' },
          h('div', { class: 'set-label' }, h('span', null, t('Synchroniser tes appareils')),
            h('small', null, t('Avec un projet Supabase gratuit, ta collection est la même sur ton téléphone et ton ordinateur. Compte environ 5 minutes de configuration.'))),
          h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: syncGuide }, ic('help', 16), t('Guide de configuration')))),
        h('div', { class: 'set-row col' }, field(t('URL du projet'), url), field(t('Clé publishable (ou anon)'), key),
          h('div', { class: 'row' }, h('button', { class: 'btn primary small', onclick: () => {
            try { setConfig(url.value, key.value); toast(t('Projet enregistré')); } catch (e) { toast(e.message); }
          } }, t('Enregistrer')))));
      return;
    }
    if (mode === 'login') {
      const email = h('input', { class: 'input', type: 'email', placeholder: t('E-mail'), autocomplete: 'username', autocapitalize: 'off', autocorrect: 'off' });
      const pw = h('input', { class: 'input', type: 'password', placeholder: t('Mot de passe (6 caractères minimum)'), autocomplete: 'current-password' });
      loginNote = h('small', null, s.error || t('Utilise le même compte sur tous tes appareils.'));
      const run = async (fn, btn) => {
        if (!email.value.includes('@') || pw.value.length < 6) { toast(t('Saisis un e-mail et un mot de passe de 6 caractères minimum.')); return; }
        btn.disabled = true;
        try { const r = await fn(email.value, pw.value); if (r === 'confirm') toast(t('Compte créé : valide le lien reçu par e-mail, puis connecte-toi. (Ou désactive « Confirm email » dans Supabase.)'), 7000); }
        catch (e) { toast(e.message, 5000); }
        finally { btn.disabled = false; }
      };
      const inBtn = h('button', { class: 'btn primary small', onclick: () => run(signIn, inBtn) }, t('Se connecter'));
      const upBtn = h('button', { class: 'btn small', onclick: () => run(signUp, upBtn) }, t('Créer un compte'));
      box.replaceChildren(
        h('div', { class: 'set-row col' }, h('div', { class: 'set-label' }, h('span', null, t('Connexion')), loginNote), email, pw, h('div', { class: 'row wrap' }, inBtn, upBtn)),
        linkRow(t('Changer de projet Supabase'), async () => { if (await confirmBox(t('Oublier ce projet sur cet appareil ? Tes données locales et celles du cloud ne sont pas effacées.'))) forgetConfig(); }, new URL(sync.state.cfg.url).host));
      return;
    }
    statusEl = h('small', null, syncStatusText());
    syncBtn = h('button', { class: 'btn small', disabled: s.busy, onclick: () => syncNow() }, ic('refresh', 16), t('Synchroniser'));
    box.replaceChildren(
      setRow(t('Compte'), h('span', { class: 'muted small' }, s.auth?.user?.email || '')),
      h('div', { class: 'set-row' }, h('div', { class: 'set-label' }, h('span', null, t('État')), statusEl), syncBtn),
      h('details', { class: 'adv' }, h('summary', null, t('Options avancées')),
        h('div', { class: 'stack pad' },
          h('button', { class: 'btn small', onclick: async () => { if (await confirmBox(t('Remplacer la collection de cet appareil par celle du cloud ?'), { danger: true, ok: t('Remplacer') })) resetFrom('cloud'); } }, t('Remplacer cet appareil par le cloud')),
          h('button', { class: 'btn small', onclick: async () => { if (await confirmBox(t('Remplacer le cloud par cet appareil ? Ce qui n\'existe pas ici sera supprimé sur tous tes appareils.'), { danger: true, ok: t('Remplacer') })) resetFrom('device'); } }, t('Remplacer le cloud par cet appareil')),
          h('button', { class: 'btn small danger', onclick: async () => { await signOut(); toast(t('Déconnecté')); } }, t('Se déconnecter')))));
  }
  render();
  const off = sync.onChange(() => {
    if (modeOf() !== mode) return render();
    if (statusEl) statusEl.textContent = syncStatusText();
    if (syncBtn) syncBtn.disabled = sync.state.busy;
    if (loginNote && sync.state.error) loginNote.textContent = sync.state.error;
  });
  const tick = setInterval(() => { if (statusEl) statusEl.textContent = syncStatusText(); }, 30000);
  return { el, off: () => { off(); clearInterval(tick); } };
}

// ---------- paquets et dossiers ----------
const isFolder = id => !!S.decks.get(id)?.folder;
function pathLabel(name) { return name.split('::').join(' / '); }
function folderTargets(excludeId = null) {
  const banned = new Set(excludeId != null ? deckSubtree(excludeId) : []);
  return [...S.decks.values()].filter(d => d.folder && !banned.has(d.id)).sort((a, b) => a.name.localeCompare(b.name, getLang()));
}
function uniqueDeckName(name) {
  if (deckByName(name, false) == null) return name;
  let i = 2; while (deckByName(`${name} (${i})`, false) != null) i++;
  return `${name} (${i})`;
}
async function createDeck(parent = null, { folder = false, open = false } = {}) {
  const p = parent != null ? S.decks.get(parent) : null;
  const name = await ask(folder ? t('Nouveau dossier') : t('Nouveau paquet'), {
    placeholder: folder ? t('Nom du dossier') : t('Nom du paquet'),
    label: p ? t('Dans « {d} »', { d: pathLabel(p.name) }) : '', ok: t('Créer'),
  });
  if (!name) return null;
  const full = (p ? p.name + '::' : '') + name.trim();
  if (deckByName(full, false) != null) { toast(t('Un paquet porte déjà ce nom.')); return null; }
  const id = deckByName(full);
  if (folder) { const d = S.decks.get(id); d.folder = true; saveDeck(d); }
  toast(folder ? t('Dossier créé') : t('Paquet créé'));
  if (open) go('deck/' + id); else rerender();
  return id;
}
function moveDeckInto(did, parentId) {
  const leaf = deckLeaf(S.decks.get(did).name);
  renameDeck(did, parentId == null ? leaf : S.decks.get(parentId).name + '::' + leaf);
}
function moveTo(did) {
  const d = S.decks.get(did);
  const cur = deckParent(did);
  let target = cur;
  const targets = folderTargets(did);
  const sel = h('select', { class: 'select', onchange: e => { target = e.target.value === '' ? null : +e.target.value; } },
    h('option', { value: '', selected: cur == null }, t('Aucun dossier (racine)')),
    targets.map(f => h('option', { value: f.id, selected: f.id === cur }, pathLabel(f.name))));
  const close = sheet(t('Déplacer « {d} »', { d: deckLeaf(d.name) }), h('div', { class: 'form' },
    targets.length ? sel : h('p', { class: 'muted' }, t("Aucun dossier pour l'instant.")),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: async () => {
        close();
        const fid = await createDeck(null, { folder: true });
        if (fid == null) return;
        try { moveDeckInto(did, fid); toast(t('Déplacé')); rerender(); } catch (e) { toast(e.message); }
      } }, ic('plus', 16), t('Nouveau dossier')),
      targets.length ? h('button', { class: 'btn primary', onclick: () => {
        if (target === cur) return close();
        try { moveDeckInto(did, target); close(); toast(t('Déplacé')); rerender(); } catch (e) { toast(e.message); }
      } }, t('Déplacer')) : null)));
}
function deleteFolderOnly(did) {
  const parent = deckParent(did);
  const prefix = parent != null ? S.decks.get(parent).name + '::' : '';
  for (const ch of deckChildren(did).slice()) renameDeck(ch, uniqueDeckName(prefix + deckLeaf(S.decks.get(ch).name)));
  for (const c of S.cards.values()) if (c.did === did) { c.did = parent ?? 1; saveCard(c); }
  S.decks.delete(did); persist.del('decks', did); invalidateDecks();
}
function deckActions(did) {
  const d = S.decks.get(did);
  const folder = !!d.folder;
  const leaf = deckLeaf(d.name);
  const count = () => { const ids = new Set(deckSubtree(did)); let n = 0; for (const c of S.cards.values()) if (ids.has(c.did)) n++; return n; };
  return [
    { label: t('Renommer'), icon: 'edit', onclick: async () => {
      const name = await ask(folder ? t('Renommer le dossier') : t('Renommer le paquet'), { value: leaf });
      if (!name || name === leaf) return;
      const i = d.name.lastIndexOf('::');
      try { renameDeck(did, name.includes('::') ? name : (i > 0 ? d.name.slice(0, i + 2) : '') + name); rerender(); } catch (e) { toast(e.message); }
    } },
    { label: t('Déplacer vers un dossier'), icon: 'folder', onclick: () => moveTo(did) },
    folder ? { label: t('Ajouter des paquets'), icon: 'plus', onclick: () => addDecksToFolder(did) } : null,
    !folder ? { label: t('Options du paquet'), icon: 'settings', onclick: () => go(`preset/${d.conf || 1}?deck=${did}`) } : null,
    { label: t('Exporter'), icon: 'download', onclick: () => go(`export?deck=${did}`) },
    { label: t('Statistiques'), icon: 'stats', onclick: () => go(`stats?deck=${did}`) },
    folder ? { label: t('Supprimer le dossier (garder les paquets)'), icon: 'close', danger: true, onclick: async () => {
      if (!await confirmBox(t("Supprimer le dossier « {d} » ? Les paquets qu'il contient remontent d'un niveau.", { d: leaf }), { danger: true, ok: t('Supprimer') })) return;
      try { deleteFolderOnly(did); toast(t('Dossier supprimé')); go('decks'); } catch (e) { toast(e.message); }
    } } : null,
    did !== 1 ? { label: folder ? t('Supprimer le dossier et son contenu') : t('Supprimer'), icon: 'close', danger: true, onclick: async () => {
      const n = count();
      if (await confirmBox(tn(n, 'Supprimer « {d} » et sa carte ? Cette action est définitive.', 'Supprimer « {d} » et ses {n} cartes ? Cette action est définitive.', { d: leaf }), { danger: true, ok: t('Supprimer') })) {
        deleteDeck(did); toast(folder ? t('Dossier supprimé') : t('Paquet supprimé')); go('decks');
      }
    } } : null,
  ];
}
function addDecksToFolder(fid) {
  const f = S.decks.get(fid);
  const banned = new Set([...deckSubtree(fid), ...deckAncestors(fid)]);
  const cands = [...S.decks.values()].filter(d => !banned.has(d.id)).sort((a, b) => a.name.localeCompare(b.name, getLang()));
  const chosen = new Set();
  const list = h('div', { class: 'pick-list' }, cands.map(d => h('label', { class: 'pick-row', style: `--depth:${d.name.split('::').length - 1}` },
    h('input', { type: 'checkbox', onchange: e => { e.target.checked ? chosen.add(d.id) : chosen.delete(d.id); } }),
    d.folder ? ic('folder', 18) : null, h('span', null, deckLeaf(d.name)))));
  const close = sheet(t('Ajouter au dossier « {d} »', { d: deckLeaf(f.name) }), h('div', { class: 'form' },
    cands.length ? list : h('p', { class: 'muted' }, t('Aucun autre paquet à déplacer.')),
    h('div', { class: 'actions' }, cands.length ? h('button', { class: 'btn primary', onclick: () => {
      const ids = [...chosen].filter(id => !deckAncestors(id).some(a => chosen.has(a)));
      let moved = 0;
      for (const id of ids) { try { moveDeckInto(id, fid); moved++; } catch (e) { toast(e.message); } }
      close(); if (moved) toast(tn(moved, '{n} paquet déplacé', '{n} paquets déplacés')); rerender();
    } }, t('Déplacer')) : null)));
}

function deckListEl(ids, counts, { hideEmptyDefault = false } = {}) {
  const hasCards = new Set([...S.cards.values()].map(c => c.did));
  const subHasCards = id => deckSubtree(id).some(x => hasCards.has(x));
  const list = h('div', { class: 'deck-list', role: 'list' },
    h('div', { class: 'deck-head', 'aria-hidden': 'true' }, h('span'), h('span', { class: 'n new' }, t('Nouv.')), h('span', { class: 'n learn' }, t('Appr.')), h('span', { class: 'n rev' }, t('À rev.'))));
  const num = (n, cls) => h('span', { class: `n ${cls}${n ? '' : ' zero'}` }, n);
  const addRow = (id, depth) => {
    const d = S.decks.get(id), ch = deckChildren(id), c = counts.get(id);
    if (hideEmptyDefault && id === 1 && !ch.length && S.decks.size > 1 && !subHasCards(1)) return;
    list.append(h('div', { class: 'deck-row' + (d.folder ? ' folder' : ''), role: 'listitem', style: `--depth:${depth}` },
      ch.length ? h('button', { class: 'twisty' + (d.collapsed ? ' collapsed' : ''), 'aria-label': d.collapsed ? t('Déplier') : t('Replier'), 'aria-expanded': String(!d.collapsed),
        onclick: () => { d.collapsed = !d.collapsed; saveDeck(d); rerender(); } }, ic('caret', 16)) : h('span', { class: 'twisty' }),
      h('a', { class: 'deck-name', href: '#/deck/' + id }, d.folder ? ic('folder', 19) : null, h('span', null, deckLeaf(d.name))),
      h('a', { class: 'deck-counts', href: '#/deck/' + id, tabindex: '-1' }, num(c.new, 'new'), num(c.learn, 'learn'), num(c.rev, 'rev'))));
    if (!d.collapsed) for (const k of ch) addRow(k, depth + 1);
  };
  for (const id of ids) addRow(id, 0);
  return list;
}

function viewDecks(el) {
  const counts = deckCounts();
  const ind = syncIndicator();
  el.append(header({ title: 'Mnemo', cls: 'brand', actions: [
    ind.el,
    iconBtn('upload', t('Importer'), () => go('import')),
    iconBtn('more', t('Plus'), () => menu(t('Collection'), [
      { label: t('Créer un paquet'), icon: 'plus', onclick: () => createDeck() },
      { label: t('Créer un dossier'), icon: 'folder', onclick: () => createDeck(null, { folder: true }) },
      { label: t('Importer des fichiers'), icon: 'upload', onclick: () => go('import') },
      { label: t('Exporter'), icon: 'download', onclick: () => go('export') },
      { label: t('Sauvegarder la collection'), icon: 'download', onclick: () => go('export?format=backup') },
    ])),
  ] }));
  if (!S.cards.size && S.decks.size <= 1) {
    el.append(h('div', { class: 'empty' },
      h('h2', null, t('Votre collection est vide')),
      h('p', null, t('Ajoutez une première note ou importez un paquet Anki (.apkg), un CSV, un fichier Markdown ou un QCM au format GIFT.')),
      h('div', { class: 'actions center' }, h('a', { class: 'btn primary', href: '#/add' }, t('Ajouter une note')), h('a', { class: 'btn', href: '#/import' }, t('Importer'))),
      !configured() ? h('p', { class: 'muted small' }, h('a', { href: '#/settings', class: 'link' }, t('Synchroniser avec un autre appareil'))) : null));
    return ind.off;
  }
  const tops = topDecks();
  let due = 0; for (const id of tops) { const c = counts.get(id); due += c.new + c.learn + c.rev; }
  el.append(h('p', { class: 'summary' }, due ? tn(due, "{n} carte à étudier aujourd'hui", "{n} cartes à étudier aujourd'hui") : t("Tout est à jour pour aujourd'hui.")));
  el.append(deckListEl(tops, counts, { hideEmptyDefault: true }), h('div', { class: 'actions center' },
    h('button', { class: 'btn ghost', onclick: () => createDeck() }, ic('plus', 18), t('Créer un paquet')),
    h('button', { class: 'btn ghost', onclick: () => createDeck(null, { folder: true }) }, ic('folder', 18), t('Créer un dossier'))));
  return ind.off;
}

function viewDeck(el, id) {
  const did = +id, d = S.decks.get(did);
  if (!d) return go('decks');
  const counts = deckCounts();
  const c = counts.get(did);
  const total = c.new + c.learn + c.rev;
  const path = d.name.split('::');
  const parent = deckParent(did);
  el.append(header({ title: path[path.length - 1], back: parent != null && isFolder(parent) ? 'deck/' + parent : 'decks',
    actions: [iconBtn('more', d.folder ? t('Actions du dossier') : t('Actions du paquet'), () => menu(pathLabel(d.name), deckActions(did)))] }));
  if (!d.folder) { S.settings.lastDeck = did; saveSettings(); }
  const box = h('div', { class: 'deck-hero' },
    path.length > 1 ? h('p', { class: 'crumbs' }, path.slice(0, -1).join(' / ')) : null,
    h('div', { class: 'big-counts' },
      h('div', { class: 'new' }, h('b', null, c.new), h('span', null, t('Nouvelles'))),
      h('div', { class: 'learn' }, h('b', null, c.learn), h('span', null, t('Apprentissage'))),
      h('div', { class: 'rev' }, h('b', null, c.rev), h('span', null, t('À revoir')))));
  if (total) box.append(h('button', { class: 'btn primary xl', onclick: () => { pendingSession = null; go('study/' + did); } }, d.folder ? t('Étudier le dossier') : t('Étudier')));
  else {
    const ids = new Set(deckSubtree(did)); let next = Infinity;
    for (const k of S.cards.values()) if (ids.has(k.did) && (k.queue === 2 || k.queue === 3)) next = Math.min(next, k.due);
    const days = next - today();
    box.append(h('p', { class: 'done-note' }, t("Rien à étudier pour l'instant."), ' ',
      Number.isFinite(next) ? (days <= 1 ? t('Prochaines révisions demain.') : t('Prochaines révisions dans {n}.', { n: fmtIvl(days) })) : ''));
  }
  if (d.folder) {
    const kids = deckChildren(did);
    el.append(box, kids.length ? deckListEl(kids, counts) : h('p', { class: 'muted pad' }, t('Ce dossier est vide.')),
      h('div', { class: 'quick' },
        h('button', { class: 'btn', onclick: () => createDeck(did) }, ic('plus', 18), t('Nouveau paquet ici')),
        h('button', { class: 'btn', onclick: () => createDeck(did, { folder: true }) }, ic('folder', 18), t('Nouveau sous-dossier')),
        h('button', { class: 'btn', onclick: () => addDecksToFolder(did) }, t('Ajouter des paquets')),
        total ? h('button', { class: 'btn', onclick: () => customStudy(did) }, t('Étude personnalisée')) : null));
    return;
  }
  box.append(h('div', { class: 'quick' },
    h('button', { class: 'btn', onclick: () => customStudy(did) }, t('Étude personnalisée')),
    h('a', { class: 'btn', href: '#/add', onclick: () => { S.settings.lastDeck = did; saveSettings(); } }, t('Ajouter')),
    h('a', { class: 'btn', href: '#/browse?q=' + encodeURIComponent(`deck:"${d.name}"`) }, t('Parcourir')),
    h('a', { class: 'btn', href: `#/preset/${d.conf || 1}?deck=${did}` }, t('Options'))));
  if (d.desc) box.append(h('p', { class: 'desc' }, stripHtml(d.desc)));
  el.append(box);
}

function customStudy(did) {
  const d = S.decks.get(did);
  let mode = 'new';
  const nums = { new: 10, rev: 50, forgot: 1, ahead: 3 };
  const q = h('input', { class: 'input', placeholder: t('ex. tag:chapitre3 ou is:due') });
  let noSched = true;
  const opt = (k, text, withNum) => h('label', { class: 'radio-row' },
    h('input', { type: 'radio', name: 'cs', checked: k === mode, onchange: () => { mode = k; } }),
    h('span', null, text[0], withNum ? h('input', { class: 'input num', type: 'number', min: 1, value: nums[k], onchange: e => { nums[k] = Math.max(1, +e.target.value || 1); }, onclick: () => { mode = k; } }) : null, text[1] || ''));
  const body = h('div', { class: 'form' },
    opt('new', [t("Augmenter la limite de nouvelles cartes d'aujourd'hui de "), ''], true),
    opt('rev', [t("Augmenter la limite de révisions d'aujourd'hui de "), ''], true),
    opt('forgot', [t('Revoir les cartes oubliées ces '), t(' derniers jours')], true),
    opt('ahead', [t('Réviser en avance : cartes dues dans les '), t(' prochains jours')], true),
    opt('search', [t('Étudier une sélection (recherche)')], false), q,
    setRow(t('Sans modifier la planification'), toggle(noSched, v => { noSched = v; }), t('Pour la sélection : idéal pour réviser avant un examen.')),
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: start }, t('Commencer'))));
  const close = sheet(t('Étude personnalisée'), body);
  function start() {
    const scope = `deck:"${d.name}"`;
    if (mode === 'new' || mode === 'rev') { extendLimit(did, mode, nums[mode]); close(); pendingSession = null; go('study/' + did); return; }
    let cids, cram = true, title = '';
    if (mode === 'forgot') { cids = searchCards(`${scope} rated:${nums.forgot}:1`).map(c => c.id); title = t('Cartes oubliées'); }
    else if (mode === 'ahead') {
      const lim = today() + nums.ahead; const ids = new Set(deckSubtree(did));
      cids = [...S.cards.values()].filter(c => ids.has(c.did) && (c.queue === 2 || c.queue === 3) && c.due <= lim).sort((a, b) => a.due - b.due).map(c => c.id);
      cram = false; title = t('Révision en avance');
    } else {
      if (!q.value.trim()) { toast(t('Saisissez une recherche.')); return; }
      cids = searchCards(`${scope} (${q.value})`).filter(c => c.queue !== -1).map(c => c.id); cram = noSched; title = t('Sélection');
    }
    if (!cids.length) { toast(t('Aucune carte ne correspond.')); return; }
    close();
    pendingSession = new Session({ cids, cram, title });
    pendingSession.backTo = 'deck/' + did;
    go('study/' + did);
  }
}

// ---------- étude ----------
const GESTURE_ACTIONS = () => [['none', t('Aucune')], ['reveal', t('Afficher la réponse')], ['again', t('À revoir')], ['hard', t('Difficile')], ['good', t('Correct')], ['easy', t('Facile')],
  ['undo', t('Annuler')], ['edit', t('Modifier la note')], ['flag', t('Drapeau rouge')], ['mark', t('Marquer')], ['bury', t('Enfouir')], ['suspend', t('Suspendre')], ['replay', t('Rejouer le son')]];
const ACT_COLOR = { again: 'var(--again)', hard: 'var(--hard)', good: 'var(--good)', easy: 'var(--easy)' };

function viewStudy(el, arg) {
  let session = pendingSession; pendingSession = null;
  if (!session) {
    const did = +arg;
    if (!S.decks.has(did)) return go('decks');
    session = new Session({ did });
    session.backTo = 'deck/' + did;
  }
  const backTo = session.backTo || 'decks';
  const host = h('div', { class: 'card-host' });
  const frame = h('div', { class: 'card-frame' }, host);
  const swipeLabel = h('div', { class: 'swipe-label', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'stage' }, frame, swipeLabel);
  const counts = h('div', { class: 'study-counts', 'aria-live': 'polite' });
  const timerEl = h('span', { class: 'timer' });
  const undoBtn = iconBtn('undo', t('Annuler la dernière réponse'), () => undo());
  const top = h('header', { class: 'top study-top' },
    iconBtn('back', t('Retour'), () => go(backTo)), counts,
    h('div', { class: 'top-actions' }, timerEl, undoBtn, iconBtn('more', t('Actions'), () => openMenu())));
  const bar = h('div', { class: 'answer-bar' });
  el.append(top, stage, bar);

  let card = null, revealed = false, st = {}, shownAt = 0, waitTimer = null, tick = null, busy = false, mountTok = 0;
  const handlers = () => { const tok = ++mountTok; return { reveal: () => reveal(), changed: () => renderBar(), stale: () => tok !== mountTok }; };

  function renderCounts() {
    const c = session.counts();
    if (session.cram) { counts.replaceChildren(h('span', { class: 'n rev on' }, c.rev), session.title ? h('span', { class: 'muted small' }, session.title) : null); return; }
    const kind = card ? session.kindOf(card) : null;
    counts.replaceChildren(
      h('span', { class: 'n new' + (kind === 'new' ? ' on' : '') }, c.new),
      h('span', { class: 'n learn' + (kind === 'learn' ? ' on' : '') }, c.learn),
      h('span', { class: 'n rev' + (kind === 'rev' ? ' on' : '') }, c.rev));
    counts.hidden = !S.settings.showCounts;
    undoBtn.disabled = !session.canUndo();
  }
  function showCard(c) {
    clearInterval(waitTimer);
    card = c;
    if (!card) return finished();
    if (!host.isConnected) frame.replaceChildren(host);
    revealed = false; st = { seed: hash32(card.id, card.reps, session.done) };
    shownAt = Date.now(); busy = false;
    frame.style.transform = ''; swipeLabel.style.opacity = 0;
    renderCounts();
    stage.scrollTop = 0;
    mountCard(host, card, 'q', st, handlers()).then(renderBar);
    renderBar();
  }
  const next = () => showCard(session.next());
  async function reveal() {
    if (!card || revealed) return;
    revealed = true; stopAudio();
    renderBar();
    await mountCard(host, card, 'a', st, { ...handlers(), focusInput: false });
    renderBar();
    if (getComputedStyle(stage).overflowY !== 'visible') {
      const ans = host.shadowRoot?.querySelector('#answer');
      if (ans) stage.scrollTo({ top: Math.max(0, ans.getBoundingClientRect().top - stage.getBoundingClientRect().top + stage.scrollTop - 24), behavior: 'smooth' });
    }
  }
  function rate(ease) {
    if (!card || busy) return;
    if (!revealed) { reveal(); return; }
    busy = true;
    const r = session.answer(card, ease, Date.now() - shownAt);
    if (r.leech) toast(presetOf(card.did).leechAction === 'suspend' ? t('Sangsue : carte suspendue après trop d\'oublis') : t('Sangsue : étiquette « leech » ajoutée'));
    stopAudio();
    next();
  }
  function undo() {
    if (!session.canUndo()) { toast(t('Rien à annuler')); return; }
    const c = session.undo();
    toast(t('Réponse annulée'));
    showCard(c || session.next());
  }
  function renderBar() {
    if (!card) { bar.replaceChildren(); return; }
    if (!revealed) {
      const multi = st.multi && st.selected?.size;
      bar.replaceChildren(h('button', { class: 'btn reveal', onclick: () => reveal() }, multi ? t('Valider la réponse') : t('Afficher la réponse'), h('kbd', null, t('Espace'))));
      return;
    }
    const ivl = !session.cram && S.settings.showIntervals ? previewIntervals(card) : null;
    const four = S.settings.buttons !== 2;
    const items = four ? [[1, t('À revoir'), 'again'], [2, t('Difficile'), 'hard'], [3, t('Correct'), 'good'], [4, t('Facile'), 'easy']] : [[1, t('À revoir'), 'again'], [3, t('Correct'), 'good']];
    const suggest = S.settings.suggestGrade && st.verdict != null ? (st.verdict ? 3 : 1) : null;
    bar.replaceChildren(h('div', { class: 'grades' + (four ? '' : ' two') }, items.map(([e, label, cls]) =>
      h('button', { class: `grade ${cls}${suggest === e ? ' suggest' : ''}`, onclick: () => rate(e) },
        ivl ? h('small', null, fmtIvl(ivl[e])) : null, h('span', null, label)))));
  }
  function finished() {
    card = null; renderCounts(); bar.replaceChildren();
    const nextL = session.cram ? null : session.nextLearningDue();
    const msg = h('p', { class: 'muted' });
    const body = h('div', { class: 'finished' },
      h('h2', null, session.done ? t('Séance terminée') : t('Rien à étudier pour le moment')),
      session.done ? h('p', null, tn(session.done, '{n} carte revue en {d}.', '{n} cartes revues en {d}.', { d: fmtDuration(session.time) }),
        session.done ? ' ' + t('Taux de réussite : {p} %.', { p: Math.round((session.done - session.again) / session.done * 100) }) : '') : null,
      msg,
      h('div', { class: 'actions center' },
        session.did != null ? h('button', { class: 'btn', onclick: () => customStudy(session.did) }, t('Étude personnalisée')) : null,
        h('button', { class: 'btn primary', onclick: () => go(backTo) }, t('Terminer'))));
    host.shadowRoot?.replaceChildren();
    frame.replaceChildren(body);
    if (nextL) {
      const upd = () => {
        const left = nextL - Date.now();
        const c = session.next();
        if (c) { frame.replaceChildren(host); showCard(c); return; }
        msg.textContent = t('Une carte en apprentissage revient dans {n}.', { n: fmtIvl(Math.max(0, left) / 864e5) });
      };
      upd(); waitTimer = setInterval(upd, 5000);
    }
  }

  // Actions du menu et des gestes
  const note = () => card && S.notes.get(card.nid);
  function editNote() {
    if (!card) return;
    const close = sheet(t('Modifier la note'), noteEditor({ note: note(), inSheet: true, onSaved: () => {
      close(); if (!S.cards.has(card.id)) return next();
      mountCard(host, card, revealed ? 'a' : 'q', st, handlers()).then(renderBar);
    } }), { cls: 'tall' });
  }
  function act(fn, msg) { if (!card) return; fn(); if (msg) toast(msg); next(); }
  const flagCard = f => { if (!card) return; setFlag([card], (card.flags & 7) === f ? 0 : f); toast((card.flags & 7) ? t('Drapeau ajouté') : t('Drapeau retiré')); };
  const markNote = () => { const n = note(); if (!n) return; const on = n.tags.some(x => x.toLowerCase() === 'marked'); on ? removeTags(n, ['marked']) : addTags(n, ['marked']); toast(on ? t('Note démarquée') : t('Note marquée')); };
  const replay = () => { const r = host.shadowRoot?.querySelector('.card'); if (r) playAll(r, revealed); };
  const ACTIONS = {
    reveal: () => reveal(), again: () => rate(1), hard: () => rate(S.settings.buttons === 2 ? 1 : 2), good: () => rate(3), easy: () => rate(S.settings.buttons === 2 ? 3 : 4),
    undo, edit: editNote, flag: () => flagCard(1), mark: markNote, replay,
    bury: () => act(() => bury([card]), t('Carte enfouie jusqu\'à demain')), suspend: () => act(() => setSuspended([card], true), t('Carte suspendue')),
  };
  const doAction = a => ACTIONS[a]?.();
  function openMenu() {
    if (!card) return;
    const flags = h('div', { class: 'flags' }, [1, 2, 3, 4, 5, 6, 7].map(f => h('button', { class: `flag f${f}${(card.flags & 7) === f ? ' on' : ''}`, 'aria-label': t('Drapeau {n}', { n: f }), onclick: () => { flagCard(f); close(); } })));
    const close = menu(t('Carte'), [
      { label: t('Modifier la note'), icon: 'edit', hint: 'E', onclick: editNote },
      { node: h('div', { class: 'menu-flags' }, h('span', null, t('Drapeau')), flags) },
      { label: note()?.tags.some(x => x.toLowerCase() === 'marked') ? t('Démarquer la note') : t('Marquer la note'), hint: '*', onclick: markNote },
      { label: t('Rejouer le son'), icon: 'play', hint: 'R', onclick: replay },
      { sep: true },
      { label: t('Enfouir la carte'), hint: '−', onclick: ACTIONS.bury },
      { label: t('Enfouir la note'), onclick: () => act(() => bury(noteCards(card.nid)), t('Note enfouie jusqu\'à demain')) },
      { label: t('Suspendre la carte'), hint: '@', onclick: ACTIONS.suspend },
      { label: t('Suspendre la note'), onclick: () => act(() => setSuspended(noteCards(card.nid), true), t('Note suspendue')) },
      { label: t('Infos de la carte'), onclick: () => cardInfo(card) },
      { label: t('Options du paquet'), icon: 'settings', onclick: () => go(`preset/${presetOf(card.did).id}?deck=${card.did}`) },
      { sep: true },
      { label: t('Supprimer la note'), danger: true, onclick: async () => {
        if (await confirmBox(t('Supprimer cette note et toutes ses cartes ?'), { danger: true, ok: t('Supprimer') })) act(() => deleteNotes([card.nid]), t('Note supprimée'));
      } },
    ]);
  }

  // Gestes tactiles
  let ptr = null, longTimer = null, tapTimer = null;
  const G = () => S.settings.gestures;
  const gestureLabel = a => GESTURE_ACTIONS().find(x => x[0] === a)?.[1] || '';
  const interactive = e => e.composedPath().some(n => n.matches?.('button,input,textarea,select,a,audio,video,.mn-opt,.mn-tfb,[data-mn-hint]'));
  const resetFrame = () => { frame.style.transition = 'transform .2s ease'; frame.style.transform = ''; swipeLabel.style.opacity = 0; setTimeout(() => { frame.style.transition = ''; }, 200); };
  stage.addEventListener('pointerdown', e => {
    if (!card || (e.pointerType === 'mouse' && e.button !== 0) || interactive(e)) { ptr = null; return; }
    ptr = { x: e.clientX, y: e.clientY, t: Date.now(), id: e.pointerId, moved: false, horiz: null, dx: 0, dy: 0 };
    clearTimeout(longTimer);
    if (G().long !== 'none') longTimer = setTimeout(() => { if (ptr && !ptr.moved) { ptr.long = true; doAction(G().long); } }, 550);
  });
  stage.addEventListener('pointermove', e => {
    if (!ptr || e.pointerId !== ptr.id) return;
    ptr.dx = e.clientX - ptr.x; ptr.dy = e.clientY - ptr.y;
    if (!ptr.moved && Math.hypot(ptr.dx, ptr.dy) > 8) { ptr.moved = true; clearTimeout(longTimer); ptr.horiz = Math.abs(ptr.dx) > Math.abs(ptr.dy); }
    if (ptr.horiz) {
      const a = G()[ptr.dx < 0 ? 'left' : 'right'];
      if (a === 'none') return;
      const shown = revealed ? a : 'reveal';
      frame.style.transform = `translateX(${ptr.dx}px) rotate(${ptr.dx / 45}deg)`;
      swipeLabel.textContent = gestureLabel(shown);
      swipeLabel.style.color = ACT_COLOR[shown] || 'var(--accent)';
      swipeLabel.style.opacity = Math.min(1, Math.abs(ptr.dx) / 110);
    }
  });
  const end = e => {
    clearTimeout(longTimer);
    if (!ptr || (e && e.pointerId !== ptr.id)) return;
    const p = ptr; ptr = null;
    if (p.long) return;
    if (p.horiz) {
      const a = G()[p.dx < 0 ? 'left' : 'right'];
      if (a !== 'none' && Math.abs(p.dx) > 90 && e?.type === 'pointerup') {
        frame.style.transition = 'transform .16s ease-in'; frame.style.transform = `translateX(${Math.sign(p.dx) * 120}vw) rotate(${Math.sign(p.dx) * 12}deg)`;
        setTimeout(() => { frame.style.transition = ''; frame.style.transform = ''; swipeLabel.style.opacity = 0; revealed ? doAction(a) : reveal(); }, 150);
      } else resetFrame();
      return;
    }
    if (p.moved) {
      if (e?.type === 'pointerup' && Math.abs(p.dy) > 90 && Math.abs(p.dy) > 1.5 * Math.abs(p.dx) && Date.now() - p.t < 600 && stage.scrollHeight <= stage.clientHeight + 2) {
        const a = G()[p.dy < 0 ? 'up' : 'down'];
        if (a !== 'none') revealed ? doAction(a) : reveal();
      }
      return;
    }
    if (e?.type !== 'pointerup') return;
    if (G().dbl !== 'none') {
      if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; doAction(G().dbl); return; }
      tapTimer = setTimeout(() => { tapTimer = null; singleTap(); }, 260);
    } else singleTap();
  };
  const singleTap = () => { if (!revealed && S.settings.tapToReveal) reveal(); };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', e => { if (ptr?.horiz) resetFrame(); clearTimeout(longTimer); ptr = null; });

  // Clavier
  const onKey = e => {
    if (sheetOpen() || e.defaultPrevented) return;
    const target = e.composedPath()[0];
    const typing = target?.matches?.('input,textarea,[contenteditable="true"]');
    const k = e.key;
    if (typing) { if (k === 'Escape') target.blur(); return; }
    if (k === 'Escape') { go(backTo); return; }
    if (!card) return;
    if (!revealed) {
      if (k === ' ' || k === 'Enter') { e.preventDefault(); reveal(); return; }
      if (!e.ctrlKey && !e.metaKey && keySelect(host, k)) { e.preventDefault(); return; }
    } else {
      if (k === ' ' || k === 'Enter') { e.preventDefault(); rate(3); return; }
      if (/^[1-4]$/.test(k) && !e.ctrlKey && !e.metaKey) {
        e.preventDefault(); const g = +k;
        if (S.settings.buttons === 2 && (g === 2 || g === 4)) return;
        rate(g); return;
      }
    }
    if ((k === 'z' && (e.ctrlKey || e.metaKey)) || k === 'u') { e.preventDefault(); undo(); }
    else if (k === 'e') editNote();
    else if (k === 'r') replay();
    else if (k === '-') ACTIONS.bury();
    else if (k === '@' || k === '!') ACTIONS.suspend();
    else if (k === '*') markNote();
    else if (e.ctrlKey && /^[0-7]$/.test(k)) { e.preventDefault(); flagCard(+k); }
  };
  document.addEventListener('keydown', onKey);
  if (S.settings.showTimer) tick = setInterval(() => {
    if (!card) { timerEl.textContent = ''; return; }
    const s = Math.min(60, Math.floor((Date.now() - shownAt) / 1000));
    timerEl.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 500);
  next();
  return () => { document.removeEventListener('keydown', onKey); clearInterval(waitTimer); clearInterval(tick); clearTimeout(tapTimer); stopAudio(); };
}

// ---------- ajout / modification ----------
function viewAdd(el) {
  el.append(header({ title: t('Ajouter une note') }), noteEditor());
  setTimeout(() => el.querySelector('.field-input')?.focus(), 80);
}
function viewEdit(el, id, params) {
  const note = S.notes.get(+id);
  const back = params.get('from') || 'browse';
  if (!note) { go(back); return; }
  el.append(header({ title: t('Modifier la note'), back, actions: [iconBtn('more', t('Actions'), () => menu(t('Note'), [
    { label: t('Supprimer la note'), danger: true, onclick: async () => {
      if (await confirmBox(t('Supprimer cette note et toutes ses cartes ?'), { danger: true, ok: t('Supprimer') })) { deleteNotes([note.id]); toast(t('Note supprimée')); go(back); }
    } },
  ]))] }));
  el.append(noteEditor({ note, onSaved: () => renderCards() }));
  const cardsBox = h('section', { class: 'set-sec' });
  const renderCards = () => {
    const cs = noteCards(note.id).sort((a, b) => a.ord - b.ord);
    cardsBox.replaceChildren(h('h2', null, t('Cartes')), h('div', { class: 'set-list' }, cs.map(c => h('div', { class: 'set-row' },
      h('div', { class: 'set-label' }, h('span', null, templateName(c)), h('small', null, `${cardStatus(c)} — ${S.decks.get(c.did)?.name || ''}`)),
      h('div', { class: 'row' },
        h('button', { class: 'btn small', onclick: () => cardInfo(c) }, t('Infos')),
        h('button', { class: 'btn small', onclick: () => { setSuspended([c], c.queue !== -1); renderCards(); } }, c.queue === -1 ? t('Réactiver') : t('Suspendre')),
        h('button', { class: 'btn small', onclick: async () => { if (await confirmBox(t('Remettre cette carte à l\'état « nouvelle » ? Son historique est conservé.'))) { forget([c]); renderCards(); } } }, t('Oublier')))))));
  };
  renderCards();
  el.append(cardsBox);
}

// ---------- parcourir ----------
const SORTS = () => [['added', t('Ajout (récent)')], ['added-asc', t('Ajout (ancien)')], ['due', t('Échéance')], ['ivl', t('Intervalle')], ['alpha', t('Ordre alphabétique')],
  ['deck', t('Paquet')], ['lapses', t('Oublis')], ['mod', t('Modification')]];
function viewBrowse(el, _, params) {
  let q = params.get('q') ?? S.settings.lastQuery ?? '';
  let mode = S.settings.browseMode || 'cards', sort = S.settings.browseSort || 'added';
  let results = [], shown = 100, selecting = false;
  const sel = new Set();
  const input = h('input', { class: 'input search', type: 'search', value: q, placeholder: t('Rechercher (ex. deck:Physique is:due)'), autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search' });
  const info = h('p', { class: 'muted small' });
  const list = h('div', { class: 'browse-list' });
  const more = h('button', { class: 'btn ghost', onclick: () => { shown += 200; draw(); } }, t('Afficher plus'));
  const selBar = h('div', { class: 'sel-bar', hidden: true });
  const selBtn = h('button', { class: 'btn small', onclick: () => { selecting = !selecting; sel.clear(); draw(); } });
  el.append(header({ title: t('Parcourir'), actions: [iconBtn('help', t('Aide à la recherche'), help)] }),
    h('div', { class: 'browse-tools' }, input,
      h('div', { class: 'row wrap' }, seg([['cards', t('Cartes')], ['notes', t('Notes')]], mode, v => { mode = v; S.settings.browseMode = v; saveSettings(); sel.clear(); run(); }, { small: true }),
        h('select', { class: 'select small', onchange: e => { sort = e.target.value; S.settings.browseSort = sort; saveSettings(); run(); } }, SORTS().map(([v, l]) => h('option', { value: v, selected: v === sort }, l))),
        selBtn)),
    info, list, more, selBar);

  function sortKey(c, n) {
    switch (sort) {
      case 'added': return -c.id; case 'added-asc': return c.id;
      case 'due': return c.queue === -1 ? 3e12 : c.type === 0 ? 2e12 + c.due : c.queue === 1 ? c.due / 864e5 : c.due;
      case 'ivl': return -c.ivl; case 'lapses': return -c.lapses; case 'mod': return -n.mod;
      default: return 0;
    }
  }
  function run() {
    S.settings.lastQuery = q; saveSettings();
    let cs;
    try { cs = searchCards(q); } catch { cs = []; }
    if (mode === 'notes') { const seen = new Set(); cs = cs.filter(c => !seen.has(c.nid) && seen.add(c.nid)); }
    if (sort === 'alpha') { const coll = new Intl.Collator(getLang(), { numeric: true, sensitivity: 'base' }); const m = new Map(cs.map(c => [c.id, sortText(S.notes.get(c.nid))])); cs.sort((a, b) => coll.compare(m.get(a.id), m.get(b.id))); }
    else if (sort === 'deck') cs.sort((a, b) => (S.decks.get(a.did)?.name || '').localeCompare(S.decks.get(b.did)?.name || '') || a.ord - b.ord);
    else cs.sort((a, b) => sortKey(a, S.notes.get(a.nid)) - sortKey(b, S.notes.get(b.nid)));
    results = cs; shown = 100; draw();
  }
  const keyOf = c => mode === 'notes' ? c.nid : c.id;
  function draw() {
    info.textContent = mode === 'notes' ? tn(results.length, '{n} note', '{n} notes') : tn(results.length, '{n} carte', '{n} cartes');
    selBtn.textContent = selecting ? t('Terminer') : t('Sélectionner');
    list.replaceChildren(...results.slice(0, shown).map(c => {
      const n = S.notes.get(c.nid); const k = keyOf(c);
      const flag = c.flags & 7;
      return h('div', { class: 'brow' + (sel.has(k) ? ' sel' : '') + (c.queue === -1 ? ' susp' : ''), onclick: () => {
        if (selecting) { sel.has(k) ? sel.delete(k) : sel.add(k); draw(); } else go(`edit/${c.nid}?from=${encodeURIComponent('browse')}`);
      } },
        selecting ? h('span', { class: 'check' + (sel.has(k) ? ' on' : '') }, ic('check', 16)) : null,
        h('div', { class: 'brow-main' },
          h('div', { class: 'brow-title' }, truncate(sortText(n), 140) || t('(vide)')),
          h('div', { class: 'brow-meta' },
            flag ? h('i', { class: `fdot f${flag}` }) : null,
            h('span', null, S.decks.get(c.did)?.name.split('::').pop()),
            h('span', null, mode === 'notes' ? (notetypeOf(n)?.name || '') : cardStatus(c)),
            n.tags.length ? h('span', { class: 'tags' }, n.tags.slice(0, 3).join(' ')) : null)));
    }));
    more.hidden = results.length <= shown;
    selBar.hidden = !selecting;
    if (selecting) selBar.replaceChildren(
      h('span', null, tn(sel.size, '{n} sélectionnée', '{n} sélectionnées')),
      h('button', { class: 'btn small', onclick: () => { results.forEach(c => sel.add(keyOf(c))); draw(); } }, t('Tout')),
      h('button', { class: 'btn small primary', disabled: !sel.size, onclick: bulk }, t('Actions')));
  }
  const selectedCards = () => mode === 'notes' ? [...sel].flatMap(nid => noteCards(nid)) : [...sel].map(id => S.cards.get(id)).filter(Boolean);
  const selectedNotes = () => [...new Set(selectedCards().map(c => c.nid))];
  function bulk() {
    const cs = selectedCards();
    const anySusp = cs.some(c => c.queue === -1);
    menu(tn(cs.length, '{n} carte', '{n} cartes'), [
      { label: t('Étudier ces cartes'), icon: 'play', onclick: () => { pendingSession = new Session({ cids: cs.map(c => c.id), cram: true, title: t('Sélection') }); pendingSession.backTo = 'browse'; go('study/sel'); } },
      { label: t('Changer de paquet'), icon: 'decks', onclick: () => {
        let target = cs[0]?.did ?? 1;
        const close = sheet(t('Changer de paquet'), h('div', { class: 'form' }, deckSelect(target, v => { target = v; }),
          h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => { for (const c of cs) { c.did = target; saveCard(c); } close(); toast(t('Cartes déplacées')); run(); } }, t('Déplacer')))));
      } },
      { label: t('Ajouter des étiquettes'), onclick: async () => { const v = await ask(t('Ajouter des étiquettes')); if (v) { for (const nid of selectedNotes()) addTags(S.notes.get(nid), parseTags(v)); run(); } } },
      { label: t('Retirer des étiquettes'), onclick: async () => { const v = await ask(t('Retirer des étiquettes')); if (v) { for (const nid of selectedNotes()) removeTags(S.notes.get(nid), parseTags(v)); run(); } } },
      { label: anySusp ? t('Réactiver') : t('Suspendre'), onclick: () => { setSuspended(cs, !anySusp); run(); } },
      { node: h('div', { class: 'menu-flags' }, h('span', null, t('Drapeau')), h('div', { class: 'flags' }, [0, 1, 2, 3, 4, 5, 6, 7].map(f =>
        h('button', { class: `flag f${f}`, 'aria-label': f ? t('Drapeau {n}', { n: f }) : t('Aucun drapeau'), onclick: () => { setFlag(cs, f); closeAllSheets(); run(); } })))) },
      { label: t('Oublier (remettre à nouveau)'), onclick: async () => { if (await confirmBox(tn(cs.length, 'Remettre {n} carte à l\'état « nouvelle » ?', 'Remettre {n} cartes à l\'état « nouvelle » ?'))) { forget(cs); run(); } } },
      { sep: true },
      { label: t('Supprimer les notes'), danger: true, onclick: async () => {
        const ns = selectedNotes();
        if (await confirmBox(tn(ns.length, 'Supprimer {n} note et ses cartes ?', 'Supprimer {n} notes et leurs cartes ?'), { danger: true, ok: t('Supprimer') })) { deleteNotes(ns); sel.clear(); toast(t('Notes supprimées')); run(); }
      } },
    ]);
  }
  function help() {
    let close;
    close = sheet(t('Syntaxe de recherche'), h('div', { class: 'help-list' }, searchHelp().map(([ex, d]) => h('button', { class: 'help-row', onclick: () => { input.value = (input.value + ' ' + ex.split('  ')[0]).trim(); q = input.value; close(); run(); } }, h('code', null, ex), h('span', null, d)))));
  }
  input.addEventListener('input', debounce(() => { q = input.value; run(); }, 300));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { q = input.value; run(); input.blur(); } });
  run();
}

// ---------- statistiques ----------
function viewStats(el, _, params) {
  let did = params.get('deck') ? +params.get('deck') : null;
  const body = h('div', { class: 'stats' });
  const draw = () => { body.innerHTML = statsHtml(did); };
  el.append(header({ title: t('Statistiques') }), h('div', { class: 'stats-top' }, deckSelect(did, v => { did = v; draw(); }, { all: true, folders: true })), body);
  draw();
}

// ---------- réglages ----------
function viewSettings(el) {
  const st = S.settings;
  const set = (k, v, after) => { st[k] = v; saveSettings(); after?.(); };
  const theme = () => applyTheme();
  const tog = (k, after) => toggle(!!st[k], v => set(k, v, after));
  const sel = (k, opts, after) => h('select', { class: 'select', onchange: e => set(k, isNaN(+e.target.value) || e.target.value === '' ? e.target.value : +e.target.value, after) }, opts.map(([v, l]) => h('option', { value: v, selected: st[k] === v }, l)));
  const range = (k, min, max, step, unit, after) => {
    const out = h('output', null, st[k] + unit);
    return h('div', { class: 'range' }, h('input', { type: 'range', min, max, step, value: st[k], oninput: e => { out.textContent = e.target.value + unit; set(k, +e.target.value, after); } }), out);
  };
  const num = (k, min, max, after) => h('input', { class: 'input num', type: 'number', min, max, value: st[k], onchange: e => set(k, Math.max(min, Math.min(max, +e.target.value || 0)), after) });
  const accentBox = h('div', { class: 'swatches' });
  const drawAccent = () => accentBox.replaceChildren(...ACCENTS.map(c => h('button', { class: 'swatch' + (st.accent.toLowerCase() === c.toLowerCase() ? ' on' : ''), style: `--c:${c}`, 'aria-label': c, onclick: () => { set('accent', c, theme); drawAccent(); } })),
    h('label', { class: 'swatch custom', title: t('Couleur personnalisée') }, h('input', { type: 'color', value: st.accent, oninput: e => { set('accent', e.target.value, theme); } }), ic('plus', 16)));
  drawAccent();
  const customFont = h('input', { class: 'input', placeholder: t('Nom d\'une police Google Fonts, ex. Lora'), value: st.customCardFont || '', hidden: st.cardFont !== 'custom', onchange: e => set('customCardFont', e.target.value.trim(), theme) });
  const restoreInput = h('input', { type: 'file', accept: '.zip,.json', hidden: true, onchange: e => { const f = e.target.files[0]; if (f) go('import'), setTimeout(() => window.dispatchEvent(new CustomEvent('mnemo-import', { detail: f })), 100); } });
  const storage = h('small', null, '…');
  storageInfo().then(s => { storage.textContent = (s.usage != null ? t('{a} Mo utilisés', { a: (s.usage / 1048576).toFixed(1) }) + ' — ' : '') + (s.persisted ? t('stockage protégé') : t('stockage non protégé : le navigateur peut l\'effacer s\'il manque de place')); });

  const syncSec = syncSection();
  el.append(header({ title: t('Réglages') }),
    section(t('Langue'), setRow('Language', seg([['fr', 'Français'], ['en', 'English']], getLang(), v => {
      setLang(v); st.lang = v; localizeDefaults(v); saveSettings(); buildTabbar(); rerender();
    }))),
    syncSec.el,
    section(t('Apparence'),
      setRow(t('Thème'), seg([['system', t('Auto')], ['light', t('Clair')], ['dark', t('Sombre')], ['amoled', 'AMOLED']], st.theme, v => set('theme', v, theme), { small: true })),
      setRow(t('Couleur d\'accent'), accentBox),
      setRow(t('Police de l\'interface'), sel('uiFont', [['instrument', 'Instrument Sans'], ['system', t('Système')], ['newsreader', 'Newsreader'], ['mono', t('Monospace')]], theme)),
      setRow(t('Police des cartes'), h('div', { class: 'stack' }, sel('cardFont', [['palatino', 'Palatino'], ['newsreader', 'Newsreader'], ['instrument', 'Instrument Sans'], ['system', t('Système')], ['mono', t('Monospace')], ['custom', t('Google Fonts…')]],
        () => { customFont.hidden = st.cardFont !== 'custom'; theme(); }), customFont)),
      setRow(t('Taille du texte des cartes'), range('cardSize', 14, 40, 1, ' px', theme)),
      setRow(t('Largeur maximale des cartes'), range('cardWidth', 420, 1100, 20, ' px', theme)),
      setRow(t('Alignement des cartes'), seg([['center', t('Centré')], ['left', t('À gauche')]], st.cardAlign, v => set('cardAlign', v, theme), { small: true })),
      setRow(t('Imposer cette police aux cartes importées'), tog('forceCardFont')),
      setRow(t('Adapter les couleurs des cartes au thème'), tog('adaptCardColors'), t('Évite les cartes blanches en mode sombre.'))),
    section(t('Révision'),
      setRow(t('Boutons de réponse'), seg([[4, t('4 boutons')], [2, t('2 boutons')]], st.buttons, v => set('buttons', v), { small: true }), t('Avec 2 boutons : À revoir et Correct.')),
      setRow(t('Taille des boutons'), seg([['normal', t('Normale')], ['large', t('Grande')]], st.buttonSize, v => set('buttonSize', v, theme), { small: true })),
      setRow(t('Afficher les intervalles sur les boutons'), tog('showIntervals')),
      setRow(t('Afficher les compteurs'), tog('showCounts')),
      setRow(t('Afficher le chronomètre'), tog('showTimer')),
      setRow(t('Toucher la carte pour afficher la réponse'), tog('tapToReveal')),
      setRow(t('Lire le son automatiquement'), tog('autoplay')),
      setRow(t('QCM : afficher la réponse dès le choix'), tog('revealOnChoice'), t('Pour les questions à une seule bonne réponse.')),
      setRow(t('Suggérer le bouton après un QCM ou un vrai/faux'), tog('suggestGrade'))),
    section(t('Gestes'), ...[['left', t('Glisser vers la gauche')], ['right', t('Glisser vers la droite')], ['up', t('Glisser vers le haut')], ['down', t('Glisser vers le bas')], ['dbl', t('Double toucher')], ['long', t('Appui long')]]
      .map(([k, l]) => setRow(l, h('select', { class: 'select', onchange: e => { st.gestures[k] = e.target.value; saveSettings(); } }, GESTURE_ACTIONS().map(([v, x]) => h('option', { value: v, selected: st.gestures[k] === v }, x))))),
      h('p', { class: 'muted small pad' }, t('Avant la réponse, un geste de notation affiche d\'abord la réponse.'))),
    section(t('Clavier'), h('div', { class: 'kbd-list' }, [
      [t('Espace / Entrée'), t('Afficher la réponse, puis Correct')], ['1 2 3 4', t('À revoir, Difficile, Correct, Facile')], ['A B C… / 1 2 3…', t('Choisir une réponse de QCM')],
      ['V / F', t('Vrai ou faux')], ['U, Ctrl+Z', t('Annuler')], ['E', t('Modifier la note')], ['R', t('Rejouer le son')], ['−', t('Enfouir')], ['@', t('Suspendre')], ['*', t('Marquer')], ['Ctrl+1…7', t('Drapeaux')], ['Échap', t('Quitter')],
    ].map(([k, d]) => h('div', null, h('kbd', null, k), h('span', null, d))))),
    section(t('Planification'),
      setRow(t('Début de la journée'), h('div', { class: 'row' }, num('rollover', 0, 23, () => setRollover(st.rollover)), h('span', { class: 'muted' }, 'h'))),
      setRow(t('Apprentissage en avance'), h('div', { class: 'row' }, num('learnAhead', 0, 120), h('span', { class: 'muted' }, 'min')), t('Montre une carte en apprentissage en avance plutôt que d\'attendre.')),
      linkRow(t('Options des paquets'), () => go('presets'), t('Limites quotidiennes, étapes, SM-2 ou FSRS'))),
    section(t('Contenu'),
      linkRow(t('Types de notes'), () => go('notetypes'), t('Champs, modèles de cartes HTML/CSS')),
      setRow(t('Formules entre $…$'), tog('dollarMath'), t('\\(…\\), \\[…\\] et $$…$$ sont toujours reconnus.')),
      setRow(t('Exécuter le JavaScript des cartes'), tog('runScripts'), t('Uniquement pour des paquets de confiance.'))),
    section(t('Données'),
      linkRow(t('Importer'), () => go('import'), '.apkg, .colpkg, CSV, TSV, TXT, JSON, Markdown, HTML, GIFT, Aiken'),
      linkRow(t('Exporter'), () => go('export'), t('.apkg, texte, JSON')),
      linkRow(t('Sauvegarder la collection'), () => go('export?format=backup'), t('Fichier .zip avec médias et réglages')),
      linkRow(t('Restaurer une sauvegarde'), () => restoreInput.click()), restoreInput,
      setRow(t('Stockage'), h('button', { class: 'btn small', onclick: async () => { const ok = await requestPersist(); toast(ok ? t('Stockage protégé') : t('Le navigateur a refusé. Ajoutez l\'app à l\'écran d\'accueil puis réessayez.')); rerender(); } }, t('Protéger')), storage),
      h('div', { class: 'pad' }, h('button', { class: 'btn danger', onclick: async () => {
        if (!await confirmBox(t('Effacer toute la collection, les médias et les réglages ? Faites d\'abord une sauvegarde.'), { danger: true, ok: t('Tout effacer') })) return;
        if (!await confirmBox(t('Vraiment ? Cette action est irréversible.'), { danger: true, ok: t('Effacer définitivement') })) return;
        await wipeAll(); try { localStorage.removeItem('mnemo-theme'); } catch {} location.hash = ''; location.reload();
      } }, t('Effacer toutes les données')))),
    h('p', { class: 'about' }, `Mnemo ${VERSION} — `, configured() ? t('fonctionne hors ligne et se synchronise via ton projet Supabase.') : t('fonctionne hors ligne, vos données restent sur cet appareil.')));
  return syncSec.off;
}

// ---------- types de notes ----------
const KIND_LABEL = () => ({ std: t('Standard'), cloze: t('Texte à trous'), mcq: t('QCM'), tf: t('Vrai ou faux') });
function viewNotetypes(el) {
  el.append(header({ title: t('Types de notes'), back: 'settings', actions: [iconBtn('plus', t('Nouveau type'), addNotetype)] }));
  const counts = new Map(); for (const n of S.notes.values()) counts.set(n.mid, (counts.get(n.mid) || 0) + 1);
  el.append(section(null, ...[...S.notetypes.values()].sort((a, b) => a.name.localeCompare(b.name)).map(nt =>
    linkRow(nt.name, () => go('notetype/' + nt.id), `${KIND_LABEL()[nt.kind]} — ${tn(counts.get(nt.id) || 0, '{n} note', '{n} notes')}`))));
}
async function addNotetype() {
  let base = 'b:basic';
  const name = h('input', { class: 'input', placeholder: t('Nom du type') });
  const select = h('select', { class: 'select', onchange: e => { base = e.target.value; } },
    h('optgroup', { label: t('Ajouter') }, BUILTIN_KEYS.map(k => h('option', { value: 'b:' + k }, builtinDef(k).name))),
    h('optgroup', { label: t('Copier') }, [...S.notetypes.values()].map(nt => h('option', { value: 'c:' + nt.id }, nt.name))));
  const close = sheet(t('Nouveau type de note'), h('div', { class: 'form' }, h('label', { class: 'mini' }, h('span', null, t('À partir de')), select), name,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: () => {
      const src = base.startsWith('b:') ? builtinDef(base.slice(2)) : structuredClone(S.notetypes.get(+base.slice(2)));
      const nt = { ...src, id: newId(), builtin: undefined, name: uniqueNotetypeName(name.value.trim() || src.name), mod: Date.now() };
      S.notetypes.set(nt.id, nt); saveNotetype(nt); close(); go('notetype/' + nt.id);
    } }, t('Créer')))));
  setTimeout(() => name.focus(), 50);
}
function viewNotetype(el, id) {
  const nt = S.notetypes.get(+id);
  if (!nt) return go('notetypes');
  const notes = notesOfType(nt.id);
  let cur = 0, side = 'q';
  const draft = { tmpls: structuredClone(nt.tmpls), css: nt.css };
  el.append(header({ title: nt.name, back: 'notetypes', actions: [iconBtn('more', t('Actions'), () => menu(nt.name, [
    { label: t('Renommer'), icon: 'edit', onclick: async () => { const v = await ask(t('Renommer le type'), { value: nt.name }); if (v) { nt.name = uniqueNotetypeName(v, nt.id); saveNotetype(nt); rerender(); } } },
    { label: t('Supprimer'), danger: true, icon: 'close', onclick: async () => {
      if (S.notetypes.size <= 1) return toast(t('Il faut garder au moins un type de note.'));
      if (await confirmBox(tn(notes.length, 'Supprimer ce type et sa note ?', 'Supprimer ce type et ses {n} notes ?'), { danger: true, ok: t('Supprimer') })) {
        deleteNotes(notes.map(n => n.id)); S.notetypes.delete(nt.id); persist.del('notetypes', nt.id); go('notetypes');
      }
    } },
  ]))] }));

  const saveFields = () => { nt.flds.forEach((f, i) => { f.ord = i; }); saveNotetype(nt); for (const n of notes) saveNote(n); rerender(); };
  const renameRefs = (from, to) => {
    const re = new RegExp(`\\{\\{([#^/]?)((?:[^}:]*:)*)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}\\}`, 'g');
    for (const x of nt.tmpls) { x.qfmt = x.qfmt.replace(re, `{{$1$2${to}}}`); x.afmt = x.afmt.replace(re, `{{$1$2${to}}}`); }
    if (nt.mcq) for (const k of ['choices', 'answer']) if (nt.mcq[k] === from) nt.mcq[k] = to;
    if (nt.tf?.answer === from) nt.tf.answer = to;
  };
  const fieldRows = nt.flds.map((f, i) => h('div', { class: 'set-row' },
    h('div', { class: 'set-label' }, h('span', null, f.name), i === nt.sortf ? h('small', null, t('Champ de tri')) : null),
    h('div', { class: 'row' },
      h('button', { class: 'icon-btn small', disabled: i === 0, 'aria-label': t('Monter'), onclick: () => {
        [nt.flds[i - 1], nt.flds[i]] = [nt.flds[i], nt.flds[i - 1]];
        for (const n of notes) [n.flds[i - 1], n.flds[i]] = [n.flds[i], n.flds[i - 1]];
        if (nt.sortf === i) nt.sortf--; else if (nt.sortf === i - 1) nt.sortf++;
        saveFields();
      } }, h('span', { class: 'ic rot' }, ic('caret', 18))),
      h('button', { class: 'btn small', onclick: async () => {
        const v = await ask(t('Renommer le champ'), { value: f.name });
        if (!v || v === f.name) return;
        if (nt.flds.some(x => x.name === v) || /[:{}#^/"]/.test(v)) return toast(t('Nom invalide ou déjà utilisé.'));
        renameRefs(f.name, v); f.name = v; draft.tmpls = structuredClone(nt.tmpls); saveFields();
      } }, t('Renommer')),
      h('button', { class: 'btn small', disabled: i === nt.sortf, onclick: () => { nt.sortf = i; saveFields(); } }, t('Trier')),
      h('button', { class: 'icon-btn small', disabled: nt.flds.length <= 1, 'aria-label': t('Supprimer le champ'), onclick: async () => {
        if (!await confirmBox(t('Supprimer le champ « {f} » de toutes les notes ?', { f: f.name }), { danger: true, ok: t('Supprimer') })) return;
        nt.flds.splice(i, 1); for (const n of notes) n.flds.splice(i, 1);
        if (nt.sortf >= nt.flds.length || nt.sortf === i) nt.sortf = 0; else if (nt.sortf > i) nt.sortf--;
        saveFields(); for (const n of notes) updateNote(n);
      } }, ic('close', 18)))));
  el.append(section(t('Champs'), ...fieldRows, h('div', { class: 'pad' }, h('button', { class: 'btn ghost small', onclick: async () => {
    const v = await ask(t('Nouveau champ'), { placeholder: t('Nom du champ') });
    if (!v) return;
    if (nt.flds.some(x => x.name === v) || /[:{}#^/"]/.test(v)) return toast(t('Nom invalide ou déjà utilisé.'));
    nt.flds.push({ name: v, ord: nt.flds.length }); for (const n of notes) n.flds.push(''); saveFields();
  } }, ic('plus', 16), t('Ajouter un champ')))));

  if (nt.kind === 'mcq' || nt.kind === 'tf') {
    const fsel = (val, on) => h('select', { class: 'select', onchange: e => { on(e.target.value); saveNotetype(nt); } }, nt.flds.map(f => h('option', { value: f.name, selected: f.name === val }, f.name)));
    if (nt.kind === 'mcq') {
      nt.mcq ??= { choices: nt.flds[1]?.name, answer: nt.flds[2]?.name, shuffle: true };
      el.append(section(t('QCM'),
        setRow(t('Champ des choix'), fsel(nt.mcq.choices, v => { nt.mcq.choices = v; }), t('Un choix par ligne. Préfixe * ou [x] possible pour la bonne réponse.')),
        setRow(t('Champ de la bonne réponse'), fsel(nt.mcq.answer, v => { nt.mcq.answer = v; }), t('Lettres (A, C), numéros (1,3) ou texte exact.')),
        setRow(t('Mélanger les choix'), toggle(nt.mcq.shuffle !== false, v => { nt.mcq.shuffle = v; saveNotetype(nt); }))));
    } else {
      nt.tf ??= { answer: nt.flds[1]?.name };
      el.append(section(t('Vrai ou faux'), setRow(t('Champ de la réponse'), fsel(nt.tf.answer, v => { nt.tf.answer = v; }), t('Vrai/Faux, V/F, True/False, 1/0.'))));
    }
  }

  const tabs = h('div', { class: 'row wrap' });
  const qArea = h('textarea', { class: 'input code', rows: 6, spellcheck: 'false' });
  const aArea = h('textarea', { class: 'input code', rows: 6, spellcheck: 'false' });
  const cssArea = h('textarea', { class: 'input code', rows: 8, spellcheck: 'false', value: draft.css });
  const prevHost = h('div', { class: 'card-host preview' });
  const prevNote = notes[0] || { id: -1, mid: nt.id, flds: nt.flds.map(f => `(${f.name})`), tags: [] };
  const drawTabs = () => {
    tabs.replaceChildren(...draft.tmpls.map((x, i) => h('button', { class: 'chip' + (i === cur ? ' on' : ''), onclick: () => { sync(); cur = i; load(); } }, x.name)),
      nt.kind !== 'cloze' ? h('button', { class: 'chip ghost', onclick: () => { sync(); draft.tmpls.push({ name: t('Carte {n}', { n: draft.tmpls.length + 1 }), ord: draft.tmpls.length, qfmt: draft.tmpls[cur].qfmt, afmt: draft.tmpls[cur].afmt }); cur = draft.tmpls.length - 1; load(); } }, ic('plus', 14), t('Modèle')) : null);
  };
  const sync = () => { const x = draft.tmpls[cur]; x.qfmt = qArea.value; x.afmt = aArea.value; draft.css = cssArea.value; };
  const preview = debounce(() => {
    sync();
    const fake = { ...prevNote, _nt: { ...nt, tmpls: draft.tmpls, css: draft.css } };
    const ords = cardOrdsFor(prevNote, nt);
    const ord = nt.kind === 'cloze' ? (ords[0] ?? 0) : cur;
    mountCard(prevHost, { id: 0, nid: prevNote.id, did: 1, ord, flags: 0, reps: 0 }, side, { seed: 1 }, { autoplay: false, focusInput: false }, fake);
  }, 250);
  const load = () => { qArea.value = draft.tmpls[cur].qfmt; aArea.value = draft.tmpls[cur].afmt; drawTabs(); preview(); };
  [qArea, aArea, cssArea].forEach(a => a.addEventListener('input', preview));
  el.append(h('section', { class: 'set-sec' }, h('h2', null, t('Modèles de cartes')), tabs,
    h('div', { class: 'tmpl-grid' },
      h('div', { class: 'stack' },
        h('label', { class: 'mini' }, h('span', null, t('Recto')), qArea),
        h('label', { class: 'mini' }, h('span', null, t('Verso')), aArea),
        h('label', { class: 'mini' }, h('span', null, t('Style (CSS, commun à tous les modèles)')), cssArea),
        h('p', { class: 'muted small' }, t('Syntaxe Anki : {{Champ}}, {{FrontSide}}, {{#Champ}}…{{/Champ}}, {{cloze:Champ}}, {{type:Champ}}, {{hint:Champ}}, plus {{mcq:Champ}} et {{tf:Champ}}.'))),
      h('div', { class: 'stack' }, h('div', { class: 'row between' }, h('span', { class: 'muted small' }, notes.length ? t('Aperçu avec votre première note') : t('Aperçu')),
        seg([['q', t('Recto')], ['a', t('Verso')]], side, v => { side = v; preview(); }, { small: true })), prevHost)),
    h('div', { class: 'actions' },
      draft.tmpls.length > 1 && nt.kind !== 'cloze' ? h('button', { class: 'btn danger', onclick: async () => {
        const ids = new Set(notes.map(x => x.id));
        const n = [...S.cards.values()].filter(c => ids.has(c.nid) && c.ord === cur).length;
        if (!await confirmBox(tn(n, 'Supprimer ce modèle et sa carte ?', 'Supprimer ce modèle et ses {n} cartes ?'), { danger: true, ok: t('Supprimer') })) return;
        for (const c of [...S.cards.values()]) if (ids.has(c.nid)) { if (c.ord === cur) deleteCard(c.id); else if (c.ord > cur) { c.ord--; saveCard(c); } }
        nt.tmpls.splice(cur, 1); nt.tmpls.forEach((x, i) => { x.ord = i; }); saveNotetype(nt); rerender();
      } }, t('Supprimer ce modèle')) : null,
      h('button', { class: 'btn', onclick: async () => { const v = await ask(t('Renommer le modèle'), { value: draft.tmpls[cur].name }); if (v) { draft.tmpls[cur].name = v; drawTabs(); } } }, t('Renommer')),
      h('button', { class: 'btn primary', onclick: () => {
        sync();
        nt.tmpls = draft.tmpls.map((x, i) => ({ ...x, ord: i })); nt.css = draft.css; saveNotetype(nt);
        let k = 0; for (const n of notes) k += genCards(n);
        toast(k ? tn(k, 'Enregistré — {n} nouvelle carte', 'Enregistré — {n} nouvelles cartes') : t('Enregistré'));
      } }, t('Enregistrer')))));
  load();
}

// ---------- options des paquets ----------
const fmtSteps = arr => (arr || []).map(m => m >= 1440 && m % 1440 === 0 ? m / 1440 + 'd' : m >= 60 && m % 60 === 0 ? m / 60 + 'h' : m < 1 ? Math.round(m * 60) + 's' : m + 'm').join(' ');
const parseSteps = s => String(s).trim().split(/[\s,]+/).filter(Boolean).map(x => {
  const m = x.match(/^(\d+(?:[.,]\d+)?)([smhdj]?)$/i); if (!m) return null;
  const v = +m[1].replace(',', '.'); const u = m[2].toLowerCase();
  return u === 's' ? v / 60 : u === 'h' ? v * 60 : u === 'd' || u === 'j' ? v * 1440 : v;
}).filter(x => x != null && x > 0);
function viewPresets(el) {
  el.append(header({ title: t('Options des paquets'), back: 'settings', actions: [iconBtn('plus', t('Nouveau préréglage'), async () => {
    const name = await ask(t('Nouveau préréglage'), { placeholder: t('Nom') });
    if (!name) return;
    const p = { ...structuredClone(S.presets.get(1)), id: newId(), name };
    S.presets.set(p.id, p); persist.put('presets', p); go('preset/' + p.id);
  })] }));
  const uses = new Map(); for (const d of S.decks.values()) uses.set(d.conf || 1, (uses.get(d.conf || 1) || 0) + 1);
  el.append(section(null, ...[...S.presets.values()].map(p => linkRow(p.name, () => go('preset/' + p.id),
    `${p.algo === 'fsrs' ? 'FSRS' : 'SM-2'} — ${tn(uses.get(p.id) || 0, 'utilisé par {n} paquet', 'utilisé par {n} paquets')}`))));
}
function viewPreset(el, id, params) {
  const p = S.presets.get(+id);
  if (!p) return go('presets');
  const deckId = params.get('deck') ? +params.get('deck') : null;
  const save = () => persist.put('presets', p);
  const numIn = (k, min, max, step = 1) => h('input', { class: 'input num', type: 'number', min, max, step, value: p[k], onchange: e => { const v = +String(e.target.value).replace(',', '.'); if (Number.isFinite(v)) { p[k] = Math.max(min, Math.min(max, v)); e.target.value = p[k]; save(); } } });
  const stepsIn = k => h('input', { class: 'input', value: fmtSteps(p[k]), placeholder: '1m 10m', onchange: e => { p[k] = parseSteps(e.target.value); e.target.value = fmtSteps(p[k]); save(); } });
  const sm2 = h('div'), fs = h('div');
  const showAlgo = () => { sm2.hidden = p.algo === 'fsrs'; fs.hidden = p.algo !== 'fsrs'; };
  const weights = h('textarea', { class: 'input code', rows: 3, value: (p.weights || DEFAULT_W).join(', '), onchange: e => {
    const w = e.target.value.split(/[\s,]+/).filter(Boolean).map(Number);
    if (w.length >= 19 && w.every(Number.isFinite)) { p.weights = w.slice(0, 19); save(); toast(t('Paramètres enregistrés')); } else toast(t('Il faut 19 nombres (paramètres FSRS-5).'));
  } });
  el.append(header({ title: p.name, back: deckId ? 'deck/' + deckId : 'presets', actions: [iconBtn('more', t('Actions'), () => menu(p.name, [
    { label: t('Renommer'), icon: 'edit', onclick: async () => { const v = await ask(t('Renommer'), { value: p.name }); if (v) { p.name = v; save(); rerender(); } } },
    p.id !== 1 ? { label: t('Supprimer'), danger: true, onclick: async () => {
      if (!await confirmBox(t('Supprimer ce préréglage ? Les paquets qui l\'utilisent reprendront le préréglage par défaut.'), { danger: true, ok: t('Supprimer') })) return;
      for (const d of S.decks.values()) if (d.conf === p.id) { d.conf = 1; saveDeck(d); }
      S.presets.delete(p.id); persist.del('presets', p.id); go('presets');
    } } : null,
  ]))] }));
  if (deckId && S.decks.has(deckId)) {
    const d = S.decks.get(deckId);
    el.append(section(t('Paquet « {d} »', { d: d.name }), setRow(t('Préréglage utilisé'), h('select', { class: 'select', onchange: e => { d.conf = +e.target.value; saveDeck(d); go(`preset/${d.conf}?deck=${deckId}`); } },
      [...S.presets.values()].map(x => h('option', { value: x.id, selected: x.id === (d.conf || 1) }, x.name))), t('Les réglages ci-dessous s\'appliquent à tous les paquets qui utilisent ce préréglage.'))));
  }
  el.append(
    section(t('Limites quotidiennes'), setRow(t('Nouvelles cartes par jour'), numIn('newPerDay', 0, 9999)), setRow(t('Révisions maximales par jour'), numIn('revPerDay', 0, 99999))),
    section(t('Algorithme'),
      setRow(t('Planificateur'), seg([['sm2', 'SM-2'], ['fsrs', 'FSRS']], p.algo, v => { p.algo = v; save(); showAlgo(); }, { small: true }),
        t('FSRS prédit le moment de l\'oubli et réduit en général le nombre de révisions. SM-2 est l\'algorithme classique d\'Anki.')),
      fs, sm2),
    section(t('Nouvelles cartes'),
      setRow(t('Étapes d\'apprentissage'), stepsIn('learnSteps'), t('Ex. « 1m 10m » ou « 10m 1h 1d ».')),
      setRow(t('Ordre des nouvelles cartes'), seg([['added', t('Ordre d\'ajout')], ['random', t('Aléatoire')]], p.newOrder, v => { p.newOrder = v; save(); }, { small: true }))),
    section(t('Oublis'),
      setRow(t('Étapes de réapprentissage'), stepsIn('relearnSteps')),
      setRow(t('Seuil des sangsues'), numIn('leechThreshold', 0, 99), t('Nombre d\'oublis avant de signaler la carte (0 : jamais).')),
      setRow(t('Action sur les sangsues'), seg([['tag', t('Étiqueter')], ['suspend', t('Suspendre')]], p.leechAction, v => { p.leechAction = v; save(); }, { small: true }))),
    section(t('Affichage'),
      setRow(t('Ordre des révisions'), h('select', { class: 'select', onchange: e => { p.revOrder = e.target.value; save(); } },
        [['due', t('Échéance')], ['random', t('Aléatoire')], ['ivl', t('Intervalle croissant')], ['retrievability', t('Rappel le plus faible d\'abord')]].map(([v, l]) => h('option', { value: v, selected: p.revOrder === v }, l)))),
      setRow(t('Nouvelles et révisions'), h('select', { class: 'select', onchange: e => { p.mix = e.target.value; save(); } },
        [['mix', t('Mélangées')], ['newFirst', t('Nouvelles d\'abord')], ['reviewFirst', t('Révisions d\'abord')]].map(([v, l]) => h('option', { value: v, selected: p.mix === v }, l)))),
      setRow(t('Enfouir les nouvelles cartes sœurs'), toggle(p.buryNew, v => { p.buryNew = v; save(); }), t('Les autres cartes de la même note attendent le lendemain.')),
      setRow(t('Enfouir les révisions sœurs'), toggle(p.buryRev, v => { p.buryRev = v; save(); }))),
  );
  fs.append(
    setRow(t('Rétention souhaitée'), numIn('retention', 0.7, 0.99, 0.01), t('Probabilité visée de se souvenir d\'une carte au moment de la réviser (0,90 par défaut).')),
    setRow(t('Intervalle maximal (jours)'), numIn('maxIvl', 1, 36500)),
    h('div', { class: 'set-row col' }, h('div', { class: 'set-label' }, h('span', null, t('Paramètres FSRS')), h('small', null, t('19 nombres. Collez ceux optimisés par Anki pour vos révisions.'))), weights),
    h('div', { class: 'pad row wrap' },
      h('button', { class: 'btn small', onclick: () => { p.weights = DEFAULT_W.slice(); weights.value = p.weights.join(', '); save(); toast(t('Paramètres par défaut rétablis')); } }, t('Paramètres par défaut')),
      h('button', { class: 'btn small', onclick: () => { const n = recomputeMemory(p.id); toast(tn(n, 'État mémoire recalculé pour {n} carte', 'État mémoire recalculé pour {n} cartes')); } }, t('Recalculer depuis l\'historique'))));
  sm2.append(
    setRow(t('Intervalle de passage (jours)'), numIn('gradIvl', 1, 365)),
    setRow(t('Intervalle « Facile » (jours)'), numIn('easyIvl', 1, 365)),
    setRow(t('Facilité de départ'), numIn('startEase', 1.31, 5, 0.05)),
    setRow(t('Bonus « Facile »'), numIn('easyBonus', 1, 5, 0.05)),
    setRow(t('Modificateur d\'intervalle'), numIn('ivlMod', 0.5, 2, 0.05)),
    setRow(t('Intervalle « Difficile »'), numIn('hardIvl', 0.5, 2, 0.05)),
    setRow(t('Nouvel intervalle après oubli'), numIn('lapseMult', 0, 1, 0.05), t('Fraction de l\'ancien intervalle (0 : on repart à zéro).')),
    setRow(t('Intervalle minimal (jours)'), numIn('minIvl', 1, 365)),
    setRow(t('Intervalle maximal (jours)'), numIn('maxIvl', 1, 36500)));
  showAlgo();
}

// ---------- importation ----------
function summary(res) {
  const parts = [tn(res.notesAdded || 0, '{n} note ajoutée', '{n} notes ajoutées')];
  if (res.notesUpdated) parts.push(tn(res.notesUpdated, '{n} mise à jour', '{n} mises à jour'));
  if (res.notesSkipped) parts.push(tn(res.notesSkipped, '{n} ignorée (déjà présente)', '{n} ignorées (déjà présentes)'));
  if (res.empty) parts.push(tn(res.empty, '{n} ligne vide ou sans carte', '{n} lignes vides ou sans carte'));
  if (res.media) parts.push(tn(res.media, '{n} média', '{n} médias'));
  return parts.join(', ') + '.';
}
function looksHeader(r) { return !!r && r.every(c => c.length < 40 && !/<|\{\{/.test(c)) && r.some(c => /^(front|back|recto|verso|question|answer|réponse|reponse|term|definition|choix|choices|options|tags|deck|explication|explanation|affirmation|statement|q|a|r)$/i.test(c.trim())); }
// Import de lignes sans intervention : type de note et correspondance devinés
function autoImportRows(a, { did, tags = [], dup = 'update' }) {
  if (a.notetypeCol >= 0) return IM.importAnkiText(a, { did, dup, tags });
  const hasHeader = !!a.header || looksHeader(a.rows[0]);
  const head = hasHeader ? (a.header || a.rows[0]) : null;
  const rows = hasHeader && !a.header ? a.rows.slice(1) : a.rows;
  const nt = (a.notetypeName && [...S.notetypes.values()].find(x => x.name === a.notetypeName)) || IM.guessNotetype(head) || IM.findBuiltin('basic') || [...S.notetypes.values()][0];
  const g = IM.guessMapping(head, nt, Math.max(1, ...a.rows.slice(0, 20).map(r => r.length)));
  return IM.importRows(rows, { mid: nt.id, did, map: g.map, tagsCol: g.tagsCol >= 0 ? g.tagsCol : (a.tagsCol ?? -1), deckCol: g.deckCol >= 0 ? g.deckCol : (a.deckCol ?? -1),
    guidCol: a.guidCol ?? -1, html: a.html, tags, dup });
}

function viewImport(el) {
  const out = h('div', { class: 'import-out' });
  const pick = list => { const fs = [...(list || [])]; if (fs.length === 1) handleFile(fs[0]); else if (fs.length > 1) handleMany(fs); };
  const file = h('input', { type: 'file', hidden: true, multiple: true, accept: '.apkg,.colpkg,.csv,.tsv,.txt,.json,.md,.markdown,.html,.htm,.gift,.zip', onchange: e => { pick(e.target.files); e.target.value = ''; } });
  const paste = h('textarea', { class: 'input', rows: 6, placeholder: t('Collez ici du CSV/TSV, du Markdown (Q: … / R: …, recto :: verso), du GIFT ou de l\'Aiken.') });
  const drop = h('button', { class: 'dropzone', onclick: () => file.click() }, ic('upload', 28), h('b', null, t('Choisir un ou plusieurs fichiers')),
    h('span', null, '.apkg  .colpkg  .csv  .tsv  .txt  .json  .md  .html  .gift  .zip'));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); pick(e.dataTransfer.files); });
  el.append(header({ title: t('Importer'), back: 'decks' }), drop, file,
    h('details', { class: 'paste' }, h('summary', null, t('Ou coller du texte')), paste,
      h('div', { class: 'actions' }, h('button', { class: 'btn', onclick: () => { if (paste.value.trim()) handleDetected(() => IM.detectText(paste.value.trim()), t('Texte collé')); } }, t('Analyser')))),
    out);
  const onExt = e => handleFile(e.detail);
  window.addEventListener('mnemo-import', onExt);

  const progress = h('p', { class: 'muted' });
  const busy = msg => { progress.textContent = msg; out.replaceChildren(h('div', { class: 'busy' }, h('span', { class: 'spinner' }), progress)); };
  const done = (res, extra) => out.replaceChildren(h('div', { class: 'done-box' }, h('h2', null, t('Importation terminée')), h('p', null, summary(res)), extra || null,
    h('div', { class: 'actions' }, h('a', { class: 'btn', href: '#/browse?q=' + encodeURIComponent('added:1') }, t('Voir les cartes')), h('a', { class: 'btn primary', href: '#/decks' }, t('Aller aux paquets')))));
  const fail = e => { console.error(e); out.replaceChildren(h('p', { class: 'error' }, e.message || String(e))); };

  async function handleFile(f) { handleDetected(() => IM.detectFile(f), f.name, f); }

  // Import groupé : plusieurs fichiers d'un coup, avec des réglages communs
  async function handleMany(files) {
    busy(t('Analyse de {n} fichiers…', { n: files.length }));
    const items = [];
    for (const f of files) {
      progress.textContent = t('Analyse de « {f} »…', { f: f.name });
      try { items.push({ f, det: await IM.detectFile(f) }); } catch (e) { items.push({ f, err: e.message || String(e) }); }
    }
    const usable = items.filter(it => it.det && !it.det.kind.startsWith('backup'));
    const hasAnki = usable.some(it => ['apkg', 'mnemo'].includes(it.det.kind));
    const hasText = usable.some(it => ['simple', 'rows'].includes(it.det.kind));
    const describe = it => {
      if (it.err) return it.err;
      const d = it.det;
      if (d.kind === 'apkg') return t('Paquet Anki');
      if (d.kind === 'mnemo') return t('JSON Mnemo');
      if (d.kind === 'crowdanki') return 'CrowdAnki';
      if (d.kind === 'simple') return `${d.source} — ${tn(d.notes.length, '{n} note', '{n} notes')}`;
      if (d.kind === 'rows') return `${d.source} — ${tn(d.rows.length, '{n} ligne', '{n} lignes')}`;
      return t('Sauvegarde : à restaurer seule');
    };
    let keep = true, dup = 'update', target = null;
    const tags = h('input', { class: 'input', placeholder: t('étiquettes à ajouter (facultatif)') });
    out.replaceChildren(h('div', { class: 'panel' },
      h('h2', null, tn(files.length, '{n} fichier', '{n} fichiers')),
      h('div', { class: 'preview-list' }, items.map(it => h('div', { class: 'pv' + (it.err || !usable.includes(it) ? ' off' : '') }, h('b', null, it.f.name), h('span', null, describe(it))))),
      hasAnki ? setRow(t('Conserver la planification'), toggle(keep, v => { keep = v; }), t('Désactivé : toutes les cartes repartent comme nouvelles.')) : null,
      hasText ? setRow(t('Destination des fichiers texte'), deckSelect(null, v => { target = v; }, { all: true, allLabel: t('Un paquet par fichier (nom du fichier)') })) : null,
      hasText ? setRow(t('Étiquettes'), tags) : null,
      setRow(t('Notes déjà présentes'), seg([['update', t('Mettre à jour')], ['skip', t('Ignorer')], ['new', t('Dupliquer')]], dup, v => { dup = v; }, { small: true })),
      h('div', { class: 'actions' }, usable.length ? h('button', { class: 'btn primary', onclick: run }, tn(usable.length, 'Importer {n} fichier', 'Importer {n} fichiers'))
        : h('p', { class: 'error' }, t('Aucun fichier importable.')))));
    async function run() {
      busy(t('Importation…'));
      const total = { notesAdded: 0, notesUpdated: 0, notesSkipped: 0, cardsAdded: 0, empty: 0, media: 0 };
      const report = [];
      const rowDup = dup === 'new' ? 'allow' : dup;
      for (const [i, it] of usable.entries()) {
        const step = t('Fichier {a} / {b} : {f}', { a: i + 1, b: usable.length, f: it.f.name });
        progress.textContent = step;
        const sub = m => { progress.textContent = `${step}\n${m}`; };
        try {
          const d = it.det;
          const base = it.f.name.replace(/\.[^.]+$/, '').replace(/::/g, ' ').trim() || t('Sans nom');
          const deckFor = () => target ?? (d.deckName ? deckByName(d.deckName) : deckByName(base));
          let res;
          if (d.kind === 'apkg') res = await IM.mergeFragment(await IM.readApkg(it.f, sub), { keepSched: keep, dup, progress: sub });
          else if (d.kind === 'mnemo') res = await IM.mergeFragment(IM.mnemoToFrag(d.data), { keepSched: keep, dup, progress: sub });
          else if (d.kind === 'crowdanki') res = await IM.mergeFragment(IM.crowdAnkiToFrag(d.data, d.zip || null), { dup, progress: sub });
          else if (d.kind === 'simple') res = IM.importSimple(d.notes, { did: deckFor(), tags: parseTags(tags.value), dup: rowDup });
          else res = autoImportRows(d, { did: deckFor(), tags: parseTags(tags.value), dup: rowDup });
          for (const k in total) total[k] += res[k] || 0;
          report.push(h('div', { class: 'pv' }, h('b', null, it.f.name), h('span', null, summary(res))));
        } catch (e) {
          console.error(e);
          report.push(h('div', { class: 'pv off' }, h('b', null, it.f.name), h('span', { class: 'error-text' }, e.message || String(e))));
        }
        await new Promise(r => setTimeout(r));
      }
      await flush();
      done(total, h('div', { class: 'preview-list' }, report));
    }
  }
  async function handleDetected(detect, name, f = null) {
    busy(t('Analyse de « {f} »…', { f: name }));
    let det;
    try { det = await detect(); } catch (e) { return fail(e); }
    const title = h('h2', null, name);
    if (det.kind === 'apkg' || det.kind === 'mnemo' || det.kind === 'crowdanki') {
      let keep = det.kind !== 'crowdanki', dup = 'update';
      out.replaceChildren(h('div', { class: 'panel' }, title,
        h('p', { class: 'muted' }, det.kind === 'apkg' ? t('Paquet Anki : notes, cartes, médias et historique.') : det.kind === 'crowdanki' ? t('Paquet CrowdAnki.') : t('Export JSON de Mnemo.')),
        det.kind !== 'crowdanki' ? setRow(t('Conserver la planification'), toggle(keep, v => { keep = v; }), t('Désactivé : toutes les cartes repartent comme nouvelles.')) : null,
        setRow(t('Notes déjà présentes'), seg([['update', t('Mettre à jour')], ['skip', t('Ignorer')], ['new', t('Dupliquer')]], dup, v => { dup = v; }, { small: true })),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
          try {
            busy(t('Importation…'));
            let frag;
            if (det.kind === 'apkg') frag = await IM.readApkg(f, m => { progress.textContent = m; });
            else if (det.kind === 'mnemo') frag = IM.mnemoToFrag(det.data);
            else frag = IM.crowdAnkiToFrag(det.data, det.zip || null);
            const res = await IM.mergeFragment(frag, { keepSched: keep, dup, progress: m => { progress.textContent = m; } });
            await flush(); done(res);
          } catch (e) { fail(e); }
        } }, t('Importer')))));
      return;
    }
    if (det.kind === 'backup' || det.kind === 'backup-json') {
      out.replaceChildren(h('div', { class: 'panel' }, title, h('p', null, t('Sauvegarde complète de Mnemo. La restaurer remplace toute la collection actuelle, médias et réglages compris.')),
        h('div', { class: 'actions' }, h('button', { class: 'btn danger', onclick: async () => {
          if (!await confirmBox(t('Remplacer la collection actuelle par cette sauvegarde ?'), { danger: true, ok: t('Restaurer') })) return;
          try {
            busy(t('Restauration…'));
            let json = det.data, loader = null;
            if (det.kind === 'backup') {
              json = JSON.parse(await det.zip.file('mnemo.json').async('string'));
              const names = Object.keys(det.zip.files).filter(p => p.startsWith('media/') && !det.zip.files[p].dir).map(p => p.slice(6));
              loader = { names, load: async n => new Blob([await det.zip.file('media/' + n).async('uint8array')], { type: IM.mimeOf(n) }) };
            }
            await IM.restoreBackup(json, loader, m => { progress.textContent = m; });
            await flush(); toast(t('Sauvegarde restaurée')); setTimeout(() => { location.hash = '#/decks'; location.reload(); }, 400);
          } catch (e) { fail(e); }
        } }, t('Restaurer')))));
      return;
    }
    if (det.kind === 'simple') {
      let did = S.settings.lastDeck && S.decks.has(S.settings.lastDeck) ? S.settings.lastDeck : 1, dup = 'update';
      const tags = h('input', { class: 'input', placeholder: t('étiquettes à ajouter (facultatif)') });
      const byType = {}; for (const n of det.notes) byType[n.type] = (byType[n.type] || 0) + 1;
      const labels = { basic: t('basiques'), reversed: t('recto-verso'), cloze: t('à trous'), mcq: t('QCM'), tf: t('vrai/faux') };
      out.replaceChildren(h('div', { class: 'panel' }, title,
        h('p', null, t('Format {f} : {n}.', { f: det.source, n: Object.entries(byType).map(([k, v]) => `${v} ${labels[k]}`).join(', ') })),
        h('div', { class: 'preview-list' }, det.notes.slice(0, 4).map(n => h('div', { class: 'pv' }, h('b', null, stripHtml(n.front || n.question || n.statement || n.text || '').slice(0, 120)),
          h('span', null, stripHtml(n.back || (n.choices ? n.choices.join(' | ') : '') || (n.answer != null ? (n.answer ? t('Vrai') : t('Faux')) : '')).slice(0, 120))))),
        setRow(t('Paquet'), deckSelect(did, v => { did = v; })),
        setRow(t('Étiquettes'), tags),
        setRow(t('Notes déjà présentes'), seg([['update', t('Mettre à jour')], ['skip', t('Ignorer')], ['allow', t('Dupliquer')]], dup, v => { dup = v; }, { small: true })),
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
          try { const res = IM.importSimple(det.notes, { did, tags: parseTags(tags.value), dup }); await flush(); done(res); } catch (e) { fail(e); }
        } }, tn(det.notes.length, 'Importer {n} note', 'Importer {n} notes')))));
      return;
    }
    if (det.kind === 'rows') rowsPanel(det, title);
  }

  function rowsPanel(det, title) {
    let a = det;
    let hasHeader = !!a.header || looksHeader(a.rows[0]);
    let nt = (a.notetypeName && [...S.notetypes.values()].find(x => x.name === a.notetypeName)) || IM.guessNotetype(hasHeader ? (a.header || a.rows[0]) : null) || IM.findBuiltin('basic') || [...S.notetypes.values()][0];
    let did = a.deckName ? null : (S.settings.lastDeck && S.decks.has(S.settings.lastDeck) ? S.settings.lastDeck : 1);
    let html = a.html, dup = 'update', map, tagsCol = a.tagsCol ?? -1, deckCol = a.deckCol ?? -1;
    const tags = h('input', { class: 'input', placeholder: t('étiquettes à ajouter (facultatif)'), value: (a.tags || []).join(' ') });
    const panel = h('div', { class: 'panel' });
    const header_ = () => hasHeader ? (a.header || a.rows[0]) : null;
    const dataRows = () => hasHeader && !a.header ? a.rows.slice(1) : a.rows;
    const remap = () => { const g = IM.guessMapping(header_(), nt, Math.max(...a.rows.slice(0, 20).map(r => r.length))); map = g.map; if (g.tagsCol >= 0) tagsCol = g.tagsCol; if (g.deckCol >= 0) deckCol = g.deckCol; };
    remap();
    function draw() {
      const nCols = Math.max(1, ...a.rows.slice(0, 50).map(r => r.length));
      const hd = header_();
      const colOpts = sel => [h('option', { value: -1, selected: sel === -1 }, t('— rien —')), ...Array.from({ length: nCols }, (_, i) => h('option', { value: i, selected: sel === i },
        `${t('Colonne {n}', { n: i + 1 })}${hd?.[i] ? ' — ' + truncate(hd[i], 24) : ' — ' + truncate(stripHtml(dataRows()[0]?.[i] || ''), 24)}`))];
      const rows = dataRows();
      if (a.notetypeCol >= 0) {
        panel.replaceChildren(title, h('p', null, t('Export texte d\'Anki : chaque ligne indique son type de note. {n} lignes.', { n: rows.length })),
          setRow(t('Paquet par défaut'), deckSelect(did ?? 1, v => { did = v; })),
          setRow(t('Notes déjà présentes'), seg([['update', t('Mettre à jour')], ['skip', t('Ignorer')], ['allow', t('Dupliquer')]], dup, v => { dup = v; }, { small: true })),
          h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => { try { const res = IM.importAnkiText(a, { did: did ?? 1, dup, tags: parseTags(tags.value) }); await flush(); done(res); } catch (e) { fail(e); } } }, t('Importer'))));
        return;
      }
      const prev = rows.slice(0, 3);
      panel.replaceChildren(title,
        h('p', { class: 'muted' }, t('{s} : {n} lignes, {c} colonnes.', { s: det.source, n: rows.length, c: nCols })),
        det.delim ? setRow(t('Séparateur'), h('select', { class: 'select', onchange: e => { a = { ...IM.analyzeDelimited(det._text ?? '', e.target.value), source: det.source, _text: det._text }; remap(); draw(); } },
          [['\t', t('Tabulation')], [';', t('Point-virgule')], [',', t('Virgule')], ['|', t('Barre verticale')]].map(([v, l]) => h('option', { value: v, selected: a.delim === v }, l)))) : null,
        setRow(t('La première ligne contient les titres'), toggle(hasHeader, v => { hasHeader = v; remap(); draw(); })),
        setRow(t('Type de note'), h('select', { class: 'select', onchange: e => { nt = S.notetypes.get(+e.target.value); remap(); draw(); } },
          [...S.notetypes.values()].map(x => h('option', { value: x.id, selected: x.id === nt.id }, x.name)))),
        setRow(t('Paquet'), deckSelect(did ?? -1, v => { did = v; }, a.deckName ? { all: true, allLabel: t('« {d} » (indiqué dans le fichier)', { d: a.deckName }) } : undefined)),
        h('div', { class: 'set-sec' }, h('h2', null, t('Correspondance des champs')), h('div', { class: 'set-list' },
          nt.flds.map((f, i) => setRow(f.name, h('select', { class: 'select', onchange: e => { map[i] = +e.target.value; draw(); } }, colOpts(map[i])))),
          setRow(t('Étiquettes (colonne)'), h('select', { class: 'select', onchange: e => { tagsCol = +e.target.value; } }, colOpts(tagsCol))),
          setRow(t('Paquet (colonne)'), h('select', { class: 'select', onchange: e => { deckCol = +e.target.value; } }, colOpts(deckCol))))),
        nt.kind === 'mcq' ? h('p', { class: 'muted small' }, t('QCM : séparez les choix par des retours à la ligne ou par « | ». Bonne réponse : lettre(s), numéro(s) ou texte exact.')) : null,
        setRow(t('Interpréter le HTML'), toggle(html, v => { html = v; })),
        setRow(t('Étiquettes à ajouter'), tags),
        setRow(t('Notes déjà présentes'), seg([['update', t('Mettre à jour')], ['skip', t('Ignorer')], ['allow', t('Dupliquer')]], dup, v => { dup = v; }, { small: true }), t('Détection par le premier champ.')),
        prev.length ? h('div', { class: 'scroll-x' }, h('table', { class: 'map-preview' }, h('thead', null, h('tr', null, nt.flds.map(f => h('th', null, f.name)))),
          h('tbody', null, prev.map(r => h('tr', null, nt.flds.map((f, i) => h('td', null, truncate(stripHtml(map[i] >= 0 ? r[map[i]] || '' : ''), 60)))))))) : null,
        h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: async () => {
          if (!map.some(x => x >= 0)) return toast(t('Associez au moins un champ à une colonne.'));
          try {
            const target = did ?? (a.deckName ? deckByName(a.deckName) : 1);
            const res = IM.importRows(dataRows(), { mid: nt.id, did: target, map, tagsCol, deckCol, guidCol: a.guidCol ?? -1, html, tags: parseTags(tags.value), dup });
            await flush(); done(res);
          } catch (e) { fail(e); }
        } }, tn(rows.length, 'Importer {n} ligne', 'Importer {n} lignes'))));
    }
    draw();
    out.replaceChildren(panel);
  }
  return () => window.removeEventListener('mnemo-import', onExt);
}

// ---------- exportation ----------
function viewExport(el, _, params) {
  let did = params.get('deck') ? +params.get('deck') : null;
  let format = params.get('format') || 'apkg', sched = true, media = true;
  const status = h('p', { class: 'muted' });
  const formats = [
    ['apkg', t('Paquet Anki (.apkg)'), t('Pour Anki, AnkiDroid, AnkiMobile ou un autre appareil.')],
    ['tsv', t('Texte (.txt, tabulations)'), t('Compatible avec l\'import texte d\'Anki et les tableurs.')],
    ['csv', t('CSV (.csv)'), t('Pour Excel, Numbers, Google Sheets.')],
    ['json', t('JSON Mnemo (.json)'), t('Notes, cartes et types, sans les médias.')],
    ['backup', t('Sauvegarde complète (.zip)'), t('Toute la collection avec médias et réglages, à restaurer dans Mnemo.')],
  ];
  const opts = h('div');
  const drawOpts = () => opts.replaceChildren(
    format !== 'backup' ? setRow(t('Paquet'), deckSelect(did, v => { did = v; }, { all: true, folders: true })) : null,
    format === 'apkg' || format === 'json' ? setRow(t('Inclure la planification'), toggle(sched, v => { sched = v; }), t('Intervalles et historique des révisions.')) : null,
    format === 'apkg' ? setRow(t('Inclure les médias'), toggle(media, v => { media = v; })) : null);
  el.append(header({ title: t('Exporter'), back: did ? 'deck/' + did : 'decks' }),
    h('div', { class: 'set-sec' }, h('div', { class: 'set-list' }, formats.map(([v, l, d]) => h('label', { class: 'radio-row' },
      h('input', { type: 'radio', name: 'fmt', checked: v === format, onchange: () => { format = v; drawOpts(); } }), h('span', null, h('b', null, l), h('small', null, d)))))),
    h('div', { class: 'set-sec' }, h('div', { class: 'set-list' }, opts)), status,
    h('div', { class: 'actions' }, h('button', { class: 'btn primary', onclick: run }, t('Exporter'))));
  drawOpts();
  async function run() {
    const base = (did != null ? S.decks.get(did).name.replace(/::/g, ' - ') : 'Mnemo').replace(/[\\/:*?"<>|]+/g, '_');
    const stamp = new Date().toISOString().slice(0, 10);
    try {
      status.textContent = t('Préparation…');
      await flush();
      let blob, name;
      if (format === 'apkg') { blob = await EX.exportApkg({ did, sched, media, progress: m => { status.textContent = m; } }); name = base + '.apkg'; }
      else if (format === 'tsv') { blob = EX.exportDelimited({ did, sep: '\t' }); name = base + '.txt'; }
      else if (format === 'csv') { blob = EX.exportDelimited({ did, sep: ',' }); name = base + '.csv'; }
      else if (format === 'json') { blob = EX.exportJson({ did, sched }); name = base + '.json'; }
      else { blob = await EX.exportBackup(m => { status.textContent = m; }); name = `mnemo-${stamp}.zip`; }
      await saveFile(blob, name);
      status.textContent = t('Exporté : {f}', { f: name });
    } catch (e) { console.error(e); status.textContent = e.message; }
  }
}

// ---------- démarrage ----------
async function boot() {
  setLang(detectLang());
  try { await loadAll(); }
  catch (e) { document.getElementById('view').textContent = t('Impossible d\'ouvrir la base de données : ') + e.message; return; }
  if (!S.settings.lang) { S.settings.lang = getLang(); saveSettings(); }
  setLang(S.settings.lang);
  setRollover(S.settings.rollover);
  applyTheme();
  buildTabbar();
  unburyIfNewDay();
  initSync();
  sync.chooser = firstSyncChoice;
  sync.onRemote = () => {
    const name = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 'decks';
    if (['decks', 'deck', 'stats'].includes(name) && !sheetOpen()) rerender();
  };
  // Pas de zoom : Safari ignore user-scalable=no, on bloque donc les gestes de pincement
  for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, e => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
  window.addEventListener('pagehide', () => flush());
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.settings.theme === 'system') applyTheme(); });
  route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  navigator.storage?.persisted?.().then(p => { if (!p) navigator.storage.persist?.().catch(() => {}); });
}
boot();
