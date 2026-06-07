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
    this.muted = false;
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
}
