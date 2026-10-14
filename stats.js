// Mnemo — statistiques (graphiques SVG sans dépendance)
import { S, deckSubtree } from './state.js';
import { today, dayNumber, dayStart, dayLabel, fmtDuration, fmtIvl, esc } from './util.js';
import { retrievability } from './sched.js';
import { t, tn, locale } from './i18n.js';

const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const fmt = n => Number(n).toLocaleString(locale());

function bars(values, { labels = [], color = 'var(--accent)', h = 110, stack = null, every = 5 } = {}) {
  const n = values.length, w = 320, gap = n > 40 ? 1 : 2, bw = (w - gap * (n - 1)) / n;
  const totals = stack ? values.map((_, i) => stack.reduce((s, st) => s + st.values[i], 0)) : values;
  const max = Math.max(1, ...totals);
  let svg = `<svg class="chart" viewBox="0 0 ${w} ${h + 18}" preserveAspectRatio="none" role="img">`;
  svg += `<line x1="0" x2="${w}" y1="${h + .5}" y2="${h + .5}" stroke="var(--line-strong)"/>`;
  values.forEach((v, i) => {
    const x = i * (bw + gap);
    let y = h;
    const parts = stack ? stack.map(st => [st.values[i], st.color, st.name]) : [[v, color, '']];
    const title = labels[i] != null ? `${labels[i]} : ${fmt(totals[i])}` : fmt(totals[i]);
    svg += `<g><title>${esc(title)}</title>`;
    for (const [pv, c] of parts) {
      if (!pv) continue;
      const bh = Math.max(1, pv / max * (h - 4));
      y -= bh;
      svg += `<rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" rx="${Math.min(2, bw / 3)}" fill="${c}"/>`;
    }
    svg += `<rect x="${x.toFixed(2)}" y="0" width="${bw.toFixed(2)}" height="${h}" fill="transparent"/></g>`;
    if (labels[i] != null && i % every === 0) svg += `<text x="${(x + bw / 2).toFixed(1)}" y="${h + 14}" text-anchor="middle" class="ax">${esc(labels[i])}</text>`;
  });
  svg += `<text x="${w}" y="10" text-anchor="end" class="ax">${fmt(max)}</text></svg>`;
  return svg;
}

function heatmap(counts, day, weeks = 22) {
  const cell = 12, gap = 3, w = weeks * (cell + gap), h = 7 * (cell + gap);
  const end = day; const startDow = (new Date(dayStart(end)).getDay() + 6) % 7;
  const first = end - startDow - (weeks - 1) * 7;
  const vals = []; for (let d = first; d <= end; d++) vals.push(counts.get(d) || 0);
  const nz = vals.filter(Boolean).sort((a, b) => a - b);
  const max = Math.max(1, nz.length ? nz[Math.min(nz.length - 1, Math.floor(nz.length * 0.95))] : 1);
  let svg = `<svg class="chart heat" viewBox="0 0 ${w} ${h + 14}" role="img">`;
  for (let d = first; d <= end; d++) {
    const k = d - first, col = Math.floor(k / 7), row = k % 7;
    const v = counts.get(d) || 0;
    const lvl = v ? Math.min(4, Math.ceil(v / max * 4)) : 0;
    const fill = lvl ? `color-mix(in srgb, var(--accent) ${[0, 30, 55, 78, 100][lvl]}%, transparent)` : 'var(--surface-2)';
    svg += `<rect x="${col * (cell + gap)}" y="${row * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${fill}"${d === day ? ' stroke="var(--fg)" stroke-width="1"' : ''}><title>${esc(dayLabel(d))} : ${tn(v, '{n} révision', '{n} révisions')}</title></rect>`;
  }
  for (let col = 0; col < weeks; col += 4) {
    const d = first + col * 7;
    svg += `<text x="${col * (cell + gap)}" y="${h + 11}" class="ax">${esc(dayLabel(d, { month: 'short' }))}</text>`;
  }
  return svg + '</svg>';
}

function legend(items) {
  return `<div class="legend">${items.map(([c, l, v]) => `<span><i style="background:${c}"></i>${esc(l)}${v != null ? ` <b>${fmt(v)}</b>` : ''}</span>`).join('')}</div>`;
}

