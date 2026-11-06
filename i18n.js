/**
 * i18n.js: English and Arabic.
 *
 * English text is the key, so code reads normally: t('Camera not started.').
 * lang-init.js has already chosen the language before the page paints. This
 * module loads on its own, ahead of the much larger app.js, so Arabic readers
 * see Arabic right away even on a slow connection. It can also switch live.
 *
 *   t(text, vars)      text in the current language, {name} filled from vars
 *   en(text, vars)     always English (exported logs stay in one language)
 *   m(text, vars)      a message to translate later, can be nested inside vars
 *   say(el, text, vars) show translated text in an element, and keep it translated
 *                       when the language changes
 *   plain(el, text)    show text as it is (numbers, JSON, a person's own words)
 *
 * Everything goes through textContent: no HTML strings, so no injection risk.
 */

import { AR } from './i18n-ar.js';

const STORAGE_KEY = 'face-unlock-demo:lang';

const html = document.documentElement;
export let lang = html.dataset.lang === 'ar' ? 'ar' : 'en';

function fill(dict, text, vars) {
  const template = (dict && Object.hasOwn(dict, text)) ? dict[text] : text;
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (_, name) => {
    const value = vars[name];
    return value && typeof value === 'object' ? fill(dict, value.text, value.vars) : String(value ?? '');
  });
}

export const t = (text, vars) => fill(lang === 'ar' ? AR : null, text, vars);
export const en = (text, vars) => fill(null, text, vars);
export const m = (text, vars) => ({ text, vars });
export const asMessage = (message) => (typeof message === 'string' ? { text: message } : message);

// Elements showing translated text from code, re-rendered when the language changes
const bound = new Map();

export function say(el, message, vars) {
  const msg = typeof message === 'string' ? { text: message, vars } : message;
  bound.set(el, msg);
  const text = t(msg.text, msg.vars);
  if (el.textContent !== text) el.textContent = text;
}

export function plain(el, text) {
  bound.delete(el);
  el.textContent = text;
}

// ---------- Text written in index.html ----------

const originalText = new WeakMap();
const originalAttrs = new WeakMap();
const ATTRS = ['placeholder', 'aria-label', 'title'];
const tidy = (s) => s.replace(/\s+/g, ' ').trim();

/** Translate the page's static text and attributes, keeping the English to switch back to. */
export function applyStatic(root = document.body) {
  const ar = lang === 'ar';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (bound.has(node.parentElement)) continue;
    let source = originalText.get(node);
    if (source == null) {
      if (!Object.hasOwn(AR, tidy(node.data))) continue;
      source = node.data;
      originalText.set(node, source);
    }
    // Keep the spaces around the text: they separate it from a neighbouring <b> or <small>
    node.data = ar ? source.match(/^\s*/)[0] + AR[tidy(source)] + source.match(/\s*$/)[0] : source;
  }

  for (const el of root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(','))) {
    for (const attr of ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const saved = originalAttrs.get(el) ?? {};
      const source = saved[attr] ?? el.getAttribute(attr);
      if (!Object.hasOwn(AR, source)) continue;
      saved[attr] = source;
      originalAttrs.set(el, saved);
      el.setAttribute(attr, ar ? AR[source] : source);
    }
  }

  document.title = t('Face + Gesture Unlock');
  const description = document.querySelector('meta[name="description"]');
  if (description) {
    description.dataset.en ??= description.content;
    description.content = t(description.dataset.en);
  }
}

// ---------- Switching ----------

const listeners = [];
export const onLanguageChange = (fn) => listeners.push(fn);

export function setLanguage(next) {
  lang = next === 'ar' ? 'ar' : 'en';
  html.lang = lang;
  html.dir = lang === 'ar' ? 'rtl' : 'ltr';
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* storage blocked: lasts until reload */ }

  // A ?lang= in the address would override this choice on the next reload
  const url = new URL(location.href);
  if (url.searchParams.has('lang')) {
    url.searchParams.delete('lang');
    history.replaceState(null, '', url);
  }

  applyStatic();
  for (const [el, msg] of bound) el.textContent = t(msg.text, msg.vars);
  for (const fn of listeners) fn();
}

// ---------- First paint ----------

if (lang === 'ar') {
  html.lang = 'ar';
  html.dir = 'rtl';
  applyStatic();
  const button = document.getElementById('langBtn');
  if (button) {
    button.textContent = 'English';
    button.lang = 'en';
  }
  html.classList.remove('i18n-pending');
}
