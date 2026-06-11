import * as THREE from 'three';

// Rubber-hose cartoon dust ("Inkwell Dust" style) for the truck wheels.
// Each puff is a camera-facing Sprite textured with a procedurally-baked
// cartoon "poof" — a committee of circles rendered with a two-pass ink
// technique (dark stamp enlarged, cream stamp a hair smaller) so the
// overlapping lobes fuse into one bold hand-inked silhouette. Puffs erupt
// backward from each wheel, float up, swell, cool toward sepia, and fade.
//
// Integration (unchanged API): create in startDelivery, update(dt, truck)
// each frame, burst(truck, intensity) on landings, dispose() in teardown.

const POOL_SIZE = 80;   // total sprites across all 4 wheels
const MAX_LIFE  = 1.05; // seconds — cartoon smoke lingers
const TEX_VARIANTS = 6; // distinct baked poof silhouettes

// ---- Emission tunables ------------------------------------------------------
const BASE_EMIT_PER_SEC = 9;    // per wheel at top speed (existing behaviour)
const LAUNCH_EMIT_PER_SEC = 13; // extra per wheel while flooring it from low speed
const SKID_EMIT_PER_SEC = 15;   // extra per wheel while sliding / hard braking
const LAUNCH_SPEED_MAX = 22;    // km/h under which full throttle reads as a launch
const SKID_LATERAL_DIV = 25;    // lateral km/h that maps to full skid dust
const EXHAUST_INTERVAL = 0.4;   // seconds between put-put puffs under load
const EXHAUST_MAX_SPEED = 40;   // km/h above which the engine stops puffing

const CREAM   = '#f2e8cf';
const INK     = '#2c2014';
const SEPIA   = new THREE.Color(0xb2966a); // aged-loam tint at end of life
const WHITE   = new THREE.Color(0xffffff);

// ---------------------------------------------------------------------------
// Bake the cartoon poof textures once (shared across all particles).
// ---------------------------------------------------------------------------
let SHARED_TEXTURES = null;

