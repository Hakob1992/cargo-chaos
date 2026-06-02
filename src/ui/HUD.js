// In-run heads-up display: time / damage / cargo readout + speedo, plus the
// on-screen touch controls for mobile. Pure DOM over the WebGL canvas.
export class HUD {
  constructor(root, input) {
    this.input = input;
    this.el = document.createElement('div');
    this.el.className = 'hud hidden';
    this.el.innerHTML = `
      <div class="hud-panel">
        <div class="row"><span class="label">TIME</span><span class="val" data-time>00:00.00</span></div>
        <div class="row"><span class="label">DAMAGE</span><span class="val dmg" data-damage>0%</span></div>
        <div class="row"><span class="label">CARGO</span><span class="val" data-cargo>—</span></div>
      </div>

      <div class="speedo">
        <div class="speed" data-speed>0</div>
        <div class="speed-unit">KM/H</div>
        <div class="gear" data-gear>1</div>
      </div>

      <button class="hud-deliver hidden" data-deliver>DELIVER HERE</button>

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
    this.damageEl = this.el.querySelector('[data-damage]');
    this.cargoEl = this.el.querySelector('[data-cargo]');
    this.speedEl = this.el.querySelector('[data-speed]');
    this.gearEl = this.el.querySelector('[data-gear]');

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

  // Show the DELIVER button only when the truck is actually on the pad.
  setDeliverable(canDeliver) {
    if (!this.deliverBtn) return;
    this.deliverBtn.classList.toggle('hidden', !canDeliver);
  }

  show(delivery) {
    this.cargoEl.textContent = delivery.name;
    this.setDeliverable(false);
    this.el.classList.remove('hidden');
  }

  hide() {
    this.el.classList.add('hidden');
  }

  update({ time, damage, speed, gear }) {
    this.timeEl.textContent = formatTime(time);
    this.damageEl.textContent = `${damage}%`;
    this.damageEl.style.color = damage > 50 ? '#ff5a4d' : damage > 20 ? '#ffb84d' : '#7CFFA0';
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
