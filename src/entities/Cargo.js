import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RAPIER } from '../core/Physics.js';
import { resolveBehavior } from '../data/cargoTypes.js';
import { BurstFX } from './BurstFX.js';

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

// ---- Cartoon-reaction tunables ---------------------------------------------
// Squash-and-stretch when the cargo thumps down after air time:
const SQUASH_MIN_DVY = 3.5;   // upward velocity jump (m/s) that counts as a landing
const SQUASH_DVY_RANGE = 9;   // dvy above the min that maps to a FULL squash
const SQUASH_DECAY = 0.002;   // per-second retention — relaxes in ~0.2s
const SQUASH_Y = 0.38;        // max vertical squash (fraction of height)
const SQUASH_XZ = 0.26;       // max horizontal stretch to conserve "volume"
// Nervous shiver while the cargo skates across the bed:
const SLIDE_MIN = 0.6;        // relative slide speed (m/s) where shiver starts
const SLIDE_RANGE = 2.5;      // slide speed above min that maps to full shiver
const SLIDE_JITTER = 0.05;    // shiver amplitude (rad)
const SHIVER_HZ = 34;         // shiver oscillation speed
// Idle character:
const ARMED_TREMBLE = 0.045;  // primed gas canister rattles visibly (rad)
const IDLE_PULSE_SEC = 0.35;  // length of one live-animal shuffle pulse
const IDLE_MIN_SEC = 1.6;     // min gap between idle shuffles
const IDLE_VAR_SEC = 2.6;     // extra random gap
const IDLE_AMP = 0.05;        // shuffle amplitude (rad)
// Type particle FX:
const STEAM_INTERVAL = 0.12;  // seconds between steam puffs while armed
const FEATHER_TIP_INTERVAL = 0.22; // feather trickle while the crate tips

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

    // Liquid state (set once a model with a "Water" node loads). The water
    // surface sloshes — leans opposite to acceleration — and flings splash
    // droplets when it sloshes or gets knocked hard.
    this.waterMesh = null;     // the sloshing node inside the model
    this.waterFX = null;       // splash particle system
    this._fx = [];             // every BurstFX (splashes, shatter shards) to tick/dispose
    this.sloshX = 0; this.sloshZ = 0;     // current water lean angles (rad)
    this.sVelX = 0; this.sVelZ = 0;        // slosh spring velocities
    this._splashCd = 0;        // cooldown between slosh-driven splashes
    this._tmpVec = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();

    // Cartoon-reaction state: landing squash, slide shiver, idle character.
    this.squash = 0;           // 0..1 — current squash-and-stretch amount
    this.slideAmount = 0;      // 0..1 — how hard the cargo is sliding (Game reads this)
    this._prevVy = 0;          // vertical velocity last step (landing detection)
    this._shiverX = 0; this._shiverZ = 0;
    this._shiverPhase = 0;
    this._idleTimer = IDLE_MIN_SEC; // next live-animal shuffle
    this._idlePulse = 0;       // 1 → 0 during a shuffle pulse
    this._steamCd = 0;         // armed-canister steam emission cooldown
    this._featherCd = 0;       // feather trickle cooldown while tipping
    this._fxByKey = {};        // lazily-created per-type BurstFX systems

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
    // Materials the damage stages tint (each with its own base colour). The
    // placeholder is the single box material; a loaded GLB swaps in its own
    // cloned materials so multiple cargo of the same type never share tint.
    this._tintTargets = [{ mat: box.material, base: this._baseColor.clone() }];

    // Crack overlay — a slightly larger shell wearing the ink-crack texture,
    // hidden until the cargo reaches the `damaged` stage. Parented to `visual`
    // (not the box) so it survives a swap to a GLB model.
    const crack = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2 * 1.015, hy * 2 * 1.015, hz * 2 * 1.015),
      new THREE.MeshBasicMaterial({ map: crackTexture(), transparent: true, depthWrite: false })
    );
    crack.visible = false;
    this.visual.add(crack);
    this.crackMesh = crack;

    const strapMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 });
    for (const z of [-hz * 0.5, hz * 0.5]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(hx * 2.1, hy * 2.1, 0.08), strapMat);
      band.position.z = z;
      box.add(band);
    }

    // If this delivery ships a custom model, load it and replace the placeholder.
    if (this.delivery.model) this.#loadBoxModel(this.delivery.model, hx, hy, hz);
  }

  // Swap the placeholder box for a glTF model authored to the collider size.
  // Async (like the truck's Car1.glb): the placeholder shows until this resolves.
  #loadBoxModel(file, hx, hy, hz) {
    new GLTFLoader().load(
      `./${file}`,
      (gltf) => {
        if (this._disposed) return;
        const model = gltf.scene;
        // Centre on the body origin and fit to the collider box. The model is
        // authored to spec, so the height-match scale lands near 1 and keeps
        // proportions intact.
        const bbox = new THREE.Box3().setFromObject(model);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        const s = (hy * 2) / (size.y || 1);
        model.scale.setScalar(s);
        model.position.set(-center.x * s, -center.y * s, -center.z * s);

        const tints = [];
        let water = null;
        model.traverse((c) => {
          if (!c.isMesh) return;
          c.castShadow = true;
          c.receiveShadow = true;
          c.matrixAutoUpdate = true;
          c.material = c.material.clone(); // per-instance, so damage tint is isolated
          // glTF carries the glass panes' sub-1 opacity, but three only marks a
          // material transparent for BLEND alpha mode — enable it for any < 1.
          if (c.material.opacity < 1) c.material.transparent = true;
          tints.push({ mat: c.material, base: c.material.color.clone() });
          // A node named "Water" is the sloshing liquid surface.
          if (/water/i.test(c.name)) water = c;
        });

        // Liquid cargo: hook up sloshing + splash droplets.
        if (water) {
          this.waterMesh = water;
          water.matrixAutoUpdate = true;
          this.waterFX = new BurstFX(this.scene, { color: this.delivery.color });
          this._fx.push(this.waterFX);
        }

        // Drop the placeholder box (its straps are children and go with it).
        if (this.boxMesh) {
          this.visual.remove(this.boxMesh);
          this.boxMesh.geometry.dispose();
          this.boxMesh.material.dispose();
          this.boxMesh = null;
        }
        this.visual.add(model);
        this.modelMesh = model;
        if (tints.length) this._tintTargets = tints;
        // Re-apply the current damage stage onto the freshly loaded materials.
        if (this.damage > 0 && !this.broken) this.#applyBoxStage();
      },
      undefined,
      (err) => console.warn(`Cargo: ${file} failed to load — using placeholder box.`, err)
    );
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

    // Swap the procedural cake for a modelled one (if provided). The model must
    // expose Tier1/2/3, Frost1/2/3 and Cherry nodes so the staging keeps working.
    if (this.delivery.model) this.#loadCakeModel(this.delivery.model, hx, hy, hz);
  }

  // Map a glTF wedding cake's named nodes onto this.tier1/2/3 / _frostRing /
  // cherry so every existing cake-damage stage drives the model instead of the
  // procedural cylinders. Async; the procedural cake shows until this resolves.
  #loadCakeModel(file, hx, hy, hz) {
    new GLTFLoader().load(
      `./${file}`,
      (gltf) => {
        if (this._disposed) return;
        const model = gltf.scene;
        const bbox = new THREE.Box3().setFromObject(model);
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        const s = (hy * 2) / (size.y || 1);
        model.scale.setScalar(s);
        model.position.set(-center.x * s, -center.y * s, -center.z * s);

        const byName = {};
        model.traverse((c) => {
          if (!c.isMesh) return;
          c.castShadow = true; c.receiveShadow = true; c.matrixAutoUpdate = true;
          c.material = c.material.clone(); // isolate per-part so browning/slide don't bleed
          byName[c.name] = c;
        });
        const t1 = byName.Tier1, t2 = byName.Tier2, t3 = byName.Tier3, cherry = byName.Cherry;
        if (!(t1 && t2 && t3 && cherry)) {
          console.warn(`Cargo: ${file} is missing Tier/Cherry nodes — keeping procedural cake.`);
          return;
        }

        // Drop the procedural placeholder cake.
        for (const p of this.cakeAllParts) {
          this.visual.remove(p);
          p.traverse((c) => { if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); } });
        }

        // Re-parent each frosting ring under its tier (attach preserves world
        // transform) so it tilts/squishes with the tier during the collapse.
        const linkFrost = (tier, ring) => { if (ring) { tier.attach(ring); tier._frostRing = ring; } };
        linkFrost(t1, byName.Frost1);
        linkFrost(t2, byName.Frost2);
        linkFrost(t3, byName.Frost3);

        this.tier1 = t1; this.tier2 = t2; this.tier3 = t3; this.cherry = cherry;
        this.cakeAllParts = [t1, t2, t3, cherry];
        this.visual.add(model);
        this.modelMesh = model;

        // Catch the model up to any damage already taken before it loaded.
        if (this.broken) this.#ruin();
        else if (this.damage > 0) this.#applyCakeStage();
      },
      undefined,
      (err) => console.warn(`Cargo: ${file} failed to load — using procedural cake.`, err)
    );
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

    // Liquid cargo: any solid knock throws a splash, scaled by how hard.
    if (this.waterFX) {
      const intensity = THREE.MathUtils.clamp(over / (this.impactThreshold * 1.5), 0.35, 1);
      this.#emitSplash(Math.round(8 + intensity * 16), intensity);
    }
    // Live animals: a knock startles them — a puff of feathers escapes.
    if (b.failKind === 'escape') {
      const intensity = THREE.MathUtils.clamp(over / (this.impactThreshold * 1.5), 0.3, 1);
      this.#emitFeathers(Math.round(4 + intensity * 6), intensity);
    }

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
      this.#emitSteam(8, 1); // pressure-release burst the moment it's primed
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

  // Box stage: scuff/darken progressively, reveal cracks once damaged. Works on
  // the placeholder's single material or every material of a loaded GLB.
  #applyBoxStage() {
    if (!this._tintTargets) return;
    if (this.damage >= DAMAGED_AT && this.crackMesh) this.crackMesh.visible = true;
    const f = THREE.MathUtils.clamp((this.damage - DAMAGED_AT) / (RUINED_AT - DAMAGED_AT), 0, 1);
    for (const t of this._tintTargets) t.mat.color.copy(t.base).lerp(this._scuffColor, f * 0.7);
  }

  // Cake damage is shown by losing pieces, keyed to remaining integrity:
  //   ≤90 cherry falls · ≤70 frosting slides · ≤50 top tier gone · ≤20 disaster.
  #applyCakeStage() {
    const integ = this.integrity;

    // Cherry falls off at 90% (with a little frosting pop as it goes).
    if (this.cherry) this.cherry.visible = integ > 90;
    if (integ <= 90 && !this._fxCherryPop) {
      this._fxCherryPop = true;
      this.#emitFrosting(6, 0.5);
    }

    // Frosting slides at 70%: shove the rings sideways and tint them.
    if (integ <= 70 && !this._frostSlid) {
      this._frostSlid = true;
      this.#emitFrosting(10, 0.7);
      for (const tier of [this.tier1, this.tier2, this.tier3]) {
        if (tier && tier._frostRing) {
          tier._frostRing.position.x += 0.06;
          tier._frostRing.material.color.offsetHSL(0, -0.1, -0.08);
        }
      }
    }

    // Top tier gone at 50%.
    if (this.tier3) this.tier3.visible = integ > 50;
    if (integ <= 50 && !this._fxTierPop) {
      this._fxTierPop = true;
      this.#emitFrosting(14, 0.9);
    }

    // Disaster at 20%: second tier slumps and everything browns.
    if (integ <= 20 && !this._disaster) {
      this._disaster = true;
      this.#emitFrosting(18, 1);
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
      // Total collapse: flatten and brown the whole thing, frosting everywhere.
      this.#emitFrosting(24, 1);
      this._disaster = true;
      if (this.tier3) this.tier3.visible = false;
      if (this.cherry) this.cherry.visible = false;
      if (this.tier2) { this.tier2.scale.y = 0.4; this.tier2.rotation.z = 0.7; }
      if (this.tier1) this.tier1.scale.y = 0.6;
      this.visual.traverse((c) => {
        if (c.isMesh) c.material.color.set(0x5a4a30);
      });
    } else if (this._tintTargets && this._tintTargets.length) {
      // Box wreck visual depends on HOW it died. `paint` recolours every tinted
      // material (placeholder box OR all of a loaded GLB's parts).
      const kind = this.failKind || this.behavior.failKind || 'crush';
      if (this.crackMesh) this.crackMesh.visible = true;
      const paint = (hex) => { for (const t of this._tintTargets) t.mat.color.set(hex); };
      switch (kind) {
        case 'shatter': // collapse into a small dark heap + fling glass shards
          this.visual.scale.set(0.9, 0.25, 0.9);
          paint(0x4a5560);
          this.#emitShards();
          break;
        case 'explode': // blown flat + scorched, debris spread wide
          this.visual.scale.set(1.5, 0.2, 1.5);
          paint(0x201813);
          this.visual.rotation.z = (Math.random() - 0.5) * 0.8;
          break;
        case 'spill': // emptied out — squat and darkened (water gone)
          this.visual.scale.y = 0.5;
          paint(0x244a5a);
          if (this.waterMesh) this.waterMesh.visible = false; // it all sloshed out
          this.#emitSplash(36, 1); // a final big gush
          break;
        case 'escape': // crate flung open and empty — feathers EVERYWHERE
          this.visual.scale.set(1.05, 1.05, 1.05);
          for (const t of this._tintTargets) { t.mat.transparent = true; t.mat.opacity = 0.25; }
          paint(0x6b5a44);
          this.#emitFeathers(28, 1);
          break;
        default: // crush
          paint(0x3b3128);
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
    // Cartoon pose on the visual child: wobble lean (cake) + shiver jitter
    // (sliding / idle shuffle / armed tremble) + landing squash-and-stretch.
    // Skipped once broken — the wreck pose owns the visual transform then.
    if (!this.broken) {
      this.visual.rotation.set(
        (this.isCake ? this.wobbleX : 0) + this._shiverX,
        0,
        (this.isCake ? this.wobbleZ : 0) + this._shiverZ
      );
      const sq = this.squash;
      this.visual.scale.set(1 + sq * SQUASH_XZ, 1 - sq * SQUASH_Y, 1 + sq * SQUASH_XZ);
    }
    // Tilt just the water surface for the slosh (the glass tank stays rigid).
    if (this.waterMesh) this.waterMesh.rotation.set(this.sloshX, 0, this.sloshZ);
  }

  // Damage / age / wobble logic — runs on the fixed physics step.
  update(dt) {
    this.age += dt;
    const t = this.body.translation();
    const r = this.body.rotation();

    if (this.isCake) this.#updateWobble(dt, r);
    if (this.waterMesh) this.#updateSlosh(dt, r);
    for (const fx of this._fx) fx.update(dt); // droplets/shards keep arcing even when broken

    // --- Cartoon reactions (run even during settle so the load-in thump reads) -
    // Landing squash: a sharp upward velocity jump after falling = a thump.
    const vy = this.body.linvel().y;
    const dvy = vy - this._prevVy;
    if (dvy > SQUASH_MIN_DVY && this._prevVy < -2) {
      this.squash = Math.min(1, Math.max(this.squash, (dvy - SQUASH_MIN_DVY) / SQUASH_DVY_RANGE));
    }
    this._prevVy = vy;
    this.squash *= Math.pow(SQUASH_DECAY, dt);

    // Slide amount: the cargo's horizontal speed relative to the truck.
    const cv = this.body.linvel();
    const tv = this.truck.body.linvel();
    this.slideSpeed = Math.hypot(cv.x - tv.x, cv.z - tv.z);
    this.slideAmount = THREE.MathUtils.clamp((this.slideSpeed - SLIDE_MIN) / SLIDE_RANGE, 0, 1);

    // Shiver: nervous jitter from sliding, idle shuffles, or a primed canister.
    let tremble = this.armed && !this.broken ? ARMED_TREMBLE : 0;
    if (this._idlePulse > 0) {
      tremble = Math.max(tremble, this._idlePulse * IDLE_AMP);
      this._idlePulse -= dt / IDLE_PULSE_SEC;
    }
    const jitter = this.broken ? 0 : this.slideAmount * SLIDE_JITTER + tremble;
    if (jitter > 0.0005) {
      this._shiverPhase += dt * SHIVER_HZ;
      this._shiverX = Math.sin(this._shiverPhase * 1.13) * jitter;
      this._shiverZ = Math.sin(this._shiverPhase) * jitter;
    } else {
      this._shiverX = this._shiverZ = 0;
    }

    if (this.broken || this.age < this.settleTime) return;

    // --- Idle character + type FX (only while alive and settled) --------------
    const bb = this.behavior;
    // Live animals shuffle around inside the crate every few seconds.
    if (bb.idleShuffle) {
      this._idleTimer -= dt;
      if (this._idleTimer <= 0) {
        this._idleTimer = IDLE_MIN_SEC + Math.random() * IDLE_VAR_SEC;
        this._idlePulse = 1;
        this.#emitFeathers(2, 0.3);
      }
    }
    // A primed canister hisses a steady stream of steam.
    if (this.armed) {
      this._steamCd -= dt;
      if (this._steamCd <= 0) {
        this._steamCd = STEAM_INTERVAL;
        this.#emitSteam(1, 0.5);
      }
    }

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
      // Feathers squeeze out of a tipping animal crate as panic builds.
      if (b.failKind === 'escape' && this.tipProgress > 0.3) {
        this._featherCd -= dt;
        if (this._featherCd <= 0) {
          this._featherCd = FEATHER_TIP_INTERVAL;
          this.#emitFeathers(2, 0.3 + this.tipProgress * 0.7);
        }
      }
      if (this.tipTime >= timeout) { this.failBy(b.failKind || 'spill'); return; }
    }

    // Fell off the bed / off the world.
    const truckPos = this.truck.position;
    const horiz = Math.hypot(t.x - truckPos.x, t.z - truckPos.z);
    if (t.y < -3 || horiz > 6) this.addDamage(100);
  }

  // Body-local horizontal acceleration (x = lateral, z = forward), from the
  // change in linear velocity this step. Shared by the cake wobble and the
  // water slosh. Mutates `this._accel` and returns it.
  #computeBodyAccel(dt, r) {
    const v = this.body.linvel();
    this._accel.set((v.x - this._prevVel.x) / dt, 0, (v.z - this._prevVel.z) / dt);
    this._prevVel.x = v.x; this._prevVel.y = v.y; this._prevVel.z = v.z;
    this._q.set(r.x, r.y, r.z, r.w).conjugate(); // world accel → body-local
    return this._accel.applyQuaternion(this._q);
  }

  // Damped-spring lean driven by the cargo body's acceleration, expressed in the
  // body-local frame so it leans back under throttle and sideways in turns.
  #updateWobble(dt, r) {
    const a = this.#computeBodyAccel(dt, r);
    const K = 0.018, MAX = 0.4;
    const targetX = THREE.MathUtils.clamp(-a.z * K, -MAX, MAX); // pitch from fwd accel
    const targetZ = THREE.MathUtils.clamp(a.x * K, -MAX, MAX);  // roll from lateral accel
    const k = 140, damp = 13;
    this.wVelX += ((targetX - this.wobbleX) * k - this.wVelX * damp) * dt;
    this.wobbleX += this.wVelX * dt;
    this.wVelZ += ((targetZ - this.wobbleZ) * k - this.wVelZ * damp) * dt;
    this.wobbleZ += this.wVelZ * dt;
  }

  // Water slosh: a softer, slower spring than the cake (water keeps moving after
  // the truck stops). Big slosh swings fling splash droplets out of the tank.
  #updateSlosh(dt, r) {
    const a = this.#computeBodyAccel(dt, r);
    const K = 0.05, MAX = 0.13; // ~7.5° max lean — clears the glass walls
    const targetX = THREE.MathUtils.clamp(-a.z * K, -MAX, MAX);
    const targetZ = THREE.MathUtils.clamp(a.x * K, -MAX, MAX);
    const k = 55, damp = 7; // low stiffness + light damping = lingering slosh
    this.sVelX += ((targetX - this.sloshX) * k - this.sVelX * damp) * dt;
    this.sloshX += this.sVelX * dt;
    this.sVelZ += ((targetZ - this.sloshZ) * k - this.sVelZ * damp) * dt;
    this.sloshZ += this.sVelZ * dt;
    // Hard-clamp the lean so a spring overshoot never pokes water through glass.
    const CAP = 0.12; // ~6.9°, inside the modelled clearance
    this.sloshX = THREE.MathUtils.clamp(this.sloshX, -CAP, CAP);
    this.sloshZ = THREE.MathUtils.clamp(this.sloshZ, -CAP, CAP);

    // Splash over the rim only on a genuinely hard slosh, throttled.
    this._splashCd -= dt;
    const sloshSpeed = Math.hypot(this.sVelX, this.sVelZ);
    if (this._splashCd <= 0 && sloshSpeed > 1.8 && !this.broken) {
      this._splashCd = 0.1;
      const intensity = THREE.MathUtils.clamp((sloshSpeed - 1.8) / 3, 0.2, 1);
      this.#emitSplash(Math.round(2 + intensity * 6), intensity);
    }
  }

  // Lazily create (and cache) a per-type particle system. Only cargo that
  // actually uses an effect pays for it; all are ticked/disposed via `_fx`.
  #getFX(key, opts) {
    if (!this._fxByKey[key]) {
      const fx = new BurstFX(this.scene, opts);
      this._fxByKey[key] = fx;
      this._fx.push(fx);
    }
    return this._fxByKey[key];
  }

  // Emit a burst from the cargo at `yFrac` of its half-height (1 = top).
  // `carry` is how much of the body's own velocity the bits inherit, so they
  // trail the moving truck instead of being left behind.
  #emitBurst(fx, count, intensity, yFrac = 0.6, carry = 0.5) {
    const t = this.body.translation();
    const r = this.body.rotation();
    this._tmpQ.set(r.x, r.y, r.z, r.w);
    const pos = this._tmpVec.set(
      (Math.random() - 0.5) * this.halfH * 0.7,
      this.halfH * yFrac,
      (Math.random() - 0.5) * this.halfH * 0.7,
    ).applyQuaternion(this._tmpQ).add(new THREE.Vector3(t.x, t.y, t.z));
    const v = this.body.linvel();
    const baseVel = new THREE.Vector3(v.x * carry, Math.max(0, v.y) * carry, v.z * carry);
    fx.burst(pos, baseVel, count, intensity);
  }

  // Fling droplets from the waterline (liquid cargo only).
  #emitSplash(count, intensity, carry = 0.6) {
    if (!this.waterFX) return;
    this.#emitBurst(this.waterFX, count, intensity, 0.66, carry);
  }

  // Pink frosting blobs whenever the cake loses a piece.
  #emitFrosting(count, intensity) {
    if (!this.isCake) return;
    const fx = this.#getFX('frosting', {
      color: this.delivery.color, opacity: 0.95, roughness: 0.5, max: 40,
      geometry: new THREE.IcosahedronGeometry(0.06, 0),
      upSpeed: [1.4, 3.4], spread: 2.0, lifeRange: [0.5, 0.95],
    });
    this.#emitBurst(fx, count, intensity, 0.8);
  }

  // Fluttering feathers for live-animal crates (slow fall, tumbling planes).
  #emitFeathers(count, intensity) {
    const fx = this.#getFX('feathers', {
      color: 0xf7f3e8, opacity: 0.95, roughness: 0.9, max: 36,
      spin: true, doubleSide: true, gravity: -3.5,
      geometry: new THREE.PlaneGeometry(0.15, 0.06),
      upSpeed: [0.9, 2.4], spread: 1.6, lifeRange: [0.9, 1.7],
    });
    this.#emitBurst(fx, count, intensity, 0.9, 0.6);
  }

  // Thin steam puffs hissing from a primed gas canister.
  #emitSteam(count, intensity) {
    const fx = this.#getFX('steam', {
      color: 0xd8dee2, opacity: 0.65, roughness: 1.0, max: 30,
      gravity: 2.5, // steam rises
      geometry: new THREE.IcosahedronGeometry(0.05, 0),
      upSpeed: [0.7, 1.5], spread: 0.5, lifeRange: [0.5, 0.9],
    });
    this.#emitBurst(fx, count, intensity, 1.0, 0.8);
  }

  // One-shot burst of tumbling glass shards when the cargo shatters. The FX is
  // created on demand (only shattering cargo pays for it) and ticked/disposed
  // through `this._fx` like the splashes.
  #emitShards() {
    const fx = new BurstFX(this.scene, {
      color: this.delivery.color, opacity: 0.85, roughness: 0.1, max: 48, spin: true,
      geometry: new THREE.TetrahedronGeometry(0.08, 0),
      upSpeed: [1.0, 3.5], spread: 3.2, lifeRange: [0.5, 1.0],
    });
    this._fx.push(fx);
    const t = this.body.translation();
    const center = this._tmpVec.set(t.x, t.y + this.halfH * 0.3, t.z);
    const v = this.body.linvel();
    const baseVel = new THREE.Vector3(v.x * 0.4, 0, v.z * 0.4);
    fx.burst(center, baseVel, 40, 1);
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
    this._disposed = true; // a still-in-flight model load will no-op on resolve
    for (const fx of this._fx) fx.dispose();
    this._fx = []; this.waterFX = null;
    this.physics.remove(this.body);
    this.scene.remove(this.mesh);
    this.mesh.traverse((c) => {
      if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
    });
  }
}
