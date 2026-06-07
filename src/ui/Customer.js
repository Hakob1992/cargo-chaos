// The customer — a speech bubble that reacts to the run in real time. Giving the
// cargo a worried owner turns a damage number into an emotional stake ("THAT CAKE
// COST $10,000!"). Lines are cargo-specific (the cake is the star) with a generic
// fallback, gated by a cooldown so they punctuate the drama instead of spamming.
const LINES = {
  cake: {
    avatar: '👰',
    start: ['Please… deliver my wedding cake in one piece!'],
    bump: ['Was that a pothole?!', 'Be careful with my cake!', 'Easy — EASY!',
      'My grandmother made that recipe!', 'I felt that one!'],
    nearFall: ['THAT CAKE COST $10,000!!', 'NO no no — don\'t you DARE!', 'KEEP IT LEVEL!'],
    perfect: ['It\'s PERFECT! Bless you! 😭'],
    good: ['Phew… a few smudges, but it\'ll do. Thank you!'],
    bad: ['My wedding is RUINED. 😡', 'What did you DO to my cake?!'],
  },
  default: {
    avatar: '🧍',
    start: ['Handle this with care, please.'],
    bump: ['Hey — watch the bumps!', 'Careful back there!', 'Take it easy!'],
    nearFall: ['Don\'t you dare drop it!', 'WHOA — keep it steady!'],
    perfect: ['Flawless! Thank you!'],
    good: ['Good enough. Thanks.'],
    bad: ['This is a disaster…'],
  },
};

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
    this.lines = LINES[delivery.id] || LINES.default;
    this.avatarEl.textContent = this.lines.avatar;
    this.bumpIdx = 0;
    this.lastSpeak = -999;
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
    this.#say(this.lines.start[0], { duration: 3.5, urgent: true });
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

  // Final verdict, mapped from the rating label.
  onResult(ratingLabel) {
    const r = ratingLabel.toLowerCase();
    const bucket = (r === 'perfect' || r === 'excellent') ? 'perfect'
      : (r === 'good') ? 'good' : 'bad';
    this.#say(this.#pick(this.lines[bucket]), { duration: 4, cooldown: 0, urgent: true });
  }

  hide() {
    clearTimeout(this._hideTimer);
    this.el.classList.add('hidden');
  }
}
