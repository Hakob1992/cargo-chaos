// Procedural audio for Cargo Chaos — no asset files, everything is synthesised
// with the Web Audio API (keeps the CrazyGames bundle tiny). One continuous
// engine voice modulated by speed/throttle, plus one-shot SFX: suspension
// squeak, cargo rattle, impact thud, and a delivery reward jingle.
//
// The AudioContext must be created/resumed from a user gesture, so call
// unlock() from a click handler (we do it when a delivery starts).
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.engineOn = false;
    // Remember the player's mute choice across sessions.
    this.muted = localStorage.getItem('cargo_chaos_muted') === '1';
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.6;
      this.master.connect(this.ctx.destination);
      // One second of white noise, reused for all noise-based SFX.
      const len = Math.floor(this.ctx.sampleRate);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.6;
    try { localStorage.setItem('cargo_chaos_muted', m ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  // ---- Engine (continuous) ----------------------------------------------

  startEngine() {
    if (!this.ctx || this.engineOn) return;
    const ctx = this.ctx;
    this.eOsc = ctx.createOscillator(); this.eOsc.type = 'sawtooth';
    this.eOsc2 = ctx.createOscillator(); this.eOsc2.type = 'square'; this.eOsc2.detune.value = -10;
    this.eFilter = ctx.createBiquadFilter(); this.eFilter.type = 'lowpass'; this.eFilter.frequency.value = 800;
    this.eGain = ctx.createGain(); this.eGain.gain.value = 0.0;
    this.eOsc.connect(this.eFilter);
    this.eOsc2.connect(this.eFilter);
    this.eFilter.connect(this.eGain);
    this.eGain.connect(this.master);
    this.eOsc.frequency.value = 55;
    this.eOsc2.frequency.value = 27;
    this.eOsc.start();
    this.eOsc2.start();
    this.engineOn = true;
  }

  setEngine(speedKmh, throttle) {
    if (!this.engineOn) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const thr = Math.abs(throttle || 0);
    const base = 52 + speedKmh * 2.3 + thr * 34;       // rises with revs
    this.eOsc.frequency.setTargetAtTime(base, t, 0.08);
    this.eOsc2.frequency.setTargetAtTime(base * 0.5, t, 0.08);
    this.eFilter.frequency.setTargetAtTime(480 + speedKmh * 11 + thr * 700, t, 0.1);
    const vol = 0.035 + thr * 0.05 + Math.min(0.05, speedKmh * 0.0009);
    this.eGain.gain.setTargetAtTime(vol, t, 0.1);
  }

  stopEngine() {
    if (!this.engineOn) return;
    const t = this.ctx.currentTime;
    this.eGain.gain.setTargetAtTime(0, t, 0.05);
    try { this.eOsc.stop(t + 0.2); this.eOsc2.stop(t + 0.2); } catch (e) { /* already stopped */ }
    this.engineOn = false;
  }

  // ---- One-shot SFX ------------------------------------------------------

  #noiseBurst(dur, filterType, freq, q, peak) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
    const filt = ctx.createBiquadFilter(); filt.type = filterType; filt.frequency.value = freq; filt.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  }

  // Heavy thud when the cargo slams the bed/ground.
  playImpact(intensity = 0.5) {
    const v = Math.min(0.6, 0.15 + intensity * 0.5);
    this.#noiseBurst(0.22, 'lowpass', 220, 1, v);
  }

  // Light rattle tick — cargo shifting around.
  playRattle(intensity = 0.3) {
    this.#noiseBurst(0.06, 'bandpass', 2600, 3, Math.min(0.18, 0.05 + intensity * 0.15));
  }

  // Suspension squeak — a quick descending sine chirp on compression.
  playSqueak(intensity = 0.3) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = 'sine';
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(1300 + intensity * 500, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.14);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.min(0.12, 0.04 + intensity * 0.1), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + 0.18);
  }

  // Cheerful arpeggio when a delivery is completed.
  playReward() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const notes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    notes.forEach((f, i) => {
      const t = ctx.currentTime + i * 0.11;
      const osc = ctx.createOscillator(); osc.type = 'triangle';
      const g = ctx.createGain();
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      osc.connect(g); g.connect(this.master);
      osc.start(t); osc.stop(t + 0.42);
    });
  }

  // Quick tone helper: one oscillator with a pitch ramp and a gain envelope.
  #blip(type, f0, f1, dur, peak, when = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + when;
    const osc = ctx.createOscillator(); osc.type = type;
    const g = ctx.createGain();
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(this.master);
    osc.start(t); osc.stop(t + dur + 0.03);
  }

  // ---- Tension (continuous while the cargo slides) ------------------------

  // A nervous tremolo string that fades in with how hard the cargo is skating
  // across the bed. Call every frame with 0..1; lazily builds its voice.
  setTension(amount) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    if (!this.tGain) {
      this.tOsc = ctx.createOscillator(); this.tOsc.type = 'sawtooth';
      this.tOsc.frequency.value = 660;
      this.tLfo = ctx.createOscillator(); this.tLfo.frequency.value = 9; // tremolo
      this.tLfoGain = ctx.createGain(); this.tLfoGain.gain.value = 140;
      this.tLfo.connect(this.tLfoGain); this.tLfoGain.connect(this.tOsc.frequency);
      this.tFilter = ctx.createBiquadFilter(); this.tFilter.type = 'bandpass';
      this.tFilter.frequency.value = 900; this.tFilter.Q.value = 4;
      this.tGain = ctx.createGain(); this.tGain.gain.value = 0;
      this.tOsc.connect(this.tFilter); this.tFilter.connect(this.tGain);
      this.tGain.connect(this.master);
      this.tOsc.start(); this.tLfo.start();
    }
    const a = Math.max(0, Math.min(1, amount));
    this.tGain.gain.setTargetAtTime(a * 0.055, t, 0.08);
    this.tOsc.frequency.setTargetAtTime(560 + a * 280, t, 0.1);
  }

  // ---- Cargo one-shots ------------------------------------------------------

  // Deep cartoon thunk when the cargo body slams down after air time.
  playThunk(intensity = 0.5) {
    this.#blip('sine', 150 + intensity * 60, 46, 0.22, Math.min(0.4, 0.16 + intensity * 0.3));
    this.#noiseBurst(0.12, 'lowpass', 300, 1, Math.min(0.25, 0.08 + intensity * 0.2));
  }

  // Dry snap when the cargo first cracks into the damaged stage.
  playCrack() {
    this.#noiseBurst(0.05, 'highpass', 2000, 2, 0.22);
    this.#blip('square', 320, 140, 0.09, 0.12);
  }

  // Comedic break flourish, flavoured by HOW the cargo died.
  playBreak(kind = 'crush') {
    if (!this.ctx) return;
    switch (kind) {
      case 'shatter': // bright glass tinkle raining down
        for (let i = 0; i < 7; i++) {
          const f = 1700 + Math.random() * 2300;
          this.#blip('sine', f, f * 0.6, 0.16 + Math.random() * 0.12, 0.07, i * 0.035);
        }
        this.#noiseBurst(0.2, 'highpass', 3200, 1.5, 0.2);
        break;
      case 'explode': // boom: sub drop + heavy noise
        this.#blip('sine', 120, 28, 0.5, 0.5);
        this.#noiseBurst(0.5, 'lowpass', 420, 0.8, 0.5);
        break;
      case 'spill': // descending watery glugs
        for (let i = 0; i < 4; i++) {
          this.#blip('sine', 520 - i * 70, 240 - i * 30, 0.13, 0.14, i * 0.09);
        }
        this.#noiseBurst(0.35, 'bandpass', 1100, 2, 0.16);
        break;
      case 'escape': // panicked squawks fleeing the crate
        for (let i = 0; i < 4; i++) {
          this.#blip('square', 760 + Math.random() * 240, 1250, 0.1, 0.09, i * 0.12);
        }
        break;
      default: // crush/collapse: a sad flop
        this.#blip('triangle', 240, 70, 0.4, 0.22);
        this.#noiseBurst(0.25, 'lowpass', 500, 1, 0.25);
    }
  }

  // A startled cluck from a live-animal crate (idle shuffle / knocks).
  playCluck() {
    this.#blip('square', 880, 1320, 0.06, 0.06);
    this.#blip('square', 660, 440, 0.08, 0.05, 0.07);
  }

  // Relieved "phew" after a near-miss: a breathy sigh sweeping down.
  playPhew() {
    this.#noiseBurst(0.45, 'bandpass', 1500, 1.2, 0.14);
    this.#blip('sine', 740, 392, 0.4, 0.08, 0.05);
  }

  // ---- Result-screen one-shots ----------------------------------------------

  // One star slamming in — pitch rises with each star (0-based index).
  playStar(index = 0) {
    const f = 523.25 * Math.pow(1.2599, index); // up a major third each star
    this.#blip('triangle', f, f, 0.3, 0.2);
    this.#noiseBurst(0.05, 'highpass', 2500, 2, 0.1); // tiny sparkle tick
  }

  // Tiny counter blip for the payout count-up; pitch eases up with progress.
  playTick(frac = 0) {
    this.#blip('square', 900 + frac * 500, 900 + frac * 500, 0.035, 0.045);
  }

  // Perfect-streak fanfare: one rising note per streak step (Phase 6 combo).
  playComboUp(streak = 1) {
    const n = Math.max(1, Math.min(5, streak));
    for (let i = 0; i < n; i++) {
      const f = 659.25 * Math.pow(1.1892, i); // up a minor third each step
      this.#blip('triangle', f, f, 0.22, 0.14, 0.35 + i * 0.09);
    }
  }

  // The streak died: a sad descending womp-womp.
  playComboBreak() {
    this.#blip('sawtooth', 320, 240, 0.28, 0.1, 0.35);
    this.#blip('sawtooth', 240, 130, 0.45, 0.12, 0.62);
  }
}
