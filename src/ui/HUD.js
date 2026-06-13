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
        <div class="row"><span class="label">ROUTE</span><span class="val route-label" data-route>—</span></div>
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
      <div class="hud-phew hidden" data-phew>😅 PHEW!</div>
      <div class="hud-combo hidden" data-combo></div>

      <div class="touch-controls">
        <div class="joystick" data-joy>
          <div class="joy-base"></div>
          <div class="joy-knob" data-joy-knob></div>
          <div class="joy-hint">DRIVE</div>
        </div>
        <div class="touch-right">
          <button class="tc-recover" data-tc-recover aria-label="Flip upright">⟲</button>
          <button class="tc-brake" data-tc="brake">BRAKE</button>
        </div>
      </div>
    `;
    root.appendChild(this.el);

    this.timeEl = this.el.querySelector('[data-time]');
    this.routeEl = this.el.querySelector('[data-route]');
    this.condEl = this.el.querySelector('[data-cond]');
    this.condFill = this.el.querySelector('[data-cond-fill]');
    this.cargoEl = this.el.querySelector('[data-cargo]');
    this.speedEl = this.el.querySelector('[data-speed]');
    this.gearEl = this.el.querySelector('[data-gear]');
    this.warningEl = this.el.querySelector('[data-warning]');
    this.cargoWarnEl = this.el.querySelector('[data-cargo-warn]');
    this.phewEl = this.el.querySelector('[data-phew]');
    this._phewTimer = null;
    this.comboEl = this.el.querySelector('[data-combo]');
    this._combo = null;      // { count, at, mult } for the current run
    this._comboLost = false; // flips the moment the cargo takes its first scratch
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

    // Analog virtual joystick: push up = throttle, down = reverse, left/right =
    // steer. The knob follows the thumb (clamped to the base radius); releasing
    // recenters it and zeroes the inputs. Pointer Events cover touch + mouse.
    const joy = this.el.querySelector('[data-joy]');
    const knob = this.el.querySelector('[data-joy-knob]');
    const DEAD = 0.14;        // ignore tiny wobble near centre
    let radius = 60;          // recomputed from the rendered base on each grab
    let activeId = null;

    const apply = (dx, dy) => {
      const r = radius || 1;
      let nx = Math.max(-1, Math.min(1, dx / r));
      let ny = Math.max(-1, Math.min(1, -dy / r)); // screen-y is down → invert
      knob.style.transform = `translate(${nx * r}px, ${-ny * r}px)`;
      // Deadzone + rescale so the edge still reaches full ±1.
      const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));
      t.steer = dz(nx);
      t.throttle = dz(ny);
    };
    const recenter = () => {
      knob.style.transform = 'translate(0px, 0px)';
      t.steer = 0; t.throttle = 0;
    };
    const grab = (e) => {
      e.preventDefault();
      activeId = e.pointerId ?? 'mouse';
      const rect = joy.getBoundingClientRect();
      radius = rect.width / 2;
      this._joyCx = rect.left + radius;
      this._joyCy = rect.top + radius;
      joy.classList.add('active');
      apply(e.clientX - this._joyCx, e.clientY - this._joyCy);
    };
    const move = (e) => {
      if (activeId === null) return;
      if (e.pointerId !== undefined && e.pointerId !== activeId) return;
      e.preventDefault();
      apply(e.clientX - this._joyCx, e.clientY - this._joyCy);
    };
    const release = (e) => {
      if (activeId === null) return;
      if (e.pointerId !== undefined && e.pointerId !== activeId) return;
      activeId = null;
      joy.classList.remove('active');
      recenter();
    };
    joy.addEventListener('pointerdown', grab);
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);

    // Brake holds; recover (⟲) flips the truck upright on tap.
    const brakeBtn = this.el.querySelector('[data-tc="brake"]');
    this.input.bindButton(brakeBtn, () => (t.brake = true), () => (t.brake = false));
    const recoverBtn = this.el.querySelector('[data-tc-recover]');
    const tapRecover = (e) => { e.preventDefault(); this.input.resetRequested = true; };
    recoverBtn.addEventListener('pointerdown', tapRecover);
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

  // Perfect-streak chip (Phase 6). Hidden at streak 0; shows progress while
  // building, gold once the multiplier is live, and visibly BREAKS the moment
  // the cargo takes its first scratch this run.
  #renderCombo() {
    const c = this._combo;
    if (!c || (c.count <= 0 && !this._comboLost)) {
      this.comboEl.classList.add('hidden');
      return;
    }
    this.comboEl.classList.remove('hidden');
    this.comboEl.classList.toggle('active', !this._comboLost && c.count >= c.at);
    this.comboEl.classList.toggle('lost', this._comboLost);
    if (this._comboLost) {
      this.comboEl.textContent = '✖ COMBO LOST';
    } else if (c.count >= c.at) {
      this.comboEl.textContent = `🔥 COMBO ×${c.mult} — KEEP IT PERFECT`;
    } else {
      this.comboEl.textContent = `🔥 PERFECT STREAK ${c.count}/${c.at}`;
    }
  }

  // Near-miss relief: a quick "PHEW!" flash after the cargo almost went over.
  flashPhew() {
    if (!this.phewEl) return;
    clearTimeout(this._phewTimer);
    this.phewEl.classList.remove('hidden', 'pop');
    void this.phewEl.offsetWidth; // restart the CSS animation
    this.phewEl.classList.add('pop');
    this._phewTimer = setTimeout(() => this.phewEl.classList.add('hidden'), 1400);
  }

  // Cargo-personality warning (tipping tank, primed canister, …) or null.
  setCargoWarn(msg) {
    if (!this.cargoWarnEl) return;
    if (msg) this.cargoWarnEl.textContent = msg;
    this.cargoWarnEl.classList.toggle('hidden', !msg);
  }

  show(delivery, route = null, combo = null) {
    this.cargoEl.textContent = delivery.name;
    if (this.routeEl) {
      this.routeEl.textContent = route ? route.name : '—';
      this.routeEl.style.color = route && route.tag === 'RISKY' ? '#e08a3c' : '#7fd6a0';
    }
    this._combo = combo;
    this._comboLost = false;
    this.#renderCombo();
    this.setDeliverable(false);
    this.setOffRoad(false);
    this.setCargoWarn(null);
    this.setPaused(false);
    if (this.phewEl) this.phewEl.classList.add('hidden');
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  update({ time, integrity, stage, speed, gear }) {
    this.timeEl.textContent = formatTime(time);
    // First scratch = the streak is gone for this run; break the chip NOW.
    if (!this._comboLost && integrity < 100 && this._combo && this._combo.count > 0) {
      this._comboLost = true;
      this.#renderCombo();
    }
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
