import { h, ICON, reducedMotion, fmtTime } from './ui.js';

const TAP_MS = 320;
const TAP_PX = 9;

/** Shared playback preference: once the rater turns sound on, later cards try to play unmuted. */
export const playback = { soundOn: false };

/**
 * One 9:16 video card. Owns its <video>, watch stats, drag physics and fly-out.
 * `stage` is the stack element; `onSwipe(dir, via)` fires when a swipe commits.
 */
export class Card {
  constructor(video, { onSwipe, onDropOff, onPlayState } = {}) {
    this.v = video;
    this.onSwipe = onSwipe;
    this.onDropOff = onDropOff;
    this.onPlayState = onPlayState;
    this.watchedSec = 0;
    this.dropOffSec = null;
    this.retried = false;
    this.failed = false;
    this.active = false;
    this.locked = false;
    this.offX = 0;
    this.raf = 0;
    this.build();
  }

  build() {
    const { v } = this;
    this.video = h('video', {
      class: 'card-video',
      playsinline: true,
      'webkit-playsinline': true,
      preload: 'metadata',
      poster: v.posterUrl,
      muted: true,
      disablepictureinpicture: true,
      disableremoteplayback: true,
      'x-webkit-airplay': 'deny',
      'aria-label': `Video: ${v.title || v.id}`,
    });
    this.video.muted = true;
    this.video.defaultMuted = true;
    this.video.src = v.videoUrl;

    this.bar = h('i');
    this.stampGood = h('div', { class: 'stamp stamp-good', 'aria-hidden': 'true' }, 'GOOD');
    this.stampBad = h('div', { class: 'stamp stamp-bad', 'aria-hidden': 'true' }, 'BAD');
    this.center = h('div', { class: 'card-center', 'aria-hidden': 'true', html: ICON.play });
    this.soundPill = h('div', { class: 'sound-pill', 'aria-hidden': 'true', html: `${ICON.muted}<span>Tap for sound</span>` });
    this.dropBtn = h('button', {
      type: 'button', class: 'drop-btn', 'data-testid': 'dropoff',
      'aria-label': "I'd scroll away here: mark this moment",
      onclick: (e) => { e.stopPropagation(); this.markDropOff(); },
    });
    this.renderDropBtn();
    this.errorBox = h('div', { class: 'card-error', hidden: true },
      h('p', {}, 'This video won’t play here.'),
      h('a', { href: v.videoUrl, target: '_blank', rel: 'noopener', class: 'btn btn-ghost btn-sm', html: `Open video ${ICON.ext}` }));

    const seriesChip = v.series ? `${v.series}${v.ep != null ? ` · Ep ${v.ep}` : ''}` : null;
    const meta = [v.catLabel && v.catLabel !== v.series ? v.catLabel : null, seriesChip].filter(Boolean);
    this.el = h('article', { class: 'card', 'data-video-id': v.id, 'aria-roledescription': 'video card' },
      this.video,
      h('div', { class: 'card-shade', 'aria-hidden': 'true' }),
      h('div', { class: 'card-progress', role: 'progressbar', 'aria-label': 'Playback progress' }, this.bar),
      this.stampGood, this.stampBad, this.center, this.soundPill, this.errorBox,
      h('div', { class: 'card-foot' },
        h('div', { class: 'card-meta' }, meta.map((m) => h('span', {}, m))),
        this.dropBtn));

    const vid = this.video;
    vid.addEventListener('loadedmetadata', () => this.el.classList.add('has-meta'));
    vid.addEventListener('timeupdate', () => this.track());
    vid.addEventListener('play', () => this.syncPlayUi());
    vid.addEventListener('pause', () => this.syncPlayUi());
    vid.addEventListener('playing', () => { this.el.classList.add('started'); this.tick(); });
    vid.addEventListener('ended', () => {
      this.watchedSec = this.duration;
      this.drawBar(1);
      if (this.active && !this.locked) { vid.currentTime = 0; this.play(); }
    });
    vid.addEventListener('error', () => this.handleError());
  }

  get duration() {
    const d = this.video.duration;
    return Number.isFinite(d) && d > 0 ? d : Number(this.v.dur) || 0;
  }
  get watchedPct() {
    const d = this.duration;
    return d > 0 ? Math.min(1, this.watchedSec / d) : 0;
  }

