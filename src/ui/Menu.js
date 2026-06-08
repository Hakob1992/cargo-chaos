import { DELIVERIES } from '../data/deliveries.js';
import { UPGRADES } from '../data/upgrades.js';
import { VEHICLES } from '../data/vehicles.js';
import { formatTime } from './HUD.js';
import { VehicleViewer } from './VehicleViewer.js';

// Garage / delivery-select screen and the post-run result card.
export class Menu {
  constructor(root, game) {
    this.game = game;
    this.save = game.save;
    this.el = document.createElement('div');
    this.el.className = 'menu hidden';
    root.appendChild(this.el);
    this.viewer = null;
    this.vehicleIndex = 0; // which vehicle the showroom is displaying
  }

  hide() {
    this.#disposeViewer();
    this.el.classList.add('hidden');
  }

  #disposeViewer() {
    if (this.viewer) { this.viewer.dispose(); this.viewer = null; }
  }

  showGarage() {
    // A fresh innerHTML wipes the old viewer canvas — tear its WebGL context
    // down first so contexts don't leak across re-renders (upgrade purchases).
    this.#disposeViewer();
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="garage">
        <header class="title-bar">
          <div class="logo">CARGO <span>CHAOS</span><small>DELIVER IT, DON'T DESTROY IT!</small></div>
          <div class="header-right">
            <button class="reset-btn" data-reset>RESET PROGRESS</button>
            <div class="stars-total">★ ${this.save.totalStars()}</div>
            <div class="money">$ ${this.save.money.toLocaleString()}</div>
          </div>
        </header>

        <section class="panel showroom-panel">
          <h2>GARAGE</h2>
          <div class="showroom">
            <button class="sr-arrow" data-sr-prev aria-label="Previous vehicle">&#8249;</button>
            <div class="sr-stage"></div>
            <button class="sr-arrow" data-sr-next aria-label="Next vehicle">&#8250;</button>
          </div>
          <div class="sr-info">
            <div class="sr-name"></div>
            <div class="sr-status"></div>
          </div>
          <div class="sr-hint">Drag to rotate · scroll to zoom</div>
        </section>

        <div class="garage-grid">
          <section class="panel">
            <h2>SELECT DELIVERY</h2>
            <div class="deliveries"></div>
          </section>

          <section class="panel">
            <h2>UPGRADES</h2>
            <div class="upgrades"></div>
            <h2 class="vehicles-h">VEHICLES</h2>
            <div class="vehicles"></div>
          </section>
        </div>
        <footer class="hint">Drive with <b>WASD</b> / arrows · <b>Space</b> brake · <b>R</b> recover · reach the green pad and stop to deliver</footer>
      </div>
    `;
    this.el.querySelector('[data-reset]').addEventListener('click', () => {
      if (confirm('Reset all progress — money, upgrades and best scores?')) {
        this.save.reset();
        this.vehicleIndex = 0;
        this.showGarage();
      }
    });
    this.#renderDeliveries();
    this.#renderUpgrades();
    this.#renderVehicles();
    this.#initShowroom();
  }

  // ---- Showroom (3D vehicle viewer) ---------------------------------------

  #initShowroom() {
    const stage = this.el.querySelector('.sr-stage');
    this.viewer = new VehicleViewer(stage);
    this.el.querySelector('[data-sr-prev]').addEventListener('click', () => this.#cycleVehicle(-1));
    this.el.querySelector('[data-sr-next]').addEventListener('click', () => this.#cycleVehicle(1));
    this.#showVehicleAt(this.vehicleIndex);
  }

  #cycleVehicle(dir) {
    const n = VEHICLES.length;
    this.#showVehicleAt((this.vehicleIndex + dir + n) % n);
  }

  #showVehicleAt(index) {
    this.vehicleIndex = index;
    const v = VEHICLES[index];
    if (this.viewer) this.viewer.showVehicle(v);

    const nameEl = this.el.querySelector('.sr-name');
    const statusEl = this.el.querySelector('.sr-status');
    if (nameEl) nameEl.textContent = v.name;
    if (statusEl) {
      if (v.playable) {
        statusEl.textContent = 'ACTIVE';
        statusEl.className = 'sr-status owned';
      } else {
        statusEl.textContent = 'LOCKED · $' + v.unlockCost.toLocaleString();
        statusEl.className = 'sr-status locked';
      }
    }
    // Reflect the selection on the vehicle chips.
    this.el.querySelectorAll('.vehicle-chip').forEach((chip, i) => {
      chip.classList.toggle('selected', i === index);
    });
  }

  #renderDeliveries() {
    const wrap = this.el.querySelector('.deliveries');
    wrap.innerHTML = '';
    const total = this.save.totalStars();
    DELIVERIES.forEach((d) => {
      const gate = d.starGate ?? 0;
      const locked = total < gate;
      const bestStars = this.save.bestStarsOf(d.id);
      const starGlyphs = Array.from({ length: 5 }, (_, i) => i < bestStars ? '★' : '☆').join('');
      const card = document.createElement('button');
      card.className = 'delivery-card' + (locked ? ' locked' : '');
      card.style.setProperty('--cargo-color', '#' + d.color.toString(16).padStart(6, '0'));
      card.innerHTML = `
        <div class="swatch"></div>
        <div class="d-name">${d.name}</div>
        <div class="d-tag">${d.tag}</div>
        <div class="d-reward">$ ${d.reward.toLocaleString()}</div>
        ${locked
          ? `<div class="d-lock">🔒 ★ ${gate} to unlock</div>`
          : `<div class="d-stars">${starGlyphs}</div>`}
      `;
      if (locked) {
        card.disabled = true;
      } else {
        card.addEventListener('click', () => this.game.startDelivery(d));
      }
      wrap.appendChild(card);
    });
  }

  #renderUpgrades() {
    const wrap = this.el.querySelector('.upgrades');
    wrap.innerHTML = '';
    UPGRADES.forEach((u) => {
      const level = this.save.level(u.id);
      const maxed = level >= u.costs.length;
      const cost = maxed ? null : u.costs[level];
      const row = document.createElement('div');
      row.className = 'upgrade-row';
      row.innerHTML = `
        <div class="u-info">
          <div class="u-name">${u.name} <span class="u-lvl">Lv ${level}${maxed ? ' · MAX' : ''}</span></div>
          <div class="u-desc">${u.desc}</div>
          <div class="u-bar">${Array.from({ length: u.costs.length + 1 }, (_, i) =>
            `<span class="${i <= level ? 'on' : ''}"></span>`).join('')}</div>
        </div>
        <button class="u-buy" ${maxed || cost > this.save.money ? 'disabled' : ''}>
          ${maxed ? 'MAX' : '$ ' + cost.toLocaleString()}
        </button>
      `;
      if (!maxed) {
        row.querySelector('.u-buy').addEventListener('click', () => {
          if (this.save.money >= cost) {
            this.save.addMoney(-cost);
            this.save.setLevel(u.id, level + 1);
            this.showGarage(); // re-render with new state
          }
        });
      }
      wrap.appendChild(row);
    });
  }

  #renderVehicles() {
    const wrap = this.el.querySelector('.vehicles');
    wrap.innerHTML = '';
    VEHICLES.forEach((v, i) => {
      const chip = document.createElement('button');
      chip.className = 'vehicle-chip' + (v.playable ? ' owned' : ' locked');
      chip.innerHTML = `
        <span class="v-name">${v.name}</span>
        <span class="v-status">${v.playable ? 'ACTIVE' : 'LOCKED · $' + v.unlockCost.toLocaleString()}</span>
      `;
      // Clicking a chip previews that vehicle in the 3D showroom.
      chip.addEventListener('click', () => this.#showVehicleAt(i));
      wrap.appendChild(chip);
    });
  }

  showResult({ delivery, integrity, rating, earnings, time, insured, failed = false, failReason = null,
               stars = 1, breakdown = { condition: 0, time: 0, style: 0 }, totalStars = 0 }) {
    this.#disposeViewer();
    this.el.classList.remove('hidden');
    const cls = rating.toLowerCase();
    const reasons = { shatter: 'SHATTERED', explode: 'EXPLODED', spill: 'SPILLED', escape: 'THEY ESCAPED!', collapse: 'COLLAPSED', crush: 'CRUSHED' };
    const reasonLabel = failed && failReason && reasons[failReason] ? reasons[failReason] : null;
    const prevBest = this.save.bestStarsOf(delivery.id);
    const isNewBest = !failed && stars > prevBest;
    // 5 star glyphs, filled up to `stars`, each animated in on a stagger.
    const starRow = Array.from({ length: 5 }, (_, i) =>
      `<span class="star ${i < stars ? 'on' : ''}" style="animation-delay:${i * 0.12}s">★</span>`).join('');
    const meter = (label, frac) =>
      `<div class="bd-row"><span>${label}</span><div class="bd-bar"><div class="bd-fill" style="width:${Math.round(frac * 100)}%"></div></div></div>`;
    this.el.innerHTML = `
      <div class="result-backdrop">
        <div class="result-card rating-${cls} ${failed ? 'is-failed' : ''}">
          <div class="r-title">${failed ? 'DELIVERY FAILED' : 'DELIVERY COMPLETE'}</div>
          <div class="r-cargo">${delivery.name}${reasonLabel ? ` — ${reasonLabel}` : ''}</div>
          <div class="r-stars">${starRow}</div>
          ${isNewBest ? '<div class="r-newbest">NEW BEST!</div>' : ''}
          <div class="r-breakdown">
            ${meter('Condition', breakdown.condition)}
            ${meter('Time', breakdown.time)}
            ${meter('Style', breakdown.style)}
          </div>
          <div class="r-rating">${rating}</div>
          <div class="r-integrity">
            <div class="r-bar"><div class="r-fill" style="width:${integrity}%"></div></div>
            <span>${integrity}% intact · ${formatTime(time)}</span>
          </div>
          <div class="r-stats">
            <div><span>Payout${insured ? ' (insured)' : ''}</span><b>$ ${earnings.toLocaleString()}</b></div>
            <div><span>Total Stars</span><b>★ ${totalStars}</b></div>
          </div>
          <div class="r-money">Balance: $ ${this.save.money.toLocaleString()}</div>
          <div class="r-actions">
            <button class="btn-secondary" data-retry>RETRY</button>
            <button class="btn-primary" data-garage>GARAGE</button>
          </div>
        </div>
      </div>
    `;
    this.el.querySelector('[data-garage]').addEventListener('click', () => this.game.returnToGarage());
    this.el.querySelector('[data-retry]').addEventListener('click', () => this.game.startDelivery(delivery));
  }
}
