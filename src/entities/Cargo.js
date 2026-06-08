import * as THREE from 'three';
import { RAPIER } from '../core/Physics.js';
import { resolveBehavior } from '../data/cargoTypes.js';

// A single cargo item riding on the truck bed. Damage accrues from:
//   - hard impacts (contact-force events, scaled by fragility)
//   - tipping past a threshold angle (tall/heavy cargo)
//   - falling off the truck / off the world
// The "straps" upgrade raises bed friction so the cargo slides less.
//
// DAMAGE STAGES (Phase 2): every cargo passes through three readable states —
//   perfect → damaged → ruined — keyed off accumulated damage. Boxes crack and
//   then crush; the WEDDING CAKE has its own richer staging (sheds cherry, then
//   frosting, a tier, then collapses). Reaching `ruined` fails the delivery.
const UP = new THREE.Vector3(0, 1, 0);
// Resting Z of the cargo on the truck bed, in truck-local space (see notes in
// the original build — the GLB bed is centred around z ≈ -0.9).
const BED_Z = -0.95;

// Damage thresholds (in damage %, where integrity = 100 − damage):
const DAMAGED_AT = 12; // first visible damage stage (cracks appear)
const RUINED_AT = 70;  // ruined → delivery fails (also forced when broken)

// Lazily-baked cartoon "ink crack" overlay, shared by every box cargo. A handful
// of jagged dark branches on a transparent canvas — mapped onto each box face.
let _crackTex = null;
function crackTexture() {
  if (_crackTex) return _crackTex;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.strokeStyle = 'rgba(28,18,10,0.88)';
  x.lineCap = 'round';
  for (let n = 0; n < 5; n++) {
    let px = 50 + Math.random() * 156, py = 50 + Math.random() * 156;
    let ang = Math.random() * Math.PI * 2;
    x.lineWidth = 3 + Math.random() * 3;
    x.beginPath();
    x.moveTo(px, py);
    const segs = 4 + (Math.random() * 4 | 0);
    for (let s = 0; s < segs; s++) {
      ang += (Math.random() - 0.5) * 1.3;
      const len = 12 + Math.random() * 26;
      px += Math.cos(ang) * len; py += Math.sin(ang) * len;
      x.lineTo(px, py);
      if (Math.random() < 0.5) { // small branch
        const ba = ang + (Math.random() - 0.5) * 1.7, bl = 8 + Math.random() * 16;
        x.lineTo(px + Math.cos(ba) * bl, py + Math.sin(ba) * bl);
        x.moveTo(px, py);
      }
    }
    x.stroke();
  }
  _crackTex = new THREE.CanvasTexture(c);
  _crackTex.colorSpace = THREE.SRGBColorSpace;
  return _crackTex;
}

export class Cargo {
  constructor(scene, physics, delivery, truck) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.delivery = delivery;
    this.truck = truck;
    // Phase 3 — the cargo's data-driven personality (see cargoTypes.js).
    this.behavior = resolveBehavior(delivery.behavior);
    this.isCake = this.behavior.render === 'cake';
    this.hits = 0;             // distinct impacts past threshold (gas-canister fuse)
    this._lastHitAt = -99;     // age of the last counted hit (debounce)
    this.tipTime = 0;          // seconds spent tilted past tolerance
    this.tipProgress = 0;      // 0..1 toward a "spill/escape" failure
    this.armed = false;        // gas canister: one hit taken, primed to blow
    this.failKind = null;      // how it died: shatter/explode/spill/escape/…
    this.damage = 0;           // 0..100
    this.broken = false;
    this.age = 0;              // seconds since spawn
    this.settleTime = 0.9;     // grace period while truck + cargo settle
    this.damageStage = 0;      // index into the cake damage stages
    this._localUp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    // Render-interpolation buffers (mirror the Truck) so the cargo glides at the
    // same cadence as the smoothly-interpolated truck.
    this._prevT = null;
    this._prevR = null;
    this._interpQ = new THREE.Quaternion();
    this._currQ = new THREE.Quaternion();

    // Wobble state (visual jiggle of the cake on top of the physics body).
    this.wobbleX = 0; this.wobbleZ = 0;   // current lean angles (rad)
    this.wVelX = 0; this.wVelZ = 0;        // angular velocities for the spring
    this._prevVel = { x: 0, y: 0, z: 0 };
    this._accel = new THREE.Vector3();

