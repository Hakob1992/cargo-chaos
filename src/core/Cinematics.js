import { gsap } from 'gsap';
import * as THREE from 'three';

// Cinematics — GSAP-driven immersive sequences that the Game hands control to:
//
//   runStart()    a camera orbit-sweep around the loaded truck, then a
//                 3·2·1·GO! countdown that hands control back to the player.
//   celebrate()   a confetti + coin burst over the result card on a clean run.
//
// While a sequence owns the camera, Game sets `game.cinematic = true` so the
// fixed sim + follow-camera stand down (see Game.#frame / Game.#updateCamera).
export class Cinematics {
  constructor(game) {
    this.game = game;
    this.root = document.getElementById('ui-root');
    this._tl = null;
    this._skip = null;
    window.__gsap = gsap; // quick live tuning / debugging from the console
  }

  // Orbit the camera around the just-loaded truck, then count down to GO.
  // `onGo` is called the instant control returns to the player.
  runStart(onGo) {
    const g = this.game;
    if (!g.truck) { onGo && onGo(); return; }
    g.cinematic = true;

    const cam = g.camera;
    const focus = g.truck.group.position.clone();
    focus.y += 0.8;
    // Sweep from a low three-quarter front angle around to behind the truck,
    // pulling in and widening the lens a touch as it settles into gameplay.
    const p = { angle: Math.PI * 0.62, radius: 15, height: 6.5, fov: 52 };
    const place = () => {
      cam.position.set(
        focus.x + Math.sin(p.angle) * p.radius,
        focus.y + p.height,
        focus.z + Math.cos(p.angle) * p.radius,
      );
      cam.lookAt(focus.x, focus.y, focus.z);
      if (Math.abs(cam.fov - p.fov) > 0.01) { cam.fov = p.fov; cam.updateProjectionMatrix(); }
    };
    place();

    const tl = gsap.timeline({
      onUpdate: place,
      onComplete: () => this.#countdown(onGo),
    });
    tl.to(p, { angle: Math.PI, radius: 11, height: 4.8, fov: 60, duration: 2.0, ease: 'power3.inOut' });
    this._tl = tl;

    // Let the player skip the flourish with any key / click / tap.
    this.#armSkip(() => {
      tl.progress(1); // jump to the end → triggers onComplete → countdown
    });
  }

  #countdown(onGo) {
    const g = this.game;
    const el = document.createElement('div');
    el.className = 'countdown';
    this.root.appendChild(el);

    const finish = () => {
      this.#disarmSkip();
      gsap.killTweensOf(el);
      el.remove();
      g.cinematic = false;
      this._tl = null;
      onGo && onGo();
    };

    const steps = ['3', '2', '1', 'GO!'];
    const tl = gsap.timeline({ onComplete: finish });
    steps.forEach((s, i) => {
      const isGo = s === 'GO!';
      tl.call(() => {
        el.textContent = s;
        el.classList.toggle('go', isGo);
        g.audio?.playStar?.(isGo ? 4 : i);
      });
      tl.fromTo(el,
        { scale: 0.3, opacity: 0, rotate: isGo ? -8 : 0 },
        { scale: 1, opacity: 1, rotate: 0, duration: 0.2, ease: 'back.out(3)' });
      tl.to(el, { scale: isGo ? 1.8 : 1.35, opacity: 0, duration: isGo ? 0.45 : 0.42, ease: 'power1.in' }, '+=0.32');
    });
    this._tl = tl;
    // A skip during the countdown jumps straight to GO.
    this.#armSkip(() => tl.progress(1));
  }

  // Confetti + coin burst over the result card. Purely decorative DOM bits in
  // ui-root; they clean themselves up. Called on a successful delivery.
  celebrate({ big = false } = {}) {
    const layer = document.createElement('div');
    layer.className = 'celebrate-layer';
    this.root.appendChild(layer);

    const COLORS = ['#ffd34e', '#ff7a59', '#5ed0f0', '#8cdf5a', '#f06ad0', '#ffffff'];
    const n = big ? 90 : 54;
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight * 0.42;

    for (let i = 0; i < n; i++) {
      const bit = document.createElement('div');
      const coin = Math.random() < 0.22;
      bit.className = 'confetti' + (coin ? ' coin' : '');
      if (!coin) bit.style.background = COLORS[(Math.random() * COLORS.length) | 0];
      layer.appendChild(bit);

      const ang = Math.random() * Math.PI * 2;
      const spread = (big ? 540 : 420) * (0.4 + Math.random() * 0.6);
      const dx = Math.cos(ang) * spread;
      const dy = Math.sin(ang) * spread - (140 + Math.random() * 160); // bias upward

      gsap.set(bit, { x: cx, y: cy, opacity: 1, rotate: Math.random() * 360 });
      gsap.to(bit, {
        x: cx + dx,
        y: cy + dy + 520,                // arc up, then gravity down past the bottom
        rotate: `+=${(Math.random() * 720 - 360)}`,
        duration: 1.5 + Math.random() * 0.9,
        ease: 'power1.out',
      });
      gsap.to(bit, { opacity: 0, duration: 0.5, delay: 1.3 + Math.random() * 0.7 });
    }
    gsap.delayedCall(big ? 2.8 : 2.4, () => layer.remove());
  }

  // ---- skip plumbing -------------------------------------------------------

  #armSkip(fn) {
    this.#disarmSkip();
    this._skip = (e) => {
      if (e.type === 'keydown' && (e.key === 'Tab' || e.key === 'F5' || e.metaKey || e.ctrlKey)) return;
      fn();
    };
    window.addEventListener('keydown', this._skip);
    window.addEventListener('pointerdown', this._skip);
  }

  #disarmSkip() {
    if (!this._skip) return;
    window.removeEventListener('keydown', this._skip);
    window.removeEventListener('pointerdown', this._skip);
    this._skip = null;
  }

  // Abort any running sequence (e.g. the player bailed to the garage).
  cancel() {
    this.#disarmSkip();
    if (this._tl) { this._tl.kill(); this._tl = null; }
    this.game.cinematic = false;
  }
}
