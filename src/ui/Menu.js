import { DELIVERIES } from '../data/deliveries.js';
import { UPGRADES } from '../data/upgrades.js';
import { VEHICLES } from '../data/vehicles.js';
import { formatTime } from './HUD.js';

// Garage / delivery-select screen and the post-run result card.
export class Menu {
  constructor(root, game) {
    this.game = game;
    this.save = game.save;
    this.el = document.createElement('div');
    this.el.className = 'menu hidden';
    root.appendChild(this.el);
  }

  hide() {
    this.el.classList.add('hidden');
  }

  showGarage() {
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="garage">
        <header class="title-bar">
          <div class="logo">CARGO <span>CHAOS</span><small>DELIVER IT, DON'T DESTROY IT!</small></div>
          <div class="header-right">
            <button class="reset-btn" data-reset>RESET PROGRESS</button>
            <div class="money">$ ${this.save.money.toLocaleString()}</div>
          </div>
        </header>

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
        this.showGarage();
      }
    });
    this.#renderDeliveries();
    this.#renderUpgrades();
    this.#renderVehicles();
  }

  #renderDeliveries() {
    const wrap = this.el.querySelector('.deliveries');
    wrap.innerHTML = '';
    DELIVERIES.forEach((d) => {
      const best = this.save.best[d.id];
      const card = document.createElement('button');
      card.className = 'delivery-card';
      card.style.setProperty('--cargo-color', '#' + d.color.toString(16).padStart(6, '0'));
      card.innerHTML = `
        <div class="swatch"></div>
        <div class="d-name">${d.name}</div>
        <div class="d-tag">${d.tag}</div>
        <div class="d-reward">$ ${d.reward.toLocaleString()}</div>
        ${best != null ? `<div class="d-best">BEST ${best}%</div>` : ''}
      `;
      card.addEventListener('click', () => this.game.startDelivery(d));
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
    VEHICLES.forEach((v) => {
      const chip = document.createElement('div');
      chip.className = 'vehicle-chip' + (v.playable ? ' owned' : ' locked');
      chip.innerHTML = `
        <span class="v-name">${v.name}</span>
        <span class="v-status">${v.playable ? 'ACTIVE' : 'LOCKED · $' + v.unlockCost.toLocaleString()}</span>
      `;
      wrap.appendChild(chip);
    });
  }

  showResult({ delivery, integrity, rating, earnings, time, insured }) {
    this.el.classList.remove('hidden');
    const cls = rating.toLowerCase();
    this.el.innerHTML = `
      <div class="result-backdrop">
        <div class="result-card rating-${cls}">
          <div class="r-title">DELIVERY COMPLETE</div>
          <div class="r-cargo">${delivery.name}</div>
          <div class="r-rating">${rating}</div>
          <div class="r-integrity">
            <div class="r-bar"><div class="r-fill" style="width:${integrity}%"></div></div>
            <span>${integrity}% intact</span>
          </div>
          <div class="r-stats">
            <div><span>Time</span><b>${formatTime(time)}</b></div>
            <div><span>Payout${insured ? ' (insured)' : ''}</span><b>$ ${earnings.toLocaleString()}</b></div>
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