function bakePoofTexture(variant) {
  const S = 160;                 // texture resolution
  const cnv = document.createElement('canvas');
  cnv.width = cnv.height = S;
  const ctx = cnv.getContext('2d');
  const cx = S / 2, cy = S / 2;

  // Deterministic-ish lobe layout per variant (just uses Math.random — variety
  // is the goal, not reproducibility).
  const nLobes = 6 + Math.floor(Math.random() * 4); // 6..9
  const baseR = S * 0.205;
  const outline = S * 0.052;     // bold ink weight
  const lobes = [];
  lobes.push({ a: 0, d: 0, s: 0.95 }); // central body
  for (let i = 0; i < nLobes; i++) {
    const a = (i / nLobes) * Math.PI * 2 + (Math.random() - 0.5) * 0.7;
    const d = 0.5 + Math.random() * 0.34;
    const s = 0.42 + Math.random() * 0.26;
    lobes.push({ a, d, s });
  }

  const lobeXY = (lobe) => [
    cx + Math.cos(lobe.a) * lobe.d * baseR,
    cy + Math.sin(lobe.a) * lobe.d * baseR,
  ];

  // PASS 1 — ink silhouette (dark, enlarged)
  ctx.fillStyle = INK;
  for (const lobe of lobes) {
    const [lx, ly] = lobeXY(lobe);
    ctx.beginPath();
    ctx.arc(lx, ly, lobe.s * baseR + outline, 0, Math.PI * 2);
    ctx.fill();
  }
  // PASS 2 — cream fill (a hair smaller → leaves only the rim as outline)
  ctx.fillStyle = CREAM;
  for (const lobe of lobes) {
    const [lx, ly] = lobeXY(lobe);
    ctx.beginPath();
    ctx.arc(lx, ly, lobe.s * baseR, 0, Math.PI * 2);
    ctx.fill();
  }
  // Soft highlight — barely-there lighter dab near the top-left of the body
  ctx.fillStyle = 'rgba(255,252,240,0.55)';
  ctx.beginPath();
  ctx.arc(cx - baseR * 0.22, cy - baseR * 0.26, baseR * 0.30, 0, Math.PI * 2);
  ctx.fill();

  const tex = new THREE.CanvasTexture(cnv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function getTextures() {
  if (!SHARED_TEXTURES) {
    SHARED_TEXTURES = [];
    for (let i = 0; i < TEX_VARIANTS; i++) SHARED_TEXTURES.push(bakePoofTexture(i));
  }
  return SHARED_TEXTURES;
}

// ---------------------------------------------------------------------------
class Particle {
  constructor(scene, textures) {
    this.textures = textures;
    this.mat = new THREE.SpriteMaterial({
      map: textures[0],
      transparent: true,
      depthWrite: false,
      color: 0xffffff,
      rotation: 0,
    });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.visible = false;
    this.vel = new THREE.Vector3();
    this.life = 0;
    this.maxLife = MAX_LIFE;
    this.initSize = 0.3;
    this.endSize = 1.0;
    this.spin = 0;
    this.active = false;
    scene.add(this.sprite);
  }

  emit(pos, vel, startSize, endSize) {
    this.sprite.position.copy(pos);
    this.vel.copy(vel);
    this.initSize = startSize;
    this.endSize = endSize;
    this.sprite.scale.setScalar(startSize);
    this.life = 0;
    this.maxLife = MAX_LIFE * (0.8 + Math.random() * 0.4);
    this.spin = (Math.random() * 2 - 1) * 1.4;
    this.mat.map = this.textures[Math.floor(Math.random() * this.textures.length)];
    this.mat.rotation = Math.random() * Math.PI * 2;
    this.mat.color.copy(WHITE);
    this.mat.opacity = 0.96;
    this.mat.needsUpdate = true;
    this.active = true;
    this.sprite.visible = true;
  }

  update(dt) {
    if (!this.active) return;
    this.life += dt;
    if (this.life >= this.maxLife) {
      this.active = false;
      this.sprite.visible = false;
      return;
    }
    const t = this.life / this.maxLife;

    // Move + float. Cartoon smoke is light: gentle gravity (slightly buoyant
    // feel via low value), strong horizontal drag so puffs settle and hang.
    this.sprite.position.addScaledVector(this.vel, dt);
    this.vel.y -= 2.2 * dt;          // light gravity
    const drag = Math.pow(0.18, dt); // heavy horizontal drag
    this.vel.x *= drag;
    this.vel.z *= drag;
    this.vel.y *= Math.pow(0.5, dt);

    // Swell (eased — fast early growth) and slow rotation drift.
    const grow = Math.pow(t, 0.42);
    this.sprite.scale.setScalar(this.initSize + (this.endSize - this.initSize) * grow);
    this.mat.rotation += this.spin * dt;

    // Cool cream → sepia over the back half, and fade out (concave: puffs hang
    // then vanish).
    if (t > 0.45) {
      const ct = (t - 0.45) / 0.55;
      this.mat.color.copy(WHITE).lerp(SEPIA, ct * 0.8);
    }
    this.mat.opacity = Math.pow(1 - t, 0.6) * 0.96;
  }

  dispose(scene) {
    scene.remove(this.sprite);
    this.mat.dispose();
  }
}

// ---------------------------------------------------------------------------
export class WheelParticles {
  constructor(scene) {
    this.scene = scene;
    const textures = getTextures();
    this._pool = Array.from({ length: POOL_SIZE }, () => new Particle(scene, textures));
    this._next = 0;

    this._wpos  = new THREE.Vector3();
    this._vel   = new THREE.Vector3();
    this._fwd   = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._tmpQ  = new THREE.Quaternion();
  }

  update(dt, truck) {
    for (const p of this._pool) p.update(dt);

    if (!truck) return;
    const speed = truck.speedKmh;
    const thr = Math.abs(truck.lastThrottle ?? 0);

    // Launch: flooring it from (near) standstill — wheels chew up the dirt.
    const launch = thr > 0.6 && speed < LAUNCH_SPEED_MAX
      ? 1 - speed / LAUNCH_SPEED_MAX : 0;
    // Skid: sliding sideways, or stomping the brake at speed.
    const lat = truck.lateralSpeedKmh ?? 0;
    const skid = Math.min(1, Math.max(lat / SKID_LATERAL_DIV,
      truck.lastBrake && speed > 20 ? 0.7 : 0));

    // Exhaust puffs run even when wheel dust doesn't (e.g. revving from rest).
    this.#updateExhaust(dt, truck, thr, speed);

    if (speed < 2.5 && launch <= 0) return;

    this._tmpQ.copy(truck.group.quaternion);
    this._fwd.set(0, 0, 1).applyQuaternion(this._tmpQ);
    this._right.set(1, 0, 0).applyQuaternion(this._tmpQ);

    const sf = Math.min(1, speed / 58);
    // Puff energy: launches kick dust even though the truck is barely moving.
    const sfEff = Math.max(sf, launch * 0.7, skid * 0.6);

    const emitPerSec = sf * BASE_EMIT_PER_SEC
      + launch * LAUNCH_EMIT_PER_SEC
      + skid * SKID_EMIT_PER_SEC;
    for (let wi = 0; wi < 4; wi++) {
      if (Math.random() >= emitPerSec * dt) continue;
      this.#emitWheel(wi, truck, sfEff);
    }
  }

  // Comic put-put exhaust: an immediate double puff when the throttle is
  // stomped, then a steady beat while the engine works hard at low speed.
  #updateExhaust(dt, truck, thr, speed) {
    this._exhCd = (this._exhCd ?? 0) - dt;
    const prev = this._prevThr ?? 0;
    this._prevThr = thr;
    if (thr > 0.6 && prev <= 0.6) this.#emitExhaust(truck, 2, 1);
    if (thr > 0.6 && speed < EXHAUST_MAX_SPEED && this._exhCd <= 0) {
      this._exhCd = EXHAUST_INTERVAL;
      this.#emitExhaust(truck, 1, 0.6);
    }
  }

  #emitExhaust(truck, count, intensity) {
    this._tmpQ.copy(truck.group.quaternion);
    this._fwd.set(0, 0, 1).applyQuaternion(this._tmpQ);
    for (let i = 0; i < count; i++) {
      // Exhaust tip: rear-left corner, low.
      this._wpos.set(-0.55, -0.05, -2.05)
        .applyQuaternion(this._tmpQ)
        .add(truck.group.position);
      this._vel.copy(this._fwd).multiplyScalar(-(1.0 + Math.random() * 1.2));
      this._vel.x += (Math.random() * 2 - 1) * 0.5;
      this._vel.y = 0.8 + Math.random() * 1.0 * intensity;
      this._vel.z += (Math.random() * 2 - 1) * 0.5;
      const start = 0.16 + Math.random() * 0.1;
      const end = start + 0.35 + Math.random() * 0.3 * (1 + intensity);
      this._spawn(this._wpos, this._vel, start, end);
    }
  }

  burst(truck, intensity) {
    if (!truck || intensity < 0.05) return;
    this._tmpQ.copy(truck.group.quaternion);
    const count = Math.ceil(intensity * 9);
    for (let wi = 0; wi < 4; wi++) {
      for (let j = 0; j < count; j++) {
        const wp = truck.wheelPoints[wi];
        this._wpos
          .set(wp.x, wp.y - 0.33, wp.z)
          .applyQuaternion(this._tmpQ)
          .add(truck.group.position);
        this._vel.set(
          (Math.random() * 2 - 1) * 3.2,
          1.4 + Math.random() * 3.5 * intensity,
          (Math.random() * 2 - 1) * 3.2
        );
        const start = 0.32 + Math.random() * 0.2;
        const end = start + 0.9 + Math.random() * 0.8 * (1 + intensity);
        this._spawn(this._wpos, this._vel, start, end);
      }
    }
  }

  #emitWheel(wi, truck, sf) {
    const wp = truck.wheelPoints[wi];
    this._wpos
      .set(wp.x, wp.y - 0.33, wp.z)
      .applyQuaternion(this._tmpQ)
      .add(truck.group.position);

    // Spray mostly backward; outer wheels kick sideways in turns.
    const strength = 1.5 + sf * 3.0;
    this._vel
      .copy(this._fwd)
      .multiplyScalar(-strength * (0.6 + Math.random() * 0.7));
    this._vel.x += (Math.random() * 2 - 1) * strength * 0.45;
    this._vel.z += (Math.random() * 2 - 1) * strength * 0.3;
    this._vel.y = 0.6 + Math.random() * 1.6 * sf;

    if (Math.abs(truck.steerAngle) > 0.08) {
      const side = (wi % 2 === 0 ? -1 : 1) * truck.steerAngle;
      this._vel.addScaledVector(this._right, side * 2.0 * sf);
    }

    // Cartoon poofs are chunky: bigger than a realistic speck, grow large.
    const start = 0.28 + Math.random() * 0.18 * (0.5 + sf);
    const end = start + 0.7 + Math.random() * 0.9 * (0.5 + sf);
    this._spawn(this._wpos, this._vel, start, end);
  }

  _spawn(pos, vel, startSize, endSize) {
    const p = this._pool[this._next];
    this._next = (this._next + 1) % POOL_SIZE;
    p.emit(pos, vel, startSize, endSize);
  }

  dispose() {
    for (const p of this._pool) p.dispose(this.scene);
    this._pool = [];
    // Shared textures persist across runs (cheap, reused) — not disposed here.
  }
}
