import * as THREE from 'three';
import { RAPIER } from '../core/Physics.js';

// A single cargo item riding on the truck bed. Damage accrues from:
//   - hard impacts (contact-force events, scaled by fragility)
//   - tipping past a threshold angle (tall/heavy cargo)
//   - falling off the truck / off the world
// Optional "straps" (a spring joint to the chassis) keep it from sliding.
const UP = new THREE.Vector3(0, 1, 0);
// Resting Z of the cargo on the truck bed, in truck-local space. The GLB's open
// bed runs from the tailgate (z ≈ -1.58) to the cab's rear wall (z ≈ -0.25), so
// it is centred around z ≈ -0.9. Cargo footprints are capped (see deliveries.js
// size[2] ≤ 0.6) so their front face stays behind the cab and never clips it.
const BED_Z = -0.95;

export class Cargo {
  constructor(scene, physics, delivery, truck) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.delivery = delivery;
    this.truck = truck;
    this.damage = 0;           // 0..100
    this.broken = false;
    this.age = 0;              // seconds since spawn
    this.settleTime = 0.9;     // grace period while truck + cargo settle
    this._localUp = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    // Render-interpolation buffers (mirror the Truck) so the cargo glides at the
    // same cadence as the smoothly-interpolated truck instead of snapping to raw
    // 60 Hz physics positions — that mismatch made the cargo appear to vibrate.
    this._prevT = null;
    this._prevR = null;
    this._interpQ = new THREE.Quaternion();
    this._currQ = new THREE.Quaternion();

    const [hx, hy, hz] = delivery.size;
    this.halfH = hy;
    // Spawn resting on the bed, just behind the cab. Bed floor is at the chassis
    // half-height (0.3) in truck-local space.
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
      // High angular damping resists tipping from a single bump; tall/heavy
      // cargo can still roll over under sustained chaos.
      .setAngularDamping(2.5)
      .setCanSleep(false);
    this.body = this.world.createRigidBody(desc);

    const mass = delivery.mass;
    this.mass = mass;
    this.fragility = delivery.fragility;
    // Resting weight is ~mass*gravity (≈mass*20). Set the event threshold well
    // above that so simply sitting on the bed — or gentle jostling at low speed —
    // is free; only genuine hard impacts generate damage events.
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

  #buildMesh(hx, hy, hz) {
    this.mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      new THREE.MeshStandardMaterial({ color: this.delivery.color, roughness: 0.7 })
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.scene.add(this.mesh);

    // Strap bands wrapped over the top (cosmetic).
    const strapMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.8 });
    for (const z of [-hz * 0.5, hz * 0.5]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(hx * 2.1, hy * 2.1, 0.08), strapMat);
      band.position.z = z;
      this.mesh.add(band);
    }
  }

  #attachStraps() {
    // A spring joint holds the cargo's centre at its resting spot on the bed.
    // Even with no straps purchased there's a baseline tie-down so cargo doesn't
    // simply fly off the first bump; the upgrade makes it markedly stiffer, so
    // rough routes wobble (and damage) far less. The spring still allows visible
    // sway and tipping — that's the chaos.
    const strength = this.truck.tuning.straps; // 40 baseline, higher with upgrade
    // Anchor low — bed floor on the truck, cargo's underside on the cargo — so
    // the strap acts near both centres of mass and doesn't torque/flip the truck.
    const anchorTruck = { x: 0, y: this.bedFloor, z: BED_Z };
    const anchorCargo = { x: 0, y: -this.halfH, z: 0 };
    const stiffness = strength * 120;
    const damping = strength * 8;
    const params = RAPIER.JointData.spring(0.0, stiffness, damping, anchorTruck, anchorCargo);
    this.joint = this.world.createImpulseJoint(params, this.truck.body, this.body, true);
  }

  // Register an impact reported by the physics contact-force events. Only the
  // force *above* the threshold counts, normalised by mass so heavy and light
  // cargo scale alike; fragile cargo takes proportionally more.
  registerImpact(magnitude) {
    if (this.broken || this.age < this.settleTime) return;
    const over = magnitude - this.impactThreshold;
    if (over <= 0) return;
    const dmg = (over / this.mass) * this.fragility * 0.025;
    if (dmg > 0.1) this.addDamage(dmg);
  }

  addDamage(amount) {
    this.damage = Math.min(100, this.damage + amount);
    if (this.damage >= 100 && !this.broken) this.#break();
  }

  #break() {
    this.broken = true;
    this.mesh.material.color.set(0x444444);
    this.mesh.material.transparent = true;
    this.mesh.material.opacity = 0.6;
  }

  // Snapshot the body transform immediately before a physics step, so sync()
  // can interpolate between the two most recent states (matches the Truck).
  capturePreStepState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this._prevT = { x: t.x, y: t.y, z: t.z };
    this._prevR = { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  // Interpolated visual update — call once per render frame with the same alpha
  // (accumulator / FIXED) the truck uses, so both move in lockstep.
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
  }

  // Damage / age logic — runs on the fixed physics step (not the render frame).
  update(dt) {
    this.age += dt;
    const t = this.body.translation();
    const r = this.body.rotation();

    if (this.broken || this.age < this.settleTime) return;

    // Tipping: how far the cargo's local up has rolled from world up. Only a
    // real lean-over (past ~55°) does damage, and gently — a quick wobble is fine.
    this._localUp.copy(UP).applyQuaternion(this._q.set(r.x, r.y, r.z, r.w));
    const tilt = this._localUp.angleTo(UP); // radians
    if (tilt > 0.95) {
      this.addDamage((tilt - 0.95) * 6 * dt);
    }

    // Fell off the bed / off the world.
    const truckPos = this.truck.position;
    const horiz = Math.hypot(t.x - truckPos.x, t.z - truckPos.z);
    if (t.y < -3 || horiz > 6) {
      this.addDamage(100); // gone — total loss
    }
  }

  // Snap the cargo back to its resting spot on the bed, using the truck's
  // current body transform. Used when the player presses R to recover, so the
  // strapped cargo travels with the truck instead of being left under it.
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
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}
