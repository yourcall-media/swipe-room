// Small DOM + formatting helpers. All user/rater-provided text goes through textContent
// (never innerHTML), so rater nicknames, ideas and quotes cannot inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_TAGS = new Set(['svg', 'rect', 'line', 'path', 'g', 'text', 'title', 'circle']);

export function h(tag, props, ...children) {
  const isSvg = SVG_TAGS.has(tag);
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.setAttribute('class', v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'value' && !isSvg) el.value = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function relTime(date) {
  if (!date) return 'never';
  const ms = Date.now() - date.getTime();
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const d = Math.round(hrs / 24);
  if (d < 30) return `${d} d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function toDate(ts) {
  if (!ts) return null;
  if (typeof ts.toDate === 'function') return ts.toDate();
  if (ts instanceof Date) return ts;
  return null;
}

export function fmtScore(s) {
  if (s == null || Number.isNaN(s)) return '–';
  const v = Math.round(s * 100) / 100;
  return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2);
}

export function pct(x) {
  if (x == null || Number.isNaN(x)) return '–';
  return `${Math.round(x * 100)}%`;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const chars = [...(parts[0] || '?')];
  const second = parts[1] ? [...parts[1]][0] : chars[1] || '';
  return (chars[0] + (second || '')).toUpperCase();
}

export function prettifyId(id) {
  return String(id)
    .replace(/^[a-z]+-\d+-/, '')
    .split('-')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

// Invite codes: unambiguous uppercase alphabet, crypto-random.
export function newInviteCode(prefix = 'YC') {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return `${prefix}-${s.slice(0, 4)}-${s.slice(4)}`;
}

let toastTimer;
export function toast(msg, kind = 'info') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

export function icon(name) {
  const paths = {
    check: 'M5 12.5l4.2 4.2L19 7',
    x: 'M6 6l12 12M18 6L6 18',
    clock: 'M12 7v5l3 2M12 21a9 9 0 110-18 9 9 0 010 18z',
    warn: 'M12 9v4M12 17h.01M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
    copy: 'M9 9h10v10H9zM5 15V5h10',
    review: 'M4 6h16M4 12h10M4 18h7M17 15l2 2 4-4',
    video: 'M4 5h11a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V7a2 2 0 012-2zM17 10l5-3v10l-5-3',
    people: 'M9 11a4 4 0 100-8 4 4 0 000 8zM2 21v-1a6 6 0 0112 0v1M16 3.5a4 4 0 010 7.5M22 21v-1a6 6 0 00-4-5.6',
    refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
    note: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
    chevron: 'M9 6l6 6-6 6',
    plus: 'M12 5v14M5 12h14',
    logout: 'M15 4h3a2 2 0 012 2v12a2 2 0 01-2 2h-3M10 17l-5-5 5-5M5 12h11',
  };
  const svg = h('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor',
    'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ic' });
  svg.appendChild(h('path', { d: paths[name] || '' }));
  return svg;
}
