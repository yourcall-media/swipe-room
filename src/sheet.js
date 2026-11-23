import { h, $, ICON, vibrate } from './ui.js';
import { REASONS, LIMITS } from './config.js';
import { createDictation, speechSupported } from './speech.js';

const IDEA_PROMPT = 'What would make this more addictive, interesting or entertaining?';

let current = null;

export const sheetOpen = () => !!current;

function ideaField({ id, label, placeholder, optional = true }) {
  const ta = h('textarea', {
    id, class: 'idea-input', rows: 3, maxlength: LIMITS.idea, placeholder,
    'data-testid': 'idea', autocomplete: 'off', autocapitalize: 'sentences', spellcheck: 'true',
  });
  const note = h('p', { class: 'field-note', role: 'status', 'aria-live': 'polite', hidden: true });
  const via = { typed: false, voice: false };
  let dict = null;
  let mic = null;
  if (speechSupported()) {
    mic = h('button', {
      type: 'button', class: 'mic-btn', 'data-testid': 'mic', 'aria-pressed': 'false',
      'aria-label': 'Speak your idea', html: `${ICON.mic}<span class="mic-ring" aria-hidden="true"></span>`,
    });
    dict = createDictation(ta, {
      onState: (on) => {
        mic.setAttribute('aria-pressed', String(on));
        mic.setAttribute('aria-label', on ? 'Stop voice typing' : 'Speak your idea');
        ta.closest('.idea-box').classList.toggle('listening', on);
        if (on) { note.hidden = false; note.className = 'field-note live'; note.textContent = 'Listening… speak freely, tap the mic to stop.'; } else if (note.classList.contains('live')) note.hidden = true;
      },
      onVoice: () => { via.voice = true; },
      onNote: (msg, code) => {
        note.hidden = false; note.className = 'field-note warn'; note.textContent = msg;
        // Voice can't work here at all (blocked mic / no service): hide the button, keep typing.
        if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') mic.hidden = true;
      },
    });
    mic.addEventListener('click', () => { vibrate(8); dict.toggle(); });
  }
  ta.addEventListener('input', () => { via.typed = true; dict?.resync(); });
  const box = h('div', { class: 'idea-box' }, ta, mic);
  const wrap = h('div', { class: 'idea' },
    h('label', { for: id, class: 'idea-label' }, label, optional ? h('span', { class: 'opt' }, 'Optional') : null),
    box, note);
  return {
    el: wrap, ta,
    value: () => ta.value.trim().slice(0, LIMITS.idea),
    via: () => {
      if (!ta.value.trim()) return null;
      if (via.voice && via.typed) return 'mixed';
      return via.voice ? 'voice' : 'text';
    },
    stop: () => dict?.abort(),
  };
}

function mount(content, { label, onCancel, tone }) {
  const sheet = $('#sheet');
  const scrim = $('#scrim');
  const prevFocus = document.activeElement;
  sheet.replaceChildren(h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), ...content);
  sheet.dataset.tone = tone || '';
  sheet.setAttribute('aria-label', label);
  sheet.hidden = false;
  scrim.hidden = false;
  document.body.classList.add('sheet-up');
  void sheet.offsetWidth;
  sheet.classList.add('open');
  scrim.classList.add('open');
  sheet.scrollTop = 0;

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    if (e.key === 'Tab') {
      const f = [...sheet.querySelectorAll('button:not([disabled]), textarea, input, a[href]')].filter((x) => !x.closest('[hidden]'));
      if (!f.length) return;
      const first = f[0]; const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);

  return function close() {
    document.removeEventListener('keydown', onKey, true);
    sheet.classList.remove('open');
    scrim.classList.remove('open');
    document.body.classList.remove('sheet-up');
    const done = () => { if (!sheet.classList.contains('open')) { sheet.hidden = true; scrim.hidden = true; } };
    sheet.addEventListener('transitionend', done, { once: true });
    setTimeout(done, 450);
    if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true });
  };
}

