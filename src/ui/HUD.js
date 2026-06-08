// In-run heads-up display: time / damage / cargo readout + speedo, plus the
// on-screen touch controls for mobile. Pure DOM over the WebGL canvas.
export class HUD {
  constructor(root, input) {
    this.input = input;
    this.el = document.createElement('div');
    this.el.className = 'hud hidden';
    this.el.innerHTML = `
      <div class="hud-panel">
        <div class="row"><span class="label">CARGO</span><span class="val" data-cargo>—</span></div>
        <div class="row"><span class="label">CONDITION</span><span class="val cond-label" data-cond>PERFECT</span></div>
        <div class="cond-bar"><div class="cond-fill" data-cond-fill></div></div>
        <div class="row"><span class="label">TIME</span><span class="val" data-time>00:00.00</span></div>
      </div>

      <div class="hud-buttons">
        <button class="hud-icon-btn" data-mute aria-label="Mute"><span data-mute-icon>♪</span></button>
        <button class="hud-icon-btn" data-pause aria-label="Pause"><span data-pause-icon>❚❚</span></button>
      </div>

      <div class="speedo">
        <div class="speed" data-speed>0</div>
        <div class="speed-unit">KM/H</div>
        <div class="gear" data-gear>1</div>
      </div>

      <div class="pause-overlay hidden" data-pause-overlay>
        <div class="pause-card">
          <div class="pause-title">PAUSED</div>
          <button class="pause-resume" data-resume>RESUME</button>
        </div>
      </div>

      <button class="hud-deliver hidden" data-deliver>DELIVER HERE</button>

      <div class="hud-warning hidden" data-warning>⚠ OFF ROAD — CARGO AT RISK!</div>
      <div class="hud-warning cargo-warning hidden" data-cargo-warn></div>

      <div class="touch-controls">
        <div class="dpad">
          <button data-tc="left">◀</button>
          <button data-tc="right">▶</button>
        </div>
        <div class="pedals">
          <button data-tc="brake">BRAKE</button>
          <button data-tc="rev">▼</button>
          <button data-tc="gas">▲</button>
        </div>
      </div>
    `;
    root.appendChild(this.el);

    this.timeEl = this.el.querySelector('[data-time]');
    this.condEl = this.el.querySelector('[data-cond]');
    this.condFill = this.el.querySelector('[data-cond-fill]');
    this.cargoEl = this.el.querySelector('[data-cargo]');
    this.speedEl = this.el.querySelector('[data-speed]');
    this.gearEl = this.el.querySelector('[data-gear]');
    this.warningEl = this.el.querySelector('[data-warning]');
    this.cargoWarnEl = this.el.querySelector('[data-cargo-warn]');
    this.pauseBtn = this.el.querySelector('[data-pause]');
    this.muteBtn = this.el.querySelector('[data-mute]');
    this.pauseIcon = this.el.querySelector('[data-pause-icon]');
    this.muteIcon = this.el.querySelector('[data-mute-icon]');
    this.pauseOverlay = this.el.querySelector('[data-pause-overlay]');
    this.resumeBtn = this.el.querySelector('[data-resume]');

    this.#wireTouch();
  }

  #wireTouch() {
    const t = this.input.touch;
    const map = {
      left: [() => (t.steer = -1), () => (t.steer = 0)],
      right: [() => (t.steer = 1), () => (t.steer = 0)],
      gas: [() => (t.throttle = 1), () => (t.throttle = 0)],
      rev: [() => (t.throttle = -1), () => (t.throttle = 0)],
      brake: [() => (t.brake = true), () => (t.brake = false)],
    };
    for (const [key, [set, clear]] of Object.entries(map)) {
      const btn = this.el.querySelector(`[data-tc="${key}"]`);
      this.input.bindButton(btn, set, clear);
    }
  }

  onDeliver(cb) {
    this.deliverBtn = this.el.querySelector('[data-deliver]');
    this.deliverBtn.addEventListener('click', cb);
  }

  // Pause button + the RESUME button on the overlay both toggle pause.
  onPause(cb) {
    this.pauseBtn.addEventListener('click', cb);
    this.resumeBtn.addEventListener('click', cb);
  }

  onMute(cb) {
    this.muteBtn.addEventListener('click', cb);
  }

  // Reflect paused state: swap the icon (❚❚ ↔ ▶) and show/hide the overlay.
  setPaused(paused) {
    this.pauseIcon.textContent = paused ? '▶' : '❚❚';
    this.pauseBtn.setAttribute('aria-label', paused ? 'Resume' : 'Pause');
    this.pauseOverlay.classList.toggle('hidden', !paused);
  }

  // Reflect muted state: swap the icon (♪ ↔ 🔇) and dim the button.
  setMuted(muted) {
    this.muteIcon.textContent = muted ? '🔇' : '♪';
    this.muteBtn.setAttribute('aria-label', muted ? 'Unmute' : 'Mute');
    this.muteBtn.classList.toggle('is-off', muted);
  }

  // Show the DELIVER button only when the truck is actually on the pad.
  setDeliverable(canDeliver) {
    if (!this.deliverBtn) return;
    this.deliverBtn.classList.toggle('hidden', !canDeliver);
  }

  // Flash the off-road warning while the truck is bouncing through terrain.
  setOffRoad(off) {
    if (!this.warningEl) return;
    this.warningEl.classList.toggle('hidden', !off);
  }

  // Cargo-personality warning (tipping tank, primed canister, …) or null.
  setCargoWarn(msg) {
    if (!this.cargoWarnEl) return;
    if (msg) this.cargoWarnEl.textContent = msg;
    this.cargoWarnEl.classList.toggle('hidden', !msg);
  }

  show(delivery) {
    this.cargoEl.textContent = delivery.name;
    this.setDeliverable(false);
    this.setOffRoad(false);
    this.setCargoWarn(null);
    this.setPaused(false);
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  update({ time, integrity, stage, speed, gear }) {
    this.timeEl.textContent = formatTime(time);
    // Condition bar: fill = remaining integrity, colour + label = stage.
    const pct = Math.max(0, Math.min(100, integrity));
    const col = stage === 'ruined' ? '#c0291c' : stage === 'damaged' ? '#cf7a16' : '#1f9d4f';
    this.condFill.style.width = `${pct}%`;
    this.condFill.style.background = col;
    this.condEl.textContent = stage === 'ruined' ? 'RUINED' : stage === 'damaged' ? 'DAMAGED' : 'PERFECT';
    this.condEl.style.color = col;
    this.speedEl.textContent = speed;
    this.gearEl.textContent = gear;
  }
}

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.floor((seconds * 100) % 100);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
