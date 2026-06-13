import { gsap } from 'gsap';
import { DELIVERIES } from '../data/deliveries.js';
import { UPGRADES } from '../data/upgrades.js';
import { VEHICLES } from '../data/vehicles.js';
import { ROUTES } from '../data/routes.js';
import { formatTime } from './HUD.js';
import { VehicleViewer } from './VehicleViewer.js';

// ---- Result-screen feel tunables --------------------------------------------
const STAR_FIRST_DELAY_MS = 250; // pause before the first star slams in
const STAR_STAGGER_MS = 250;     // gap between star slams (matches the CSS delays)
const PAYOUT_COUNT_MS = 900;     // payout count-up duration
const PAYOUT_TICK_MS = 45;       // min gap between count-up tick sounds

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

    // Entrance: title drops in, panels rise, delivery cards pop on a stagger.
    gsap.from(this.el.querySelector('.title-bar'), { y: -30, opacity: 0, duration: 0.4, ease: 'back.out(1.6)' });
    gsap.from(this.el.querySelectorAll('.panel'), { y: 26, opacity: 0, duration: 0.45, stagger: 0.08, ease: 'power2.out', delay: 0.06 });
    gsap.from(this.el.querySelectorAll('.delivery-card'), { scale: 0.8, opacity: 0, duration: 0.35, stagger: 0.04, ease: 'back.out(2)', delay: 0.22 });
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
        // Phase 5: picking a delivery opens the route choice, not the run.
        card.addEventListener('click', () => this.#showRouteSelect(d));
      }
      wrap.appendChild(card);
    });
  }

  // ---- Route picker (Phase 5 risk/reward) -----------------------------------

  // Overlay with the two routes to the pad: the safe long way vs the risky cut.
  #showRouteSelect(delivery) {
    const old = this.el.querySelector('.route-backdrop');
    if (old) old.remove();
    const world = this.game.world;
    const km = (m) => `≈${Math.round(m / 10) * 10} m`;
    const card = (r) => {
      const len = world ? world.lengthOf(r.id) : 0;
      const par = len ? Math.round(len / r.parSpeed) : 0;
      const hazards = r.id === 'shortcut'
        ? '<div class="rt-hazards">⚠ mud · bumps · JUMP</div>'
        : '<div class="rt-hazards safe">smooth all the way</div>';
      return `
        <button class="route-card ${r.tag === 'RISKY' ? 'risky' : 'safe'}" data-route="${r.id}">
          <div class="rt-tag">${r.tag}</div>
          <div class="rt-name">${r.name}</div>
          <div class="rt-desc">${r.desc}</div>
          ${hazards}
          <div class="rt-stats">
            <span>${km(len)}</span>
            <span>par ${par}s</span>
            <span class="rt-pay">${r.payoutMult > 1 ? `×${r.payoutMult} PAY` : 'normal pay'}</span>
          </div>
        </button>`;
    };
    const overlay = document.createElement('div');
    overlay.className = 'route-backdrop';
    overlay.innerHTML = `
      <div class="route-panel">
        <div class="route-title">PICK YOUR ROUTE</div>
        <div class="route-cargo">${delivery.name} · $ ${delivery.reward.toLocaleString()}</div>
        <div class="route-cards">
          ${card(ROUTES.highway)}
          ${card(ROUTES.shortcut)}
        </div>
        <button class="route-cancel" data-cancel>BACK</button>
      </div>`;
    this.el.appendChild(overlay);
    gsap.from(overlay, { opacity: 0, duration: 0.2, ease: 'power1.out' });
    gsap.from(overlay.querySelector('.route-panel'), { scale: 0.85, y: 20, opacity: 0, duration: 0.35, ease: 'back.out(1.8)' });
    gsap.from(overlay.querySelectorAll('.route-card'), { y: 24, opacity: 0, duration: 0.34, stagger: 0.09, ease: 'back.out(1.6)', delay: 0.14 });
    overlay.querySelector('[data-cancel]').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    for (const btn of overlay.querySelectorAll('[data-route]')) {
      btn.addEventListener('click', () => this.game.startDelivery(delivery, btn.dataset.route));
    }
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

  // One-line combo verdict for the result card (Phase 6).
  #comboLine(combo) {
    if (!combo) return '';
    if (combo.mult > 1) {
      return `<div class="r-combo active">🔥 PERFECT ×${combo.count} — COMBO ×${combo.mult} PAYOUT!</div>`;
    }
    if (combo.count > 0) {
      const left = combo.at - combo.count;
      return `<div class="r-combo">🔥 PERFECT STREAK ${combo.count}/${combo.at} — ${left} more for ×2 pay</div>`;
    }
    if (combo.prev > 0) {
      return `<div class="r-combo broken">✖ STREAK BROKEN (was ${combo.prev})</div>`;
    }
    return '';
  }

  // One-line customer verdict for the result card (Phase 7). Shows who the
  // cargo belonged to and whether their feelings about timing moved the tip.
  #tipLine(tip) {
    if (!tip || !tip.persona) return '';
    const p = tip.persona;
    if (tip.timeVerdict === 'fast' && tip.mult > 1) {
      const pct = Math.round((tip.mult - 1) * 100);
      const big = tip.mult >= 1.9 ? ' big' : '';
      return `<div class="r-tip fast${big}">${p.avatar} ${p.name} — ${tip.mult >= 1.9 ? 'DOUBLE PAY' : `+${pct}% TIP`} for speed!</div>`;
    }
    if (tip.timeVerdict === 'late' && tip.mult < 1) {
      const pct = Math.round((1 - tip.mult) * 100);
      return `<div class="r-tip late">${p.avatar} ${p.name} — docked ${pct}% for being late</div>`;
    }
    return `<div class="r-tip">${p.avatar} ${p.name}</div>`;
  }

  showResult({ delivery, integrity, rating, earnings, time, insured, failed = false, failReason = null,
               stars = 1, breakdown = { condition: 0, time: 0, style: 0 }, totalStars = 0, route = null,
               combo = null, tip = null }) {
    this.#disposeViewer();
    this.el.classList.remove('hidden');
    const cls = rating.toLowerCase();
    const reasons = { shatter: 'SHATTERED', explode: 'EXPLODED', spill: 'SPILLED', escape: 'THEY ESCAPED!', collapse: 'COLLAPSED', crush: 'CRUSHED' };
    const reasonLabel = failed && failReason && reasons[failReason] ? reasons[failReason] : null;
    const prevBest = this.save.bestStarsOf(delivery.id);
    const isNewBest = !failed && stars > prevBest;
    // 5 star glyphs. Lit stars SLAM in one at a time on a dramatic stagger
    // (each with a rising note, scheduled below); unlit ones fade in quietly.
    const starRow = Array.from({ length: 5 }, (_, i) => {
      const lit = i < stars;
      const delay = lit
        ? (STAR_FIRST_DELAY_MS + i * STAR_STAGGER_MS) / 1000
        : 0.1;
      return `<span class="star ${lit ? 'on' : ''}" style="animation-delay:${delay}s">★</span>`;
    }).join('');
    const meter = (label, frac) =>
      `<div class="bd-row"><span>${label}</span><div class="bd-bar"><div class="bd-fill" style="width:${Math.round(frac * 100)}%"></div></div></div>`;
    this.el.innerHTML = `
      <div class="result-backdrop">
        <div class="result-card rating-${cls} ${failed ? 'is-failed' : ''}">
          <div class="r-title">${failed ? 'DELIVERY FAILED' : 'DELIVERY COMPLETE'}</div>
          <div class="r-cargo">${delivery.name}${reasonLabel ? ` — ${reasonLabel}` : ''}</div>
          ${route ? `<div class="r-route ${route.tag === 'RISKY' ? 'risky' : ''}">via ${route.name}${route.payoutMult > 1 ? ` · ×${route.payoutMult} PAY` : ''}</div>` : ''}
          ${this.#comboLine(combo)}
          ${this.#tipLine(tip)}
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
            <div><span>Payout${insured ? ' (insured)' : ''}</span><b data-payout>$ 0</b></div>
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
    // Backdrop fades, the card springs in (before the staggered star slams).
    gsap.from(this.el.querySelector('.result-backdrop'), { opacity: 0, duration: 0.22, ease: 'power1.out' });
    gsap.from(this.el.querySelector('.result-card'), { scale: 0.7, y: 30, opacity: 0, duration: 0.42, ease: 'back.out(1.7)' });

    this.el.querySelector('[data-garage]').addEventListener('click', () => this.game.returnToGarage());
    this.el.querySelector('[data-retry]').addEventListener('click', () =>
      this.game.startDelivery(delivery, route ? route.id : 'highway'));

    // One rising note per lit star, timed to the CSS slam stagger.
    for (let i = 0; i < stars; i++) {
      setTimeout(() => this.game.audio.playStar(i), STAR_FIRST_DELAY_MS + i * STAR_STAGGER_MS);
    }

    // Payout counts up (eased) with tiny rising ticks, starting once the
    // stars have finished landing.
    const payoutEl = this.el.querySelector('[data-payout]');
    const startAfter = STAR_FIRST_DELAY_MS + stars * STAR_STAGGER_MS;
    setTimeout(() => {
      if (!payoutEl.isConnected) return; // screen already re-rendered
      const t0 = performance.now();
      let lastTick = 0;
      const tick = (now) => {
        if (!payoutEl.isConnected) return;
        const f = Math.min(1, (now - t0) / PAYOUT_COUNT_MS);
        const eased = 1 - Math.pow(1 - f, 3);
        payoutEl.textContent = '$ ' + Math.round(earnings * eased).toLocaleString();
        if (f < 1) {
          if (now - lastTick > PAYOUT_TICK_MS && earnings > 0) {
            this.game.audio.playTick(f);
            lastTick = now;
          }
          requestAnimationFrame(tick);
        } else {
          payoutEl.classList.add('payout-done'); // little settling pop
        }
      };
      requestAnimationFrame(tick);
    }, startAfter);
  }
}