    const [hx, hy, hz] = delivery.size;
    this.halfH = hy;
    const bedTop = 0.3 + 0.04;
    this.bedFloor = 0.3;
    const spawn = truck.position.clone();
    const spawnQ = truck.group.quaternion;
    const offset = new THREE.Vector3(0, bedTop + hy, BED_Z).applyQuaternion(spawnQ);
    spawn.add(offset);

    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation({ x: spawnQ.x, y: spawnQ.y, z: spawnQ.z, w: spawnQ.w })
      // Minimal linear damping so cruising at constant speed doesn't drag the
      // cargo into a phantom rearward drift — friction alone carries it with the
      // truck. Lower angular damping lets it actually tip/roll in hard corners.
      .setLinearDamping(0.05)
      .setAngularDamping(0.8)
      .setCanSleep(false);
    this.body = this.world.createRigidBody(desc);

    const mass = delivery.mass;
    this.mass = mass;
    this.fragility = delivery.fragility;
    // Behaviour scales how hard a knock has to be before it counts (lower = more
    // fragile). Glass shatters at half the force a sturdy crate shrugs off.
    this.impactThreshold = mass * 60 * this.behavior.impactScale;

    // Phase 1 — the cargo rides LOOSE, held only by friction + the bed walls (no
    // tether joint), so truck motion transfers through momentum: hard braking
    // slides it into the cab, acceleration slides it to the tailgate, hard corners
    // shove it to the outside, and a rollover can dump it out entirely.
    //
    // The Cargo Straps upgrade now raises this friction instead of adding a
    // spring: more straps grip harder and slide less (40 = base tie-down …
    // 220 = maxed). We use the Min combine rule so the EFFECTIVE coefficient is
    // exactly this value (not averaged up by the 0.6 chassis / 0.8 walls), which
    // — under this game's −20 gravity (doubled normal force) — keeps sliding
    // readable: it breaks loose above roughly bedFriction × 20 m/s² of accel.
    const strapVal = truck.tuning.straps ?? 40;
    this.bedFriction = 0.35 + Math.min(1, (strapVal - 40) / 180) * 0.45; // 0.35..0.80

    // Bottom-weight the cargo: lower its centre of mass toward the base so tall,
    // narrow loads (e.g. glass panels: hz 0.14, CoM 0.8 high) stay upright under
    // normal acceleration instead of toppling instantly, yet still tip in
    // genuinely aggressive moves — Phase 3's upright tolerances judge the rest.
    // Inertia uses the centroidal cuboid tensor (a fine gameplay approximation).
    const comDrop = this.delivery.comDrop ?? 0; // 0 = geometric centre … 1 = base (per-cargo)
    const com = { x: 0, y: -hy * comDrop, z: 0 };
    const inertia = {
      x: (mass / 3) * (hy * hy + hz * hz),
      y: (mass / 3) * (hx * hx + hz * hz),
      z: (mass / 3) * (hx * hx + hy * hy),
    };
    const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMassProperties(mass, com, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(this.bedFriction)
      .setFrictionCombineRule(RAPIER.CoefficientCombineRule.Min)
      .setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(this.impactThreshold);
    this.physics.tag(this.world.createCollider(col, this.body), 'cargo');

    this.#buildMesh(hx, hy, hz);
  }

  // The mesh is a Group that follows the physics body (set in sync). Its child
  // `visual` carries the wobble lean and the damage-stage parts, so wobble never
  // fights the interpolation that drives the group.
  #buildMesh(hx, hy, hz) {
    this.mesh = new THREE.Group();
    this.mesh.castShadow = true;
    this.scene.add(this.mesh);

    this.visual = new THREE.Group();
    this.mesh.add(this.visual);

