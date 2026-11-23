// Raters tab: who is rating, how much they are trusted, plus invite management.
import { doc, setDoc, updateDoc, serverTimestamp, Timestamp } from 'firebase/firestore';
import { h, icon, relTime, toDate, toast, initials, newInviteCode } from './util.js';
import { trustOf } from './stats.js';

let sortKey = 'trust';

export function renderRaters(view, ctx) {
  const { raters, ratings, feedback, invites } = ctx.data;
  const ratingCount = {}, ideaCount = {};
  for (const r of ratings) {
    ratingCount[r.uid] = (ratingCount[r.uid] || 0) + 1;
    if (r.idea && r.idea.trim()) ideaCount[r.uid] = (ideaCount[r.uid] || 0) + 1;
  }
  for (const f of feedback) ideaCount[f.uid] = (ideaCount[f.uid] || 0) + 1;

  const rows = raters.map((r) => ({
    ...r,
    trustV: trustOf(r),
    nRatings: ratingCount[r.uid] || 0,
    nIdeas: ideaCount[r.uid] || 0,
    seen: toDate(r.lastSeenAt),
  }));
  const cmp = {
    trust: (a, b) => b.trustV - a.trustV,
    ratings: (a, b) => b.nRatings - a.nRatings,
    seen: (a, b) => (b.seen?.getTime() || 0) - (a.seen?.getTime() || 0),
    name: (a, b) => String(a.nickname).localeCompare(String(b.nickname)),
  }[sortKey];
  rows.sort((a, b) => cmp(a, b) || String(a.nickname).localeCompare(String(b.nickname)));
  const activeWeek = rows.filter((r) => r.seen && Date.now() - r.seen.getTime() < 7 * 864e5).length;

  const sortBtn = (k, label) => h('button', {
    class: `chip${sortKey === k ? ' on' : ''}`, 'data-sort': k, 'aria-pressed': String(sortKey === k),
    onclick: () => { sortKey = k; ctx.rerender(); },
  }, label);

  view.append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('p', { class: 'eyebrow' }, `${rows.length} raters · ${activeWeek} active this week`),
        h('h1', null, 'Raters')),
      h('div', { class: 'sorter', role: 'toolbar', 'aria-label': 'Sort raters' },
        h('span', { class: 'muted small' }, 'Sort'),
        sortBtn('trust', 'Trust'), sortBtn('ratings', 'Ratings'), sortBtn('seen', 'Last seen'), sortBtn('name', 'Name'))),
  );

  const table = h('div', { class: 'rtable', role: 'table', 'aria-label': 'Raters' },
    h('div', { class: 'rrow rhead', role: 'row' },
      ['Rater', 'Trust', 'Ratings', 'Ideas', 'Last seen'].map((t) => h('span', { role: 'columnheader' }, t))));
  for (const r of rows) {
    const badge = r.badge || 'bronze';
    table.appendChild(h('div', { class: 'rrow', role: 'row', 'data-rater': r.uid },
      h('span', { class: 'rwho', role: 'cell' },
        h('span', { class: `pav pav-${badge}` }, initials(r.nickname)),
        h('span', { class: 'rname' }, h('b', null, r.nickname || '(no name)'),
          h('span', { class: `badge-txt badge-${badge}` }, badge))),
      h('span', { class: 'rtrust', role: 'cell' },
        h('b', null, String(r.trustV)),
        h('span', { class: 'tbar' }, h('span', { class: 'tbar-fill', style: { width: `${r.trustV}%` } }))),
      h('span', { class: 'rnum', role: 'cell' }, h('b', null, String(r.nRatings)), h('span', { class: 'mob-l' }, ' ratings')),
      h('span', { class: 'rnum', role: 'cell' }, h('b', null, String(r.nIdeas)), h('span', { class: 'mob-l' }, ' ideas')),
      h('span', { class: 'rseen muted', role: 'cell' }, relTime(r.seen))));
  }
  if (!rows.length) table.appendChild(h('p', { class: 'muted pad' }, 'No raters yet. Create an invite below and share the code.'));
  view.appendChild(table);

  view.appendChild(invitesPanel(ctx, invites));
}

function invitesPanel(ctx, invites) {
  const label = h('input', { id: 'invite-label', class: 'input', type: 'text', maxlength: 80, placeholder: 'Label, e.g. “Reddit group”', 'aria-label': 'Invite label', autocomplete: 'off' });
  const createBtn = h('button', { class: 'btn btn-lime', id: 'invite-create', type: 'submit' }, icon('plus'), 'Create invite');
  const form = h('form', {
    class: 'invite-form',
    onsubmit: async (e) => {
      e.preventDefault();
      const text = label.value.trim();
      if (!text) { label.focus(); toast('Give the invite a label', 'bad'); return; }
      createBtn.disabled = true;
      const code = newInviteCode();
      try {
        await setDoc(doc(ctx.db, 'invites', code), { active: true, label: text.slice(0, 80), createdAt: serverTimestamp() });
        ctx.data.invites.push({ code, active: true, label: text, createdAt: Timestamp.now(), fresh: true });
        toast(`Invite ${code} created`, 'good');
        ctx.rerender();
      } catch (err) {
        createBtn.disabled = false;
        ctx.reportError(err);
      }
    },
  }, label, createBtn);

  const usedBy = {};
  for (const r of ctx.data.raters) usedBy[r.inviteCode] = (usedBy[r.inviteCode] || 0) + 1;
  const sorted = [...invites].sort((a, b) => (b.active - a.active) || ((toDate(b.createdAt)?.getTime() || 0) - (toDate(a.createdAt)?.getTime() || 0)));
  const list = h('ul', { class: 'invites', id: 'invite-list' }, sorted.map((inv) => {
    const link = new URL(`./?invite=${encodeURIComponent(inv.code)}`, location.href).href;
    return h('li', { class: `invite${inv.active ? '' : ' off'}${inv.fresh ? ' fresh' : ''}`, 'data-code': inv.code },
      h('div', { class: 'inv-main' },
        h('code', { class: 'inv-code' }, inv.code),
        h('span', { class: 'inv-label' }, inv.label || ''),
        h('span', { class: 'muted small' }, `${usedBy[inv.code] || 0} joined · ${relTime(toDate(inv.createdAt))}${inv.active ? '' : ' · inactive'}`)),
      h('div', { class: 'inv-actions' },
        inv.active ? h('button', { class: 'btn btn-ghost btn-sm', 'aria-label': `Copy link for ${inv.code}`, onclick: () => copy(link) }, icon('copy'), 'Link') : null,
        h('button', {
          class: `btn btn-sm ${inv.active ? 'btn-ghost danger' : 'btn-ghost'}`, 'data-toggle': inv.code,
          onclick: async (e) => {
            const b = e.currentTarget; b.disabled = true;
            try {
              await updateDoc(doc(ctx.db, 'invites', inv.code), { active: !inv.active });
              inv.active = !inv.active;
              toast(inv.active ? `${inv.code} reactivated` : `${inv.code} deactivated`);
              ctx.rerender();
            } catch (err) { b.disabled = false; ctx.reportError(err); }
          },
        }, inv.active ? 'Deactivate' : 'Reactivate')));
  }));

  return h('section', { class: 'card invites-card' },
    h('h2', null, 'Invites'),
    h('p', { class: 'muted small' }, 'Raters join with an invite code. Deactivating a code stops new sign-ups with it; people who already joined keep rating.'),
    form,
    invites.length ? list : h('p', { class: 'muted small' }, 'No invites yet.'));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Link copied'); } catch { toast(text); }
}
