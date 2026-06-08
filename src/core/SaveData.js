// Persistent progress: money, purchased upgrade levels, best result per delivery.
const KEY = 'cargo_chaos_save_v1';
const START_MONEY = 0;

export class SaveData {
  constructor() {
    this.load();
  }

  load() {
    let data = {};
    try {
      data = JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      data = {};
    }
    this.money = data.money ?? START_MONEY;
    this.upgrades = data.upgrades ?? {}; // id -> level (0 if absent)
    this.best = data.best ?? {};         // deliveryId -> best integrity
    this.stars = data.stars ?? {};       // deliveryId -> best star count (1..5)
  }

  save() {
    localStorage.setItem(
      KEY,
      JSON.stringify({ money: this.money, upgrades: this.upgrades, best: this.best, stars: this.stars })
    );
  }

  level(id) {
    return this.upgrades[id] ?? 0;
  }

  setLevel(id, lvl) {
    this.upgrades[id] = lvl;
    this.save();
  }

  addMoney(n) {
    this.money += n;
    this.save();
  }

  recordBest(deliveryId, integrity) {
    if (integrity > (this.best[deliveryId] ?? -1)) {
      this.best[deliveryId] = integrity;
      this.save();
    }
  }

  // Best star count for a delivery (0 if never completed cleanly).
  bestStarsOf(deliveryId) {
    return this.stars[deliveryId] ?? 0;
  }

  recordStars(deliveryId, stars) {
    if (stars > (this.stars[deliveryId] ?? 0)) {
      this.stars[deliveryId] = stars;
      this.save();
    }
  }

  // Sum of best stars across every delivery — the currency that gates content.
  totalStars() {
    return Object.values(this.stars).reduce((a, b) => a + b, 0);
  }

  reset() {
    this.money = START_MONEY;
    this.upgrades = {};
    this.best = {};
    this.stars = {};
    this.save();
  }
}
