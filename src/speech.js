const Ctor = typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition);

/** False when the API is missing or the page (e.g. a sandboxed iframe) may not use the mic. */
export const speechSupported = () => {
  if (!Ctor) return false;
  try {
    const policy = document.permissionsPolicy || document.featurePolicy;
    if (policy?.allowsFeature && !policy.allowsFeature('microphone')) return false;
  } catch { /* policy API unavailable */ }
  return true;
};

const ERRORS = {
  'not-allowed': 'Mic access is blocked. You can type instead, or allow the microphone in your browser settings.',
  'service-not-allowed': 'Voice typing isn’t available in this browser. Typing works just as well.',
  'audio-capture': 'No microphone found. You can type your idea instead.',
  network: 'Voice typing needs an internet connection. You can type instead.',
  'no-speech': 'Didn’t catch that. Tap the mic and try again.',
};

/**
 * Continuous dictation into a textarea. Final phrases are appended to the
 * textarea; interim words show live after them until they settle.
 */
export function createDictation(textarea, { onState, onNote, onVoice } = {}) {
  if (!Ctor) return null;
  let rec = null;
  let base = '';
  let finals = '';
  let listening = false;

  const join = (a, b) => (!a ? b : !b ? a : /\s$/.test(a) ? a + b : `${a} ${b}`);
  const render = (interim) => {
    textarea.value = join(join(base, finals), interim).slice(0, textarea.maxLength > 0 ? textarea.maxLength : 2000);
    textarea.dispatchEvent(new CustomEvent('dictation'));
  };

  function start() {
    if (listening) return;
    rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = navigator.language || 'en-US';
    base = textarea.value.trimEnd();
    finals = '';
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const t = r[0].transcript.trim();
        if (!t) continue;
        if (r.isFinal) { finals = join(finals, t); onVoice?.(); } else interim = join(interim, t);
      }
      render(interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'aborted') return;
      onNote?.(ERRORS[e.error] || 'Voice typing stopped. You can keep typing.', e.error);
    };
    rec.onend = () => { render(''); listening = false; rec = null; onState?.(false); };
    try {
      rec.start();
      listening = true;
      onState?.(true);
    } catch {
      onNote?.('Voice typing isn’t available here. You can type instead.', 'service-not-allowed');
    }
  }

  function stop() { if (rec) { try { rec.stop(); } catch { /* already stopped */ } } }
  function abort() { if (rec) { try { rec.abort(); } catch { /* noop */ } } }

  /** User typed while listening: treat their text as the new base. */
  function resync() { if (listening) { base = textarea.value; finals = ''; } }

  return { start, stop, abort, resync, toggle: () => (listening ? stop() : start()), get listening() { return listening; } };
}