export function statsHtml(did = null) {
  const day = today(), now = Date.now(), t0 = dayStart(day);
  const dset = did == null ? null : new Set(deckSubtree(did));
  const cards = [...S.cards.values()].filter(c => !dset || dset.has(c.did));
  const cids = new Set(cards.map(c => c.id));
  const logs = S.revlog.filter(l => l.ease >= 1 && cids.has(l.cid));
  const out = [];

  // Aujourd'hui
  const todayLogs = logs.filter(l => l.id >= t0);
  const tTime = todayLogs.reduce((s, l) => s + l.time, 0);
  const tAgain = todayLogs.filter(l => l.ease === 1).length;
  const byDay = new Map();
  for (const l of logs) { const d = dayNumber(l.id); byDay.set(d, (byDay.get(d) || 0) + 1); }
  let streak = 0; for (let d = byDay.has(day) ? day : day - 1; byDay.has(d); d--) streak++;
  out.push(`<section class="stat"><h2>${t("Aujourd'hui")}</h2><div class="figs">
    <div><b>${fmt(todayLogs.length)}</b><span>${t('cartes revues')}</span></div>
    <div><b>${fmtDuration(tTime)}</b><span>${t("temps d'étude")}</span></div>
    <div><b>${todayLogs.length ? pct(todayLogs.length - tAgain, todayLogs.length) + ' %' : '–'}</b><span>${t('réussite')}</span></div>
    <div><b>${fmt(streak)}</b><span>${tn(streak, 'jour de suite', 'jours de suite')}</span></div></div></section>`);

  // Prévisions
  const fc = new Array(31).fill(0), fcL = new Array(31).fill(0);
  for (const c of cards) {
    if (c.queue === 2 || c.queue === 3) { const k = Math.max(0, c.due - day); if (k <= 30) fc[k]++; }
    else if (c.queue === 1) fcL[0]++;
  }
  out.push(`<section class="stat"><h2>${t('Prévisions sur 30 jours')}</h2>
    <p class="sub">${tn(fc[0] + fcL[0], "{n} carte à revoir aujourd'hui", "{n} cartes à revoir aujourd'hui")}, ${tn(fc[1], '{n} demain', '{n} demain')}, ${t('{n} cette semaine', { n: fmt(fc.slice(0, 7).reduce((a, b) => a + b, 0) + fcL[0]) })}.</p>
    ${bars(fc.map((v, i) => v + fcL[i]), { labels: fc.map((_, i) => i === 0 ? t('auj.') : '+' + i) })}</section>`);

  // Calendrier
  out.push(`<section class="stat"><h2>${t('Calendrier')}</h2><div class="scroll-x">${heatmap(byDay, day)}</div></section>`);

  // Révisions par jour (30 j), par type
  const rv = { learn: new Array(30).fill(0), rev: new Array(30).fill(0), relearn: new Array(30).fill(0) };
  let time30 = 0, n30 = 0;
  for (const l of logs) {
    const k = 29 - (day - dayNumber(l.id));
    if (k < 0 || k > 29) continue;
    n30++; time30 += l.time;
    (l.type === 0 ? rv.learn : l.type === 2 ? rv.relearn : rv.rev)[k]++;
  }
  const daysActive = new Set(logs.filter(l => day - dayNumber(l.id) < 30).map(l => dayNumber(l.id))).size;
  out.push(`<section class="stat"><h2>${t('Révisions (30 derniers jours)')}</h2>
    <p class="sub">${t('{a} révisions en {b}, étude {c} jours sur 30.', { a: fmt(n30), b: fmtDuration(time30), c: daysActive })}</p>
    ${bars(rv.rev, { labels: rv.rev.map((_, i) => i === 29 ? t('auj.') : String(i - 29)), stack: [
      { values: rv.learn, color: 'var(--new)' }, { values: rv.relearn, color: 'var(--again)' }, { values: rv.rev, color: 'var(--good)' }] })}
    ${legend([['var(--new)', t('Apprentissage')], ['var(--good)', t('Révision')], ['var(--again)', t('Réapprentissage')]])}</section>`);

  // Répartition
  const cnt = { n: 0, l: 0, y: 0, m: 0, s: 0, b: 0 };
  for (const c of cards) {
    if (c.queue === -1) cnt.s++; else if (c.queue < -1) cnt.b++;
    else if (c.type === 0) cnt.n++; else if (c.type === 1 || c.type === 3) cnt.l++;
    else if (c.ivl >= 21) cnt.m++; else cnt.y++;
  }
  const total = cards.length || 1;
  const segs = [['var(--new)', t('Nouvelles'), cnt.n], ['var(--learn)', t('En apprentissage'), cnt.l], ['color-mix(in srgb, var(--good) 55%, transparent)', t('Récentes'), cnt.y],
    ['var(--good)', t('Mûres (≥ 21 j)'), cnt.m], ['var(--muted)', t('Suspendues'), cnt.s], ['var(--line-strong)', t('Enfouies'), cnt.b]];
  out.push(`<section class="stat"><h2>${t('Cartes')}</h2><p class="sub">${tn(cards.length, '{n} carte au total', '{n} cartes au total')}</p>
    <div class="meter">${segs.filter(s => s[2]).map(([c, , v]) => `<i style="background:${c};width:${v / total * 100}%"></i>`).join('')}</div>
    ${legend(segs)}</section>`);

  // Intervalles
  const buckets = [[1, 1], [2, 2], [3, 4], [5, 7], [8, 14], [15, 30], [31, 90], [91, 180], [181, 365], [366, 1e9]];
  const blabels = ['1 j', '2 j', '3–4 j', '5–7 j', '1–2 s', '2–4 s', '1–3 m', '3–6 m', '6–12 m', '1 an+'].map(x => t(x));
  const bv = buckets.map(() => 0);
  for (const c of cards) if (c.type === 2 && c.queue !== -1) { const i = buckets.findIndex(([a, b]) => c.ivl >= a && c.ivl <= b); if (i >= 0) bv[i]++; }
  const ivls = cards.filter(c => c.type === 2).map(c => c.ivl);
  out.push(`<section class="stat"><h2>${t('Intervalles')}</h2>
    <p class="sub">${ivls.length ? t('Intervalle moyen : {a} j, le plus long : {b} j.', { a: Math.round(ivls.reduce((a, b) => a + b, 0) / ivls.length), b: Math.max(...ivls) }) : t('Aucune carte en révision pour l\'instant.')}</p>
    ${bars(bv, { labels: blabels, every: 1, h: 90 })}</section>`);

  // Boutons et rétention (30 j)
  const recent = logs.filter(l => day - dayNumber(l.id) < 30);
  const btn = type => { const r = [0, 0, 0, 0]; for (const l of recent) if ((type === 'learn' ? l.type === 0 || l.type === 2 : l.type === 1)) r[l.ease - 1]++; return r; };
  const row = (label, r) => {
    const s = r.reduce((a, b) => a + b, 0);
    if (!s) return '';
    const cols = ['var(--again)', 'var(--hard)', 'var(--good)', 'var(--easy)'];
    return `<div class="btnrow"><span>${label}</span><div class="meter">${r.map((v, i) => v ? `<i style="background:${cols[i]};width:${v / s * 100}%" title="${v}"></i>` : '').join('')}</div><em>${pct(s - r[0], s)} %</em></div>`;
  };
  const revL = recent.filter(l => l.type === 1);
  const young = revL.filter(l => l.lastIvl < 21), mature = revL.filter(l => l.lastIvl >= 21);
  const ret = arr => arr.length ? pct(arr.filter(l => l.ease > 1).length, arr.length) + ' %' : '–';
  out.push(`<section class="stat"><h2>${t('Réponses (30 derniers jours)')}</h2>
    ${row(t('Apprentissage'), btn('learn'))}${row(t('Révision'), btn('rev'))}
    ${legend([['var(--again)', t('À revoir')], ['var(--hard)', t('Difficile')], ['var(--good)', t('Correct')], ['var(--easy)', t('Facile')]])}
    <p class="sub">${t('Rétention réelle : {a} sur les cartes récentes, {b} sur les cartes mûres.', { a: ret(young), b: ret(mature) })}</p></section>`);

  // FSRS
  const mem = cards.filter(c => c.type === 2 && c.s != null && c.d != null);
  if (mem.length) {
    const rs = mem.map(c => retrievability(c, now)).filter(x => x != null);
    const avg = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
    out.push(`<section class="stat"><h2>${t('Mémoire (FSRS)')}</h2><div class="figs">
      <div><b>${Math.round(avg(rs) * 100)} %</b><span>${t('rappel estimé')}</span></div>
      <div><b>${fmtIvl(avg(mem.map(c => c.s)))}</b><span>${t('stabilité moyenne')}</span></div>
      <div><b>${((avg(mem.map(c => c.d)) - 1) / 9 * 100).toFixed(0)} %</b><span>${t('difficulté moyenne')}</span></div></div></section>`);
  }
  return out.join('');
}
