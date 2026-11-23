// Review tab: the current open batch, one card per item, Approve / Reject / Later + note.
import { doc, runTransaction, serverTimestamp, Timestamp } from 'firebase/firestore';
import { h, append, toast, icon, initials, relTime, toDate } from './util.js';

const VERDICTS = [
  ['reject', 'Reject', 'x'],
  ['later', 'Later', 'clock'],
  ['approve', 'Approve', 'check'],
];
const FILTERS = [['todo', 'To review'], ['all', 'All'], ['approve', 'Approved'], ['later', 'Later'], ['reject', 'Rejected']];
let filter = 'todo';

export function renderReview(view, ctx) {
  const batch = ctx.data.batch;
  if (!batch) {
    view.appendChild(empty('No open batch', 'The daily pipeline opens a new batch of ideas to review. Check back after the next run.'));
    return;
  }
  const items = Array.isArray(batch.items) ? batch.items : [];
  const done = items.filter((i) => i.verdict).length;
  const created = toDate(batch.createdAt);

  const progressText = h('span', { id: 'progress-text' }, `${done} of ${items.length} reviewed`);
  const bar = h('div', { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': items.length, 'aria-valuenow': done },
    h('div', { class: 'progress-fill', style: { width: items.length ? `${(done / items.length) * 100}%` : '0%' } }));
  const counts = { all: items.length, todo: items.length - done };
  for (const i of items) if (i.verdict) counts[i.verdict] = (counts[i.verdict] || 0) + 1;

  const head = h('div', { class: 'page-head' },
    h('div', null,
      h('p', { class: 'eyebrow' }, `Batch ${batch.id}${created ? ` · opened ${relTime(created)}` : ''}`),
      h('h1', null, 'Review ideas'),
    ),
    h('div', { class: 'progress-wrap' }, progressText, bar));

  const chips = h('div', { class: 'chips', role: 'toolbar', 'aria-label': 'Filter items' },
    FILTERS.map(([k, label]) => h('button', {
      class: `chip${filter === k ? ' on' : ''}`, 'data-filter': k, 'aria-pressed': String(filter === k),
      onclick: () => { filter = k; ctx.rerender(); },
    }, label, h('span', { class: 'chip-n' }, String(counts[k] || 0)))));

  const list = h('div', { class: 'cards' });
  const shown = items.filter((i) => filter === 'all' || (filter === 'todo' ? !i.verdict : i.verdict === filter));
  // highest score first among the shown ones
  shown.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  for (const item of shown) list.appendChild(itemCard(item, batch, ctx));
  if (!shown.length) {
    list.appendChild(filter === 'todo' && items.length
      ? empty('All caught up', `You reviewed all ${items.length} items in this batch.`, true)
      : empty('Nothing here', 'No items match this filter.'));
  }
  view.append(head, chips, list);
}

function empty(title, text, good) {
  return h('div', { class: `empty${good ? ' good' : ''}` }, good ? h('div', { class: 'empty-ic' }, icon('check')) : null,
    h('h2', null, title), h('p', { class: 'muted' }, text));
}

function scale(label, n) {
  const v = Math.max(0, Math.min(5, Number(n) || 0));
  return h('span', { class: 'scale', title: `${label} ${v} of 5` },
    h('span', { class: 'scale-l' }, label),
    h('span', { class: 'dots', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= v ? 'on' : '' }))),
    h('span', { class: 'sr' }, `${v} of 5`));
}

function trustBadge(trust, badge) {
  const b = badge || (trust >= 80 ? 'gold' : trust >= 55 ? 'silver' : 'bronze');
  return h('span', { class: `badge badge-${b}`, title: `${b} · trust ${trust}` }, String(trust ?? 50));
}

