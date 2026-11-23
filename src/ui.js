export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'style') el.style.cssText = v; // CSSOM: allowed under a strict style-src CSP
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  x: svg('<path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/>'),
  heart: svg('<path d="M12 20.3s-7.6-4.6-9.2-9.4C1.7 7.5 3.9 4.2 7.3 4.2c2 0 3.6 1.1 4.7 2.7 1.1-1.6 2.7-2.7 4.7-2.7 3.4 0 5.6 3.3 4.5 6.7-1.6 4.8-9.2 9.4-9.2 9.4z" fill="currentColor"/>'),
  undo: svg('<path d="M9 14L4 9l5-5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  skip: svg('<path d="M5 5.5v13l9-6.5-9-6.5z" fill="currentColor"/><path d="M18 5v14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
  play: svg('<path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8a1 1 0 000-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z" fill="currentColor"/>'),
  pause: svg('<rect x="6" y="5" width="4" height="14" rx="1.2" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1.2" fill="currentColor"/>'),
  muted: svg('<path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  sound: svg('<path d="M4 9.5h3.2L12 5.6v12.8l-4.8-3.9H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 010 6M18.3 6.5a8 8 0 010 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  exit: svg('<path d="M12 19V7M7 11.5L12 6.5l5 5" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 3.5h14" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M6 11a6 6 0 0012 0M12 17v3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  menu: svg('<circle cx="5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="19" cy="12" r="1.8" fill="currentColor"/>'),
  close: svg('<path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>'),
  back: svg('<path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'),
  bulb: svg('<path d="M9 18h6M10 21h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 3a6 6 0 00-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0012 3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  help: svg('<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M9.6 9.3a2.5 2.5 0 114 2c-.9.6-1.6 1.1-1.6 2.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r="1.2" fill="currentColor"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>'),
  cloud: svg('<path d="M7 18.5h10a4 4 0 00.6-7.95A5.5 5.5 0 007 9.5a4.5 4.5 0 000 9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>'),
  ext: svg('<path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'),
  plus: svg('<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>'),
};

export const LOGO = `<svg class="logo-mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="9" fill="#C8FF2E"/><path d="M9.5 9.5l6.5 8 6.5-8M16 17.5V24" fill="none" stroke="#0A0E17" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

export const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

let toastTimer;
export function toast(msg, { tone = 'info', ms = 2200, action } = {}) {
  const el = $('#toast');
  el.replaceChildren(h('span', {}, msg));
  if (action) {
    el.append(h('button', { type: 'button', class: 'toast-btn', onclick: () => { hideToast(); action.run(); } }, action.label));
  }
  el.dataset.tone = tone;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
export function hideToast() { $('#toast').classList.remove('show'); }

export const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export const vibrate = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported */ } };
