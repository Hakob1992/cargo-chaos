// Keyboard + on-screen touch controls. Exposes a normalised control state:
//   throttle: -1..1 (forward/reverse), steer: -1..1 (left/right), brake: bool, reset: bool
export class Input {
  constructor() {
    this.keys = new Set();
    this.touch = { throttle: 0, steer: 0, brake: false };
    this.resetRequested = false;

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyR') this.resetRequested = true;
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  // Wire an on-screen button (touch + mouse) to set a touch-control field.
  bindButton(el, set, clear) {
    const down = (e) => { e.preventDefault(); set(); };
    const up = (e) => { e.preventDefault(); clear(); };
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('touchcancel', up, { passive: false });
    el.addEventListener('mousedown', down);
    el.addEventListener('mouseup', up);
    el.addEventListener('mouseleave', up);
  }

  get state() {
    const k = this.keys;
    let throttle = this.touch.throttle;
    let steer = this.touch.steer;
    if (k.has('KeyW') || k.has('ArrowUp')) throttle += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) throttle -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) steer -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) steer += 1;
    const brake = this.touch.brake || k.has('Space');
    return {
      throttle: Math.max(-1, Math.min(1, throttle)),
      steer: Math.max(-1, Math.min(1, steer)),
      brake,
    };
  }

  consumeReset() {
    const r = this.resetRequested;
    this.resetRequested = false;
    return r;
  }
}