  track() {
    const t = this.video.currentTime || 0;
    if (t > this.watchedSec) this.watchedSec = t;
    const d = this.duration;
    if (d) this.drawBar(t / d);
  }
  drawBar(f) { this.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, f))})`; }
  tick() {
    cancelAnimationFrame(this.raf);
    const loop = () => {
      this.track();
      if (!this.video.paused) this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  handleError() {
    if (this.failed) return;
    if (!this.retried) {
      this.retried = true;
      const sep = this.v.videoUrl.includes('?') ? '&' : '?';
      this.video.src = `${this.v.videoUrl}${sep}cb=${Date.now()}`;
      this.video.load();
      if (this.active) this.play();
      return;
    }
    this.failed = true;
    this.errorBox.hidden = false;
    this.el.classList.add('failed');
    this.syncPlayUi();
  }

  syncPlayUi() {
    const paused = this.video.paused;
    this.el.classList.toggle('paused', paused && this.el.classList.contains('started'));
    this.el.classList.toggle('muted', this.video.muted);
    this.center.innerHTML = paused ? ICON.play : ICON.pause;
    this.onPlayState?.(this);
  }

  /** Try to play; with sound if the rater has enabled it, else muted. */
  async play() {
    if (this.failed) return;
    const vid = this.video;
    vid.muted = !playback.soundOn;
    try {
      await vid.play();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (!vid.muted) {
        vid.muted = true;
        try { await vid.play(); } catch { /* blocked; tap starts it */ }
      }
    }
    this.syncPlayUi();
  }
  pause() { this.video.pause(); }

  /** Tap: first one turns sound on, later ones toggle play/pause. */
  tap() {
    if (this.failed) return;
    const vid = this.video;
    if (vid.muted) {
      playback.soundOn = true;
      vid.muted = false;
      if (vid.paused) this.play(); else this.syncPlayUi();
      this.pulse();
      return;
    }
    if (vid.paused) this.play(); else vid.pause();
    this.pulse();
  }
  toggleMute() {
    playback.soundOn = this.video.muted;
    this.video.muted = !this.video.muted;
    if (this.video.paused && !this.video.muted) this.play();
    this.syncPlayUi();
  }
  pulse() {
    this.center.classList.remove('pulse');
    void this.center.offsetWidth;
    this.center.classList.add('pulse');
  }

  markDropOff() {
    const t = this.video.currentTime || 0;
    const update = this.dropOffSec != null;
    this.dropOffSec = Math.round(t * 10) / 10;
    if (this.dropOffSec > this.watchedSec) this.watchedSec = this.dropOffSec;
    this.renderDropBtn();
    this.onDropOff?.(this, update);
  }
  renderDropBtn() {
    const marked = this.dropOffSec != null;
    this.dropBtn.classList.toggle('marked', marked);
    this.dropBtn.innerHTML = marked
      ? `${ICON.exit}<span>Scroll-away at ${fmtTime(this.dropOffSec)}</span>`
      : `${ICON.exit}<span>I’d scroll away here</span>`;
  }

  /** Make this the top card: wire input and start playback. */
  activate() {
    if (this.active) return;
    this.active = true;
    this.el.classList.add('is-top');
    this.el.addEventListener('pointerdown', this.onDown);
    this.play();
  }

  /** Demote to the card underneath (undo puts another card on top). */
  deactivate() {
    this.active = false;
    this.pause();
    this.el.classList.remove('is-top');
    this.el.removeEventListener('pointerdown', this.onDown);
  }

  // ---- drag physics --------------------------------------------------------
  onDown = (e) => {
    if (this.locked || e.button > 0) return;
    if (e.target.closest('button, a')) return;
    this.drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, dy: 0, moving: false, samples: [[performance.now(), e.clientX]] };
    this.el.setPointerCapture?.(e.pointerId);
    this.el.addEventListener('pointermove', this.onMove);
    this.el.addEventListener('pointerup', this.onUp);
    this.el.addEventListener('pointercancel', this.onUp);
  };

  onMove = (e) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    d.dx = e.clientX - d.x0;
    d.dy = e.clientY - d.y0;
    if (!d.moving && Math.hypot(d.dx, d.dy) > TAP_PX) {
      d.moving = true;
      this.el.classList.add('dragging');
    }
    const now = performance.now();
    d.samples.push([now, e.clientX]);
    while (d.samples.length > 2 && now - d.samples[0][0] > 100) d.samples.shift();
    if (d.moving) this.applyDrag(d.dx, d.dy);
  };

  onUp = (e) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.id) return;
    this.el.removeEventListener('pointermove', this.onMove);
    this.el.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('pointercancel', this.onUp);
    this.drag = null;
    this.el.classList.remove('dragging');
    const dt = performance.now() - d.t0;
    if (!d.moving) {
      if (e.type === 'pointerup' && dt < TAP_MS * 2) this.tap();
      return;
    }
    const [t0, x0] = d.samples[0];
    const [t1, x1] = d.samples[d.samples.length - 1];
    const vx = t1 > t0 ? (x1 - x0) / (t1 - t0) : 0; // px/ms
    const threshold = this.threshold();
    const dir = d.dx > 0 ? 'good' : 'bad';
    const flung = Math.abs(vx) > 0.5 && Math.abs(d.dx) > 36 && Math.sign(vx) === Math.sign(d.dx);
    if (e.type === 'pointerup' && (Math.abs(d.dx) > threshold || flung)) {
      this.flyOut(dir, Math.abs(vx));
      this.onSwipe?.(dir, 'drag');
    } else {
      this.springBack();
    }
  };

  threshold() { return Math.min(130, (this.el.offsetWidth || 360) * 0.3); }

  applyDrag(dx, dy) {
    const rm = reducedMotion();
    const rot = rm ? 0 : Math.max(-16, Math.min(16, dx * 0.055));
    this.el.style.transform = `translate3d(${dx}px, ${rm ? 0 : dy * 0.18}px, 0) rotate(${rot}deg)`;
    const p = Math.min(1, Math.abs(dx) / this.threshold());
    this.stampGood.style.opacity = dx > 0 ? p : 0;
    this.stampBad.style.opacity = dx < 0 ? p : 0;
    this.el.dispatchEvent(new CustomEvent('cardprogress', { bubbles: true, detail: p }));
  }

  springBack() {
    this.el.classList.add('springing');
    this.el.style.transform = '';
    this.stampGood.style.opacity = 0;
    this.stampBad.style.opacity = 0;
    this.el.dispatchEvent(new CustomEvent('cardprogress', { bubbles: true, detail: 0 }));
    this.afterTransition(() => this.el.classList.remove('springing'));
  }

  /** Animate off-screen and park there (sheet decides submit vs. return). */
  flyOut(dir, speed = 0) {
    this.locked = true;
    this.pause();
    const sign = dir === 'good' ? 1 : -1;
    (dir === 'good' ? this.stampGood : this.stampBad).style.opacity = 1;
    (dir === 'good' ? this.stampBad : this.stampGood).style.opacity = 0;
    const rm = reducedMotion();
    const dist = window.innerWidth / 2 + (this.el.offsetWidth || 400) * 1.1;
    const ms = rm ? 160 : Math.round(Math.max(200, Math.min(340, 340 - speed * 100)));
    this.el.style.setProperty('--fly-ms', `${ms}ms`);
    this.el.classList.add('flying');
    if (rm) this.el.classList.add('faded');
    else this.el.style.transform = `translate3d(${sign * dist}px, -2%, 0) rotate(${sign * 20}deg)`;
    this.offDir = dir;
    this.el.dispatchEvent(new CustomEvent('cardprogress', { bubbles: true, detail: 1 }));
  }

  /** Bring a parked card back to centre (sheet cancelled, or undo). */
  returnToCentre({ from } = {}) {
    this.el.classList.remove('flying', 'faded');
    if (from && !reducedMotion()) {
      const sign = from === 'good' ? 1 : -1;
      this.el.classList.remove('springing');
      this.el.style.transform = `translate3d(${sign * (window.innerWidth / 2 + this.el.offsetWidth)}px, -2%, 0) rotate(${sign * 20}deg)`;
      void this.el.offsetWidth;
    }
    this.el.classList.add('springing');
    this.el.style.transform = '';
    this.stampGood.style.opacity = 0;
    this.stampBad.style.opacity = 0;
    this.el.dispatchEvent(new CustomEvent('cardprogress', { bubbles: true, detail: 0 }));
    this.afterTransition(() => this.el.classList.remove('springing'));
    this.locked = false;
  }

  afterTransition(fn) {
    let done = false;
    const finish = () => { if (done) return; done = true; this.el.removeEventListener('transitionend', onEnd); fn(); };
    const onEnd = (e) => { if (e.target === this.el && e.propertyName === 'transform') finish(); };
    this.el.addEventListener('transitionend', onEnd);
    setTimeout(finish, 700);
  }

  stats() {
    const d = this.duration;
    const r1 = (n) => Math.round(n * 10) / 10;
    const known = Number.isFinite(d) && d > 0;
    const seen = Number.isFinite(this.watchedSec) ? Math.max(0, this.watchedSec) : 0;
    const watchedSec = r1(known ? Math.min(seen, d) : seen);
    const out = { watchedSec, dropOffSec: Number.isFinite(this.dropOffSec) ? this.dropOffSec : null };
    // Duration unknown (metadata never loaded, no manifest dur): omit the optional fields.
    if (known) {
      out.durationSec = r1(d);
      out.watchedPct = Math.round(Math.min(1, watchedSec / d) * 1000) / 1000;
    }
    return out;
  }

  destroy() {
    this.failed = true; // silence the error event that clearing src can raise
    cancelAnimationFrame(this.raf);
    this.el.removeEventListener('pointerdown', this.onDown);
    const vid = this.video;
    vid.pause();
    vid.removeAttribute('src');
    try { vid.load(); } catch { /* noop */ }
    this.el.remove();
  }
}