    if (this.isCake) this.#buildCake(hx, hy, hz);
    else this.#buildBox(hx, hy, hz);
  }

  #buildBox(hx, hy, hz) {
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      new THREE.MeshStandardMaterial({ color: this.delivery.color, roughness: 0.7 })
    );
    box.castShadow = true;
    box.receiveShadow = true;
    this.visual.add(box);
    this.boxMesh = box;
    // Damage-stage palette: lerp from the base colour toward a scuffed tone.
    this._baseColor = new THREE.Color(this.delivery.color);
    this._scuffColor = new THREE.Color(0x6b5a44);

    // Crack overlay — a slightly larger shell wearing the ink-crack texture,
    // hidden until the cargo reaches the `damaged` stage.
    const crack = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2 * 1.015, hy * 2 * 1.015, hz * 2 * 1.015),
      new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false })
    );
    crack.visible = false;
    box.add(crack);
    this.crackMesh = crack;

    const strapMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 });
    for (const z of [-hz * 0.5, hz * 0.5]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(hx * 2.1, hy * 2.1, 0.08), strapMat);
      band.position.z = z;
      box.add(band);
    }
  }

  // A 3-tier wedding cake centred in the collider box (half-extents hx,hy,hz).
  #buildCake(hx, hy, hz) {
    const cakeMat = () => new THREE.MeshStandardMaterial({ color: 0xfff3e0, roughness: 0.75 });
    const frostMat = new THREE.MeshStandardMaterial({ color: this.delivery.color, roughness: 0.6 });
    const r = Math.min(hx, hz) * 0.92;
    const totalH = hy * 2;
    // Three stacked tiers (radii shrink upward), summing to the box height.
    const h1 = totalH * 0.38, h2 = totalH * 0.32, h3 = totalH * 0.24;
    let y = -hy; // bottom of the box

    const mkTier = (radius, h, withFrost) => {
      const tier = new THREE.Group();
      const cake = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, h, 28), cakeMat());
      cake.castShadow = true; cake.receiveShadow = true;
      tier.add(cake);
      if (withFrost) {
        // Frosting drip ring near the top of the tier.
        const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, h * 0.12, 8, 28), frostMat);
        ring.rotation.x = Math.PI / 2;
        ring.position.y = h * 0.42;
        tier.add(ring);
        tier._frostRing = ring;
      }
      tier.position.y = y + h / 2;
      y += h;
      return tier;
    };

    this.tier1 = mkTier(r, h1, true);
    this.tier2 = mkTier(r * 0.72, h2, true);
    this.tier3 = mkTier(r * 0.48, h3, true);
    this.visual.add(this.tier1, this.tier2, this.tier3);

    // Cherry on top.
    this.cherry = new THREE.Group();
    const berry = new THREE.Mesh(
      new THREE.SphereGeometry(r * 0.13, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xd11f3a, roughness: 0.4 })
    );
    berry.castShadow = true;
    this.cherry.add(berry);
    this.cherry.position.y = y + r * 0.13;
    this.visual.add(this.cherry);

    this.cakeAllParts = [this.tier1, this.tier2, this.tier3, this.cherry];
  }

  // A short driver-facing warning for the HUD, or null when all's well.
  get warning() {
    if (this.broken) return null;
    if (this.armed) return '⚠ PRESSURE CRITICAL — NO MORE HITS!';
    if (this.behavior.mustStayUpright && this.tipProgress > 0.25) {
      return this.behavior.failKind === 'escape' ? "⚠ STEADY — IT'S WAKING!" : '⚠ KEEP IT LEVEL!';
    }
    return null;
  }

  registerImpact(magnitude) {
    if (this.broken || this.age < this.settleTime) return;
    const over = magnitude - this.impactThreshold;
    if (over <= 0) return;
    const b = this.behavior;

    // Glass / eggs: one solid knock and it's gone.
    if (b.instantFailOnImpact) { this.failBy(b.failKind || 'shatter'); return; }

    // Pressurised: the first hit dents + primes it, the second detonates.
    if (b.explodeOnSecondHit) {
      // Debounce — one physical collision resolves over several solver steps,
      // each firing an event; count that as ONE hit, not a dozen.
      if (this.age - this._lastHitAt < 0.5) return;
      this._lastHitAt = this.age;
      this.hits += 1;
      if (this.hits >= 2) { this.failBy(b.failKind || 'explode'); return; }
      this.armed = true;
      this.addDamage(Math.max(45 - this.damage, 0)); // jump to ~45% (visibly hurt)
      return;
    }

    // Everyone else: damage proportional to the overshoot × fragility.
    const dmg = (over / this.mass) * this.fragility * 0.025;
    if (dmg > 0.1) this.addDamage(dmg);
  }

  // Hard, behaviour-flavoured failure (shatter / explode / spill / escape …).
  failBy(kind) {
    if (this.broken) return;
    this.failKind = kind;
    this.damage = 100;
    this.#ruin();
  }

  // Coarse condition stage every cargo type reports (drives the HUD + fail).
  get stage() {
    if (this.broken || this.damage >= RUINED_AT) return 'ruined';
    if (this.damage >= DAMAGED_AT) return 'damaged';
    return 'perfect';
  }

  get ruined() {
    return this.stage === 'ruined';
  }

  addDamage(amount) {
    if (this.broken) return; // already ruined — no further accrual
    const before = this.damage;
    this.damage = Math.min(100, this.damage + amount);
    if (this.damage === before) return;
    this.#applyDamageStage();
    if ((this.damage >= RUINED_AT || this.damage >= 100) && !this.broken) this.#ruin();
  }

  // Dispatch to the type-specific damage visual.
  #applyDamageStage() {
    if (this.isCake) this.#applyCakeStage();
    else this.#applyBoxStage();
  }

  // Box stage: scuff/darken progressively, reveal cracks once damaged.
  #applyBoxStage() {
    if (!this.boxMesh) return;
    if (this.damage >= DAMAGED_AT && this.crackMesh) this.crackMesh.visible = true;
    const f = THREE.MathUtils.clamp((this.damage - DAMAGED_AT) / (RUINED_AT - DAMAGED_AT), 0, 1);
    this.boxMesh.material.color.copy(this._baseColor).lerp(this._scuffColor, f * 0.7);
  }

  // Cake damage is shown by losing pieces, keyed to remaining integrity:
  //   ≤90 cherry falls · ≤70 frosting slides · ≤50 top tier gone · ≤20 disaster.
  #applyCakeStage() {
    const integ = this.integrity;

    // Cherry falls off at 90%.
    if (this.cherry) this.cherry.visible = integ > 90;

    // Frosting slides at 70%: shove the rings sideways and tint them.
    if (integ <= 70 && !this._frostSlid) {
      this._frostSlid = true;
      for (const tier of [this.tier1, this.tier2, this.tier3]) {
        if (tier && tier._frostRing) {
          tier._frostRing.position.x += 0.06;
          tier._frostRing.material.color.offsetHSL(0, -0.1, -0.08);
        }
      }
    }

    // Top tier gone at 50%.
    if (this.tier3) this.tier3.visible = integ > 50;

    // Disaster at 20%: second tier slumps and everything browns.
    if (integ <= 20 && !this._disaster) {
      this._disaster = true;
      if (this.tier2) {
        this.tier2.rotation.z = 0.5;
        this.tier2.position.x += 0.12;
      }
      this.visual.traverse((c) => {
        if (c.isMesh) c.material.color.lerp(new THREE.Color(0x6b5535), 0.55);
      });
    }
  }

  // Ruined: the cargo is a write-off. Collapse/crush it visually and lock it.
  #ruin() {
    this.broken = true;
    if (this.isCake) {
      // Total collapse: flatten and brown the whole thing.
      this._disaster = true;
      if (this.tier3) this.tier3.visible = false;
      if (this.cherry) this.cherry.visible = false;
      if (this.tier2) { this.tier2.scale.y = 0.4; this.tier2.rotation.z = 0.7; }
      if (this.tier1) this.tier1.scale.y = 0.6;
      this.visual.traverse((c) => {
        if (c.isMesh) c.material.color.set(0x5a4a30);
      });
    } else if (this.boxMesh) {
      // Box wreck visual depends on HOW it died.
      const kind = this.failKind || this.behavior.failKind || 'crush';
      if (this.crackMesh) this.crackMesh.visible = true;
      switch (kind) {
        case 'shatter': // collapse into a small dark heap of shards
          this.visual.scale.set(0.9, 0.25, 0.9);
          this.boxMesh.material.color.set(0x4a5560);
          break;
        case 'explode': // blown flat + scorched, debris spread wide
          this.visual.scale.set(1.5, 0.2, 1.5);
          this.boxMesh.material.color.set(0x201813);
          this.visual.rotation.z = (Math.random() - 0.5) * 0.8;
          break;
        case 'spill': // emptied out — squat and darkened (water gone)
          this.visual.scale.y = 0.5;
          this.boxMesh.material.color.set(0x244a5a);
          break;
        case 'escape': // crate flung open and empty
          this.visual.scale.set(1.05, 1.05, 1.05);
          this.boxMesh.material.transparent = true;
          this.boxMesh.material.opacity = 0.25;
          this.boxMesh.material.color.set(0x6b5a44);
          break;
        default: // crush
          this.boxMesh.material.color.set(0x3b3128);
          this.visual.scale.y = 0.6;
          this.visual.rotation.z = (Math.random() - 0.5) * 0.5;
      }
    }
  }

  capturePreStepState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this._prevT = { x: t.x, y: t.y, z: t.z };
    this._prevR = { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  sync(alpha = 1) {
    const t = this.body.translation();
    const r = this.body.rotation();
    if (this._prevT && alpha < 0.999) {
      const a = alpha;
      this.mesh.position.set(
        this._prevT.x + (t.x - this._prevT.x) * a,
        this._prevT.y + (t.y - this._prevT.y) * a,
        this._prevT.z + (t.z - this._prevT.z) * a
      );
      this._interpQ.set(this._prevR.x, this._prevR.y, this._prevR.z, this._prevR.w);
      this._currQ.set(r.x, r.y, r.z, r.w);
      this._interpQ.slerp(this._currQ, a);
      this.mesh.quaternion.copy(this._interpQ);
    } else {
      this.mesh.position.set(t.x, t.y, t.z);
      this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
    // Apply the wobble lean to the visual child (cake only).
    if (this.isCake) this.visual.rotation.set(this.wobbleX, 0, this.wobbleZ);
  }

  // Damage / age / wobble logic — runs on the fixed physics step.
  update(dt) {
    this.age += dt;
    const t = this.body.translation();
    const r = this.body.rotation();

    if (this.isCake) this.#updateWobble(dt, r);

    if (this.broken || this.age < this.settleTime) return;

    // Tipping past ~55° does gentle damage.
    this._localUp.copy(UP).applyQuaternion(this._q.set(r.x, r.y, r.z, r.w));
    const tilt = this._localUp.angleTo(UP);
    this.lastTilt = tilt;
    if (tilt > 0.95) this.addDamage((tilt - 0.95) * 6 * dt);

    // mustStayUpright: hold it past its lean tolerance and a timer runs down to
    // a spill (fish tank) or escape (live animals); right it in time and recover.
    const b = this.behavior;
    if (b.mustStayUpright) {
      const tol = (b.uprightToleranceDeg ?? 50) * Math.PI / 180;
      const timeout = b.openTimeoutSec ?? 3;
      if (tilt > tol) this.tipTime = Math.min(timeout, this.tipTime + dt);
      else this.tipTime = Math.max(0, this.tipTime - dt * 0.6); // recovers if righted
      this.tipProgress = this.tipTime / timeout;
      if (this.tipTime >= timeout) { this.failBy(b.failKind || 'spill'); return; }
    }

    // Fell off the bed / off the world.
    const truckPos = this.truck.position;
    const horiz = Math.hypot(t.x - truckPos.x, t.z - truckPos.z);
    if (t.y < -3 || horiz > 6) this.addDamage(100);
  }

  // Damped-spring lean driven by the cargo body's acceleration, expressed in the
  // body-local frame so it leans back under throttle and sideways in turns.
  #updateWobble(dt, r) {
    const v = this.body.linvel();
    this._accel.set(
      (v.x - this._prevVel.x) / dt,
      0,
      (v.z - this._prevVel.z) / dt
    );
    this._prevVel.x = v.x; this._prevVel.y = v.y; this._prevVel.z = v.z;
    // World accel → body-local (conjugate of the body rotation).
    this._q.set(r.x, r.y, r.z, r.w).conjugate();
    this._accel.applyQuaternion(this._q);

    const K = 0.018, MAX = 0.4;
    const targetX = THREE.MathUtils.clamp(-this._accel.z * K, -MAX, MAX); // pitch from fwd accel
    const targetZ = THREE.MathUtils.clamp(this._accel.x * K, -MAX, MAX);  // roll from lateral accel

    const k = 140, damp = 13;
    this.wVelX += ((targetX - this.wobbleX) * k - this.wVelX * damp) * dt;
    this.wobbleX += this.wVelX * dt;
    this.wVelZ += ((targetZ - this.wobbleZ) * k - this.wVelZ * damp) * dt;
    this.wobbleZ += this.wVelZ * dt;
  }

  placeOnBed() {
    const tr = this.truck.body.translation();
    const rot = this.truck.body.rotation();
    this._q.set(rot.x, rot.y, rot.z, rot.w);
    const offset = new THREE.Vector3(0, this.bedFloor + 0.04 + this.halfH, BED_Z).applyQuaternion(this._q);
    this.body.setTranslation({ x: tr.x + offset.x, y: tr.y + offset.y, z: tr.z + offset.z }, true);
    this.body.setRotation(rot, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._prevT = null;
    this._prevR = null;
  }

  get integrity() {
    return Math.max(0, Math.round(100 - this.damage));
  }

  dispose() {
    this.physics.remove(this.body);
    this.scene.remove(this.mesh);
    this.mesh.traverse((c) => {
      if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
    });
  }
}
