import * as THREE from 'three';
import { RAPIER } from '../core/Physics.js';

// A single cargo item riding on the truck bed. Damage accrues from:
//   - hard impacts (contact-force events, scaled by fragility)
//   - tipping past a threshold angle (tall/heavy cargo)
//   - falling off the truck / off the world
// Optional "straps" (a spring joint to the chassis) keep it from sliding.
//
// The WEDDING CAKE is special: it's built as a tiered cake that physically
// WOBBLES (an acceleration-driven damped spring layered on top of the physics
// body) and visibly sheds pieces as it takes damage — cherry, then a sliding
// frosting tier, then the top layer, then collapse. Visual feedback > numbers.
const UP = new THREE.Vector3(0, 1, 0);
// Resting Z of the cargo on the truck bed, in truck-local space (see notes in
// the original build — the GLB bed is centred around z ≈ -0.9).
const BED_Z = -0.95;

export class Cargo {
  constructor(scene, physics, delivery, truck) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.delivery = delivery;
    this.truck = truck;
    this.isCake = delivery.id === 'cake';
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
      .setLinearDamping(0.4)
      .setAngularDamping(2.5)
      .setCanSleep(false);
    this.body = this.world.createRigidBody(desc);

    const mass = delivery.mass;
    this.mass = mass;
    this.fragility = delivery.fragility;
    this.impactThreshold = mass * 60;

    const col = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setMass(mass)
      .setFriction(0.9)
      .setRestitution(0.1)
      .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(this.impactThreshold);
    this.physics.tag(this.world.createCollider(col, this.body), 'cargo');

    this.#buildMesh(hx, hy, hz);
    this.#attachStraps();
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

  #attachStraps() {
    const strength = this.truck.tuning.straps;
    const anchorTruck = { x: 0, y: this.bedFloor, z: BED_Z };
    const anchorCargo = { x: 0, y: -this.halfH, z: 0 };
    const stiffness = strength * 120;
    const damping = strength * 8;
    const params = RAPIER.JointData.spring(0.0, stiffness, damping, anchorTruck, anchorCargo);
    this.joint = this.world.createImpulseJoint(params, this.truck.body, this.body, true);
  }

  registerImpact(magnitude) {
    if (this.broken || this.age < this.settleTime) return;
    const over = magnitude - this.impactThreshold;
    if (over <= 0) return;
    const dmg = (over / this.mass) * this.fragility * 0.025;
    if (dmg > 0.1) this.addDamage(dmg);
  }

  addDamage(amount) {
    const before = this.damage;
    this.damage = Math.min(100, this.damage + amount);
    if (this.isCake && this.damage !== before) this.#applyDamageStage();
    if (this.damage >= 100 && !this.broken) this.#break();
  }

  // Cake damage is shown by losing pieces, keyed to remaining integrity:
  //   ≤90 cherry falls · ≤70 frosting slides · ≤50 top tier gone · ≤20 disaster.
  #applyDamageStage() {
    const integ = this.integrity;
    if (!this.isCake) return;

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

  #break() {
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
      this.boxMesh.material.color.set(0x444444);
      this.boxMesh.material.transparent = true;
      this.boxMesh.material.opacity = 0.6;
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
    if (this.joint) this.world.removeImpulseJoint(this.joint, true);
    this.physics.remove(this.body);
    this.scene.remove(this.mesh);
    this.mesh.traverse((c) => {
      if (c.isMesh) { c.geometry.dispose(); c.material.dispose(); }
    });
  }
}