/** Reasons + idea sheet shown after a swipe. */
export function openReasonSheet(dir, { onSubmit, onCancel }) {
  if (current) current.close();
  const good = dir === 'good';
  const selected = new Set();
  const chips = REASONS[dir].map(([key, label], i) =>
    h('button', {
      type: 'button', class: 'chip', 'aria-pressed': 'false', 'data-reason': key,
      onclick: (e) => toggle(e.currentTarget, key),
    }, h('kbd', { class: 'chip-key', 'aria-hidden': 'true' }, String(i + 1)), label));
  const otherChip = h('button', {
    type: 'button', class: 'chip chip-other', 'aria-pressed': 'false', 'data-reason': 'other',
    onclick: () => {
      const on = otherChip.getAttribute('aria-pressed') !== 'true';
      otherChip.setAttribute('aria-pressed', String(on));
      otherWrap.hidden = !on;
      if (on) otherInput.focus(); else otherInput.value = '';
      validate();
    },
  }, h('span', { class: 'chip-plus', html: ICON.plus }), 'Other');
  const otherInput = h('input', {
    type: 'text', class: 'other-input', maxlength: LIMITS.other, placeholder: 'Tell us in a few words',
    'aria-label': 'Other reason', 'data-testid': 'other', autocomplete: 'off', oninput: () => validate(),
  });
  const otherWrap = h('div', { class: 'other-wrap', hidden: true }, otherInput);
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true }, 'Pick at least one reason, or choose Other and add a few words.');
  const idea = ideaField({ id: 'idea-input', label: IDEA_PROMPT, placeholder: 'Type or tap the mic…' });

  const submitBtn = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'submit', 'aria-disabled': 'true' }, 'Submit');
  const skipBtn = h('button', { type: 'button', class: 'btn btn-quiet', 'data-testid': 'skip-idea', 'aria-disabled': 'true' }, 'Skip idea');

  function toggle(btn, key) {
    vibrate(6);
    if (selected.has(key)) selected.delete(key); else selected.add(key);
    btn.setAttribute('aria-pressed', String(selected.has(key)));
    validate();
  }
  function valid() { return selected.size > 0 || otherInput.value.trim().length > 0; }
  function validate() {
    const ok = valid();
    submitBtn.setAttribute('aria-disabled', String(!ok));
    skipBtn.setAttribute('aria-disabled', String(!ok));
    if (ok) err.hidden = true;
    return ok;
  }
  function finish(withIdea) {
    if (!valid()) {
      err.hidden = false;
      err.classList.remove('shake'); void err.offsetWidth; err.classList.add('shake');
      vibrate([10, 40, 10]);
      return;
    }
    idea.stop();
    const payload = {
      reasons: REASONS[dir].map(([k]) => k).filter((k) => selected.has(k)),
      other: otherInput.value.trim().slice(0, LIMITS.other),
      idea: withIdea ? idea.value() : '',
      ideaVia: withIdea ? idea.via() : null,
    };
    if (!payload.idea) payload.ideaVia = null;
    close();
    onSubmit(payload);
  }
  submitBtn.addEventListener('click', () => finish(true));
  skipBtn.addEventListener('click', () => finish(false));

  const cancel = () => { idea.stop(); close(); onCancel(); };
  const back = h('button', { type: 'button', class: 'icon-btn sheet-back', 'aria-label': 'Back to the video', 'data-testid': 'sheet-back', html: ICON.back, onclick: cancel });

  const onDigit = (e) => {
    if (e.target.matches('input, textarea')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 5) { e.preventDefault(); chips[n - 1].click(); }
    if (e.key === 'Enter' && (!e.target.matches('button') || e.target.classList.contains('chip'))) { e.preventDefault(); finish(true); }
  };
  document.addEventListener('keydown', onDigit);

  const verdict = h('span', { class: `verdict verdict-${dir}`, html: good ? ICON.heart : ICON.x });
  const closeSheet = mount([
    h('header', { class: 'sheet-head' }, back,
      h('div', {},
        h('h2', { id: 'sheet-title' }, verdict, good ? 'Good one. What worked?' : 'Not for you. What lost you?'),
        h('p', { class: 'sheet-sub' }, 'Pick all that apply'))),
    h('div', { class: 'chips', role: 'group', 'aria-label': 'Reasons' }, chips, otherChip),
    otherWrap, err, idea.el,
    h('div', { class: 'sheet-actions' }, skipBtn, submitBtn),
  ], { label: good ? 'Why it was good' : 'Why it was bad', onCancel: cancel, tone: dir });

  function close() {
    document.removeEventListener('keydown', onDigit);
    closeSheet();
    current = null;
  }
  current = { close: cancel };
  if (matchMedia('(hover: hover) and (pointer: fine)').matches) chips[0].focus({ preventScroll: true });
}

/** General idea, not tied to a video. */
export function openFeedbackSheet({ onSubmit, onCancel = () => {} }) {
  if (current) current.close();
  const idea = ideaField({ id: 'feedback-input', label: 'Any idea for the channel: topics, formats, series, anything.', placeholder: 'Type or tap the mic…', optional: false });
  const err = h('p', { class: 'form-error', role: 'alert', hidden: true }, 'Write or say something first.');
  const send = h('button', { type: 'button', class: 'btn btn-primary', 'data-testid': 'feedback-send' }, 'Send idea');
  const cancel = () => { idea.stop(); close(); onCancel(); };
  send.addEventListener('click', () => {
    const text = idea.value();
    if (!text) { err.hidden = false; return; }
    idea.stop();
    const via = idea.via();
    close();
    onSubmit({ text, via });
  });
  const closeSheet = mount([
    h('header', { class: 'sheet-head' },
      h('button', { type: 'button', class: 'icon-btn sheet-back', 'aria-label': 'Close', html: ICON.close, onclick: cancel }),
      h('div', {}, h('h2', { id: 'sheet-title' }, h('span', { class: 'verdict verdict-idea', html: ICON.bulb }), 'Got an idea?'),
        h('p', { class: 'sheet-sub' }, 'Goes straight to the creator'))),
    idea.el, err,
    h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn btn-quiet', onclick: cancel }, 'Cancel'), send),
  ], { label: 'Share a general idea', onCancel: cancel, tone: 'idea' });
  function close() { closeSheet(); current = null; }
  current = { close: cancel };
  setTimeout(() => idea.ta.focus({ preventScroll: true }), 60);
}

/** Simple informational sheet. */
export function openInfoSheet(title, nodes) {
  if (current) current.close();
  const cancel = () => { closeSheet(); current = null; };
  const closeSheet = mount([
    h('header', { class: 'sheet-head' },
      h('button', { type: 'button', class: 'icon-btn sheet-back', 'aria-label': 'Close', html: ICON.close, onclick: cancel }),
      h('div', {}, h('h2', { id: 'sheet-title' }, title))),
    ...nodes,
    h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn btn-primary', onclick: cancel }, 'Got it')),
  ], { label: title, onCancel: cancel });
  current = { close: cancel };
}
