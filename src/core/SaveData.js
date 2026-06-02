// Persistent progress: money, purchased upgrade levels, best result per delivery.
const KEY = 'cargo_chaos_save_v1';
const START_MONEY = 1000;

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
  }

  save() {
    localStorage.setItem(
      KEY,
      JSON.stringify({ money: this.money, upgrades: this.upgrades, best: this.best })
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

  reset() {
    this.money = START_MONEY;
    this.upgrades = {};
    this.best = {};
    this.save();
  }
}