function itemCard(item, batch, ctx) {
  const { ratersById } = ctx.data;
  const card = h('article', { class: `card item v-${item.verdict || 'none'}`, 'data-item': item.id, id: `item-${item.id}` });

  const noteArea = h('textarea', {
    class: 'note', rows: 2, maxlength: 1000, placeholder: 'Note for the pipeline (optional)…',
    'aria-label': `Note for ${item.title}`, value: item.note || '',
  });
  const noteWrap = h('div', { class: `note-wrap${item.note ? ' open' : ''}` }, noteArea);
  const noteToggle = h('button', { class: 'link-btn', onclick: () => { noteWrap.classList.add('open'); noteToggle.remove(); noteArea.focus(); } },
    icon('note'), 'Add note');
  // Saving a note on an already-decided item happens on blur.
  // Deferred so that tapping a verdict button (which also blurs) saves once, with the note.
  noteArea.addEventListener('blur', () => setTimeout(() => {
    if (!card.isConnected || card.classList.contains('saving')) return;
    if (item.verdict && noteArea.value !== (item.note || '')) save(ctx, batch, item, item.verdict, noteArea.value, card);
  }, 250));

  const actions = h('div', { class: 'actions' }, VERDICTS.map(([v, label, ic]) => h('button', {
    class: `act act-${v}${item.verdict === v ? ' on' : ''}`, 'data-verdict': v,
    'aria-pressed': String(item.verdict === v),
    onclick: () => save(ctx, batch, item, item.verdict === v ? null : v, noteArea.value, card),
  }, icon(ic), h('span', null, label))));

  const status = item.verdict ? h('span', { class: `status status-${item.verdict}` },
    { approve: 'Approved', reject: 'Rejected', later: 'Later' }[item.verdict]) : null;

  append(card, [
    h('div', { class: 'item-top' },
      h('div', { class: 'meta-row' },
        scale('Impact', item.impact), scale('Effort', item.effort),
        typeof item.score === 'number' ? h('span', { class: 'score-pill', title: 'Pipeline score' }, item.score.toFixed(1)) : null),
      status),
    h('h2', { class: 'item-title' }, item.title || '(untitled)'),
    item.summary ? h('p', { class: 'item-summary' }, item.summary) : null,
    item.conflicts ? h('div', { class: 'conflict', role: 'note' }, icon('warn'), h('span', null, h('b', null, 'Conflict: '), item.conflicts)) : null,
    (item.videoIds || []).length ? h('div', { class: 'block' },
      h('p', { class: 'label' }, `About ${item.videoIds.length === 1 ? '1 video' : `${item.videoIds.length} videos`}`),
      h('div', { class: 'vchips' }, item.videoIds.map((id) => h('button', {
        class: 'vchip', onclick: () => ctx.goVideo(id), title: 'Open in Videos',
      }, h('span', { class: 'vchip-cat' }, catShort(ctx, id)), ctx.videoTitle(id))))) : null,
    (item.suggesters || []).length ? h('div', { class: 'block' },
      h('p', { class: 'label' }, 'Suggested by'),
      h('div', { class: 'people' }, item.suggesters.map((s) => {
        const r = ratersById[s.uid];
        const trust = r?.trust ?? s.trust ?? 50;
        return h('span', { class: 'person' }, h('span', { class: 'pav' }, initials(s.nickname || r?.nickname)),
          h('span', { class: 'pname' }, s.nickname || r?.nickname || 'Rater'), trustBadge(trust, r?.badge));
      }))) : null,
    (item.quotes || []).length ? h('div', { class: 'quotes' }, item.quotes.slice(0, 4).map((q) => h('blockquote', null, q))) : null,
    h('div', { class: 'item-foot' }, item.note ? null : noteToggle, noteWrap, actions),
  ]);
  return card;
}

function catShort(ctx, id) {
  const v = ctx.data.videosById[id];
  return (v && v.cat) || id.split('-')[0];
}

async function save(ctx, batch, item, verdict, note, card) {
  const noteVal = String(note || '').slice(0, 1000);
  const db = ctx.db;
  const batchRef = doc(db, 'batches', batch.id);
  const safeId = String(item.id).replace(/\//g, '_');
  const approvedRef = doc(db, 'approved', safeId);
  card.classList.add('saving');
  for (const b of card.querySelectorAll('.act')) b.disabled = true;
  try {
    const updated = await runTransaction(db, async (tx) => {
      const snap = await tx.get(batchRef);
      if (!snap.exists()) throw new Error('Batch no longer exists');
      const items = snap.data().items || [];
      const idx = items.findIndex((i) => i.id === item.id);
      if (idx < 0) throw new Error('Item no longer in batch');
      const next = { ...items[idx], verdict, note: noteVal, decidedAt: verdict ? Timestamp.now() : null, decidedBy: ctx.user.uid };
      const newItems = items.slice();
      newItems[idx] = next;
      tx.update(batchRef, { items: newItems, updatedAt: serverTimestamp() });
      if (verdict === 'approve') {
        tx.set(approvedRef, { ...next, batchId: batch.id, approvedAt: serverTimestamp() });
      } else {
        tx.delete(approvedRef);
      }
      return newItems;
    });
    batch.items = updated;
    const label = { approve: 'Approved', reject: 'Rejected', later: 'Saved for later' }[verdict] || (verdict === null ? 'Cleared' : 'Saved');
    toast(label, verdict === 'approve' ? 'good' : verdict === 'reject' ? 'bad' : 'info');
    const scrollY = window.scrollY;
    ctx.rerender();
    window.scrollTo({ top: scrollY });
    // In "To review", the decided card disappears; the next one slides up under the thumb.
  } catch (e) {
    card.classList.remove('saving');
    for (const b of card.querySelectorAll('.act')) b.disabled = false;
    ctx.reportError(e);
  }
}
