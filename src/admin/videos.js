// Videos tab: per-video weighted score, split, reasons, watch time, drop-off histogram, ideas.
import { h, append, icon, fmtScore, pct, relTime, toDate } from './util.js';
import { aggregateVideo, GOOD_REASONS, BAD_REASONS } from './stats.js';

const SORTS = [['score', 'Score'], ['count', 'Ratings'], ['watched', 'Watched'], ['title', 'Title']];
let sortKey = 'score';
let sortDir = -1;
let open = new Set();

export function renderVideos(view, ctx) {
  const { ratings, ratersById } = ctx.data;
  const byVideo = {};
  for (const r of ratings) (byVideo[r.videoId] ||= []).push(r);
  const rows = Object.entries(byVideo).map(([id, rs]) => ({
    ...aggregateVideo(id, rs, ratersById, ctx.data.videosById[id]),
    title: ctx.videoTitle(id),
    cat: ctx.data.videosById[id]?.cat || id.split('-')[0],
  }));
  const val = (r) => ({ score: r.score ?? -2, count: r.count, watched: r.medianWatched ?? -1, title: r.title.toLowerCase() }[sortKey]);
  rows.sort((a, b) => {
    const x = val(a), y = val(b);
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return (sortKey === 'title' ? 1 : sortDir) * c || b.count - a.count;
  });

  if (ctx.focusVideo) { open.add(ctx.focusVideo); }
  const total = ratings.length;
  const unrated = Math.max(0, ctx.data.videos.length - rows.length);

  view.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, `${total} ratings · ${rows.length} videos${unrated ? ` · ${unrated} not rated yet` : ''}`),
        h('h1', null, 'Videos')),
      h('div', { class: 'sorter', role: 'toolbar', 'aria-label': 'Sort videos' },
        h('span', { class: 'muted small' }, 'Sort'),
        SORTS.map(([k, label]) => h('button', {
          class: `chip${sortKey === k ? ' on' : ''}`, 'data-sort': k, 'aria-pressed': String(sortKey === k),
          onclick: () => { if (sortKey === k && k !== 'title') sortDir *= -1; else { sortKey = k; sortDir = -1; } ctx.rerender(); },
        }, label, sortKey === k && k !== 'title' ? h('span', { class: 'dir' }, sortDir < 0 ? '↓' : '↑') : null)))),
    h('p', { class: 'muted small legend' }, 'Score is trust-weighted: each rating counts trust/50, good = +1, bad = −1, so it runs from −1 to +1.'),
  );

  if (!rows.length) {
    view.appendChild(h('div', { class: 'empty' }, h('h2', null, 'No ratings yet'), h('p', { class: 'muted' }, 'Ratings appear here as soon as raters start swiping.')));
    return;
  }

  const list = h('div', { class: 'vlist' },
    h('div', { class: 'vrow vhead', 'aria-hidden': 'true' },
      h('span', null, 'Video'), h('span', null, 'Score'), h('span', null, 'Good / bad'), h('span', null, 'Ratings'), h('span', null, 'Watched'), h('span')));
  for (const r of rows) list.appendChild(videoRow(r, ctx));
  view.appendChild(list);

  if (ctx.focusVideo) {
    const el = document.getElementById(`v-${ctx.focusVideo}`);
    ctx.focusVideo = null;
    if (el) requestAnimationFrame(() => el.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }
}

function scoreBar(score) {
  const s = score ?? 0;
  const w = Math.abs(s) * 50;
  return h('span', { class: 'sbar', 'aria-hidden': 'true' },
    h('span', { class: `sbar-fill ${s >= 0 ? 'pos' : 'neg'}`, style: s >= 0 ? { left: '50%', width: `${w}%` } : { left: `${50 - w}%`, width: `${w}%` } }),
    h('span', { class: 'sbar-mid' }));
}

function videoRow(r, ctx) {
  const isOpen = open.has(r.videoId);
  const goodPct = r.count ? (r.good / r.count) * 100 : 0;
  const detail = h('div', { class: 'vdetail' });
  const wrap = h('div', { class: `vitem${isOpen ? ' open' : ''}`, id: `v-${r.videoId}`, 'data-video': r.videoId });
  const btn = h('button', {
    class: 'vrow', 'aria-expanded': String(isOpen),
    onclick: () => {
      const now = !wrap.classList.contains('open');
      wrap.classList.toggle('open', now);
      btn.setAttribute('aria-expanded', String(now));
      if (now) { open.add(r.videoId); if (!detail.firstChild) fillDetail(detail, r, ctx); } else open.delete(r.videoId);
    },
  },
  h('span', { class: 'vtitle' }, h('span', { class: 'vcat' }, ctx.data.cats[r.cat] || r.cat), h('b', null, r.title)),
  h('span', { class: `vscore ${r.score == null ? '' : r.score >= 0 ? 'pos' : 'neg'}` }, h('b', null, fmtScore(r.score)), scoreBar(r.score)),
  h('span', { class: 'split' },
    h('span', { class: 'split-bar', title: `${r.good} good, ${r.bad} bad` }, h('span', { class: 'split-good', style: { width: `${goodPct}%` } })),
    h('span', { class: 'split-txt' }, h('span', { class: 'g' }, String(r.good)), ' / ', h('span', { class: 'r' }, String(r.bad)))),
  h('span', { class: 'vnum' }, h('b', null, String(r.count)), h('span', { class: 'mob-l' }, ' ratings')),
  h('span', { class: 'vnum' }, h('b', null, pct(r.medianWatched)), h('span', { class: 'mob-l' }, ' watched')),
  h('span', { class: 'chev' }, icon('chevron')));
  wrap.append(btn, detail);
  if (isOpen) fillDetail(detail, r, ctx);
  return wrap;
}

