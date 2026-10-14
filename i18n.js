// Mnemo — langue de l'interface. Les chaînes sources sont en français ; l'anglais vient de i18n-en.js
import EN from './i18n-en.js';

let LANG = 'fr';
export const getLang = () => LANG;
export function detectLang() {
  const l = (globalThis.navigator?.language || 'fr').toLowerCase();
  return l.startsWith('fr') ? 'fr' : 'en';
}
export function setLang(l) {
  LANG = l === 'en' ? 'en' : 'fr';
  if (globalThis.document) document.documentElement.lang = LANG;
}
export const locale = () => (LANG === 'en' ? 'en-GB' : 'fr-CH');

export function t(s, vars) {
  let r = LANG === 'en' ? (EN[s] ?? s) : s;
  if (vars) r = r.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
  return r;
}
// Pluriel : en français 0 et 1 sont au singulier, en anglais seul 1 l'est
export function tn(n, one, many, vars = {}) {
  const single = LANG === 'en' ? Math.abs(n) === 1 : Math.abs(n) < 2;
  return t(single ? one : many, { n: n.toLocaleString(locale()), ...vars });
}
