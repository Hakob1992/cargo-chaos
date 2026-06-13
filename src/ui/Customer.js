import { resolveCustomer } from '../data/customers.js';

// The customer — a speech bubble that reacts to the run in real time. Giving the
// cargo a worried owner turns a damage number into an emotional stake ("THAT CAKE
// COST $10,000!"). Phase 7: every delivery names a personality in customers.js
// (data-driven, like cargo types) whose lines AND tips depend on quality + time.
// A cooldown gates the chatter so lines punctuate the drama instead of spamming.
export class Customer {
  constructor(root) {
    this.el = document.createElement('div');
    this.el.className = 'customer hidden';
    this.el.innerHTML = `<span class="cust-avatar"></span><span class="cust-text"></span>`;
    root.appendChild(this.el);
    this.avatarEl = this.el.querySelector('.cust-avatar');
    this.textEl = this.el.querySelector('.cust-text');
    this._hideTimer = null;
    this.lastSpeak = -999;
    this.now = 0;
  }

  bind(delivery) {
    this.persona = resolveCustomer(delivery.customer);
    this.lines = this.persona.lines;
    this.avatarEl.textContent = this.persona.avatar;
    this.bumpIdx = 0;
    this.lastSpeak = -999;
    this._hurried = false;
  }

  // Called every frame with the run clock so cooldowns are frame-rate independent.
  setClock(t) { this.now = t; }

  #say(text, { duration = 3, cooldown = 2.6, urgent = false } = {}) {
    if (!urgent && this.now - this.lastSpeak < cooldown) return false;
    this.lastSpeak = this.now;
    this.textEl.textContent = text;
    this.el.classList.remove('hidden');
    this.el.classList.toggle('urgent', urgent);
    // Re-trigger the pop animation.
    this.el.classList.remove('pop'); void this.el.offsetWidth; this.el.classList.add('pop');
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.el.classList.add('hidden'), duration * 1000);
    return true;
  }

  #pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

  onStart() {
    this.now = 0; this.lastSpeak = -999;
    this.#say(this.#pick(this.lines.start), { duration: 3.5, urgent: true });
  }

  // A meaningful bump/impact — escalates through the bump lines.
  onBump() {
    const line = this.lines.bump[Math.min(this.bumpIdx, this.lines.bump.length - 1)];
    if (this.#say(line, { cooldown: 2.8 })) this.bumpIdx++;
  }

  // The cargo is leaning dangerously — panic line, allowed to interrupt sooner.
  onNearFall() {
    this.#say(this.#pick(this.lines.nearFall), { duration: 2.2, cooldown: 1.6, urgent: true });
  }

  // One nag the moment the run blows past par time (Game calls once).
  onHurry() {
    if (this._hurried) return;
    this._hurried = true;
    this.#say(this.#pick(this.lines.hurry), { duration: 2.6, urgent: true });
  }

  // Final verdict. Time outranks quality when a tip changed hands (fast/late
  // lines acknowledge the money); a wrecked load is ALWAYS the bad line.
  onResult(ratingLabel, timeVerdict = 'ontime') {
    const r = ratingLabel.toLowerCase();
    const quality = (r === 'perfect' || r === 'excellent') ? 'perfect'
      : (r === 'good') ? 'good' : 'bad';
    let bucket = quality;
    if (quality !== 'bad' && (timeVerdict === 'fast' || timeVerdict === 'late')) {
      bucket = timeVerdict;
    }
    this.#say(this.#pick(this.lines[bucket]), { duration: 4, cooldown: 0, urgent: true });
  }

  hide() {
    clearTimeout(this._hideTimer);
    this.el.classList.add('hidden');
  }
}