function reasonBars(title, defs, counts, total, kind) {
  const max = Math.max(1, ...defs.map(([k]) => counts[k] || 0));
  return h('div', { class: 'rbars' },
    h('p', { class: 'label' }, title),
    defs.map(([k, label]) => {
      const n = counts[k] || 0;
      return h('div', { class: 'rbar' },
        h('span', { class: 'rbar-l' }, label),
        h('span', { class: 'rbar-track' }, h('span', { class: `rbar-fill ${kind}`, style: { width: `${(n / max) * 100}%` } })),
        h('span', { class: 'rbar-n' }, String(n)));
    }));
}

function dropHistogram(r) {
  const { counts, size, max } = r.hist;
  const W = 320, Hh = 96, pad = 18, bw = W / counts.length;
  const peak = Math.max(1, ...counts);
  const svg = h('svg', { viewBox: `0 0 ${W} ${Hh + pad}`, class: 'hist', role: 'img',
    'aria-label': `Drop-off histogram: ${r.drops.length} early exits over ${Math.round(max)} seconds` });
  counts.forEach((c, i) => {
    const bh = (c / peak) * (Hh - 8);
    const rect = h('rect', { x: i * bw + 2, y: Hh - bh, width: bw - 4, height: Math.max(bh, c ? 2 : 0), rx: 3, class: 'hist-bar' });
    rect.appendChild(h('title', null, `${Math.round(i * size)}–${Math.round((i + 1) * size)}s: ${c}`));
    svg.appendChild(rect);
  });
  svg.appendChild(h('line', { x1: 0, x2: W, y1: Hh + 0.5, y2: Hh + 0.5, class: 'hist-axis' }));
  for (const t of [0, 0.5, 1]) {
    svg.appendChild(h('text', { x: t * W, y: Hh + 14, class: 'hist-tick', 'text-anchor': t === 0 ? 'start' : t === 1 ? 'end' : 'middle' }, `${Math.round(t * max)}s`));
  }
  return svg;
}

function fillDetail(el, r, ctx) {
  const total = r.count;
  const nick = (uid) => ctx.data.ratersById[uid]?.nickname || 'Rater';
  append(el, [
    h('div', { class: 'vgrid' },
      h('div', { class: 'panel' },
        reasonBars('Why good', GOOD_REASONS, r.reasonCounts, total, 'good'),
        reasonBars('Why bad', BAD_REASONS, r.reasonCounts, total, 'bad'),
        r.reasonCounts.other ? h('p', { class: 'muted small' }, `“Other” ticked ${r.reasonCounts.other}×`) : null),
      h('div', { class: 'panel' },
        h('p', { class: 'label' }, 'Where people left'),
        r.drops.length ? dropHistogram(r) : h('p', { class: 'muted small' }, 'Nobody left early.'),
        h('div', { class: 'kv' },
          h('span', null, 'Median watched', h('b', null, pct(r.medianWatched))),
          h('span', null, 'Swiped early', h('b', null, `${r.swipedEarly} of ${total}`)),
          h('span', null, 'Length', h('b', null, r.duration ? `${Math.round(r.duration)}s` : '–'))))),
    (r.ideas.length || r.others.length) ? h('div', { class: 'panel' },
      h('p', { class: 'label' }, `Latest ideas (${r.ideas.length})`),
      h('ul', { class: 'ideas' },
        r.ideas.slice(0, 6).map((i) => h('li', null, h('p', null, i.text),
          h('span', { class: 'muted small' }, `${nick(i.uid)} · ${i.via || 'text'} · ${relTime(toDate(i.at))}`))),
        r.others.slice(0, 4).map((o) => h('li', { class: 'other' }, h('p', null, o.text),
          h('span', { class: 'muted small' }, `${nick(o.uid)} · “other” on a ${o.verdict} rating`))))) : null,
  ]);
}
