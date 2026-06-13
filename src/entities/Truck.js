import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RAPIER } from '../core/Physics.js';

// Rusty Pickup built on Rapier's DynamicRayCastVehicleController.
// A dynamic cuboid chassis with four raycast wheels; engine force drives all
// four wheels (AWD), steering turns the front. Tuning comes from purchased upgrades.
const CHASSIS = { hx: 0.95, hy: 0.3, hz: 2.0 };
const WHEEL_RADIUS = 0.35;
const REST = 0.45;     // suspension rest length
const CONN_Y = 0.1;    // wheel mount height above chassis centre (gives ground clearance)
const CHASSIS_MASS = 300; // kg — heavier than any cargo, for stability
const MAX_STEER = 0.55;

// ---- Body-feel tunables (visual-only lean/bounce on the cab model) ---------
// The physics chassis stays untouched; the GLB model inside the group leans
// and bounces on top of it for cartoon body language.
const LEAN_ROLL_MAX = 0.085;   // max roll into a turn (rad)
const LEAN_PITCH_MAX = 0.06;   // max pitch under throttle/brake (rad)
const LEAN_PITCH_PER_ACCEL = 0.012; // pitch per m/s² of longitudinal accel
const LEAN_SPRING_K = 60;      // lean spring stiffness
const LEAN_SPRING_DAMP = 9;    // lean spring damping
const BOUNCE_MIN_FALL = 2.6;   // fall speed (m/s) that earns a landing bounce
const BOUNCE_KICK = 0.10;      // bounce velocity impulse per m/s of fall past the min
const BOUNCE_KICK_MAX = 0.5;   // cap on a single landing's kick
const BOUNCE_MAX = 0.07;       // clamp on the visual bounce offset (m)
const BOUNCE_SPRING_K = 60;    // bounce spring stiffness (softer = fatter bounce)
const BOUNCE_SPRING_DAMP = 9;  // bounce spring damping (higher = settles faster)

export class Truck {
  constructor(scene, physics, startPos, tuning) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.tuning = tuning;
    this.start = startPos.clone();
    this.steerAngle = 0;

    // Visual body-feel springs (lean into turns, pitch under throttle/brake,
    // bounce on landings) — applied to the cab model only, never the physics.
    this._leanRoll = 0; this._leanRollV = 0;
    this._leanPitch = 0; this._leanPitchV = 0;
    this._bounce = 0; this._bounceV = 0;
    this._prevVy = 0;
    this._prevSignedSpeed = 0;
    // Last control inputs, read by WheelParticles for launch/skid dust.
    this.lastThrottle = 0;
    this.lastBrake = false;

    // Interpolation state: prev/curr body transforms saved around physics steps.
    this._prevT = null;
    this._prevR = null;
    this._interpQ = new THREE.Quaternion();
    this._currQ  = new THREE.Quaternion();

    this.#buildBody(startPos);
    this.#buildMesh();
    this.#buildWheels();
    // Place the mesh group at the body's start transform so the camera snap on
    // the first frame reads a valid position (group defaults to the origin).
    this.sync(1);
  }

  #buildBody(pos) {
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(0.2)
      .setAngularDamping(0.8) // resists the backflip torque from drive + tall cargo
      .setCanSleep(false);
    this.body = this.world.createRigidBody(desc);

    // Chassis collider. A heavy chassis (heavier than most cargo) keeps the
    // truck planted; the explicit mass overrides the geometric density.
    const colDesc = RAPIER.ColliderDesc.cuboid(CHASSIS.hx, CHASSIS.hy, CHASSIS.hz)
      .setTranslation(0, 0, 0)
      .setFriction(0.6)
      .setMass(CHASSIS_MASS);
    this.physics.tag(this.world.createCollider(colDesc, this.body), 'truck');

    // Low bed rim so cargo is loosely contained but can still spill in chaos.
    const wall = (x, z, hx, hz) => {
      const d = RAPIER.ColliderDesc.cuboid(hx, 0.2, hz)
        .setTranslation(x, CHASSIS.hy + 0.2, z)
        .setFriction(0.8);
      this.physics.tag(this.world.createCollider(d, this.body), 'truck');
    };
    wall(0, CHASSIS.hz - 0.1, CHASSIS.hx, 0.1);   // front of bed (behind cab)
    wall(0, -CHASSIS.hz + 0.1, CHASSIS.hx, 0.1);  // tailgate
    wall(-CHASSIS.hx + 0.1, 0.4, 0.1, CHASSIS.hz - 0.4);
    wall(CHASSIS.hx - 0.1, 0.4, 0.1, CHASSIS.hz - 0.4);

    this.controller = this.world.createVehicleController(this.body);

    const dir = { x: 0, y: -1, z: 0 };
    const axle = { x: -1, y: 0, z: 0 };
    const wheelX = CHASSIS.hx - 0.05;
    const wheelZ = CHASSIS.hz - 0.55;
    // Order: 0 FL, 1 FR, 2 RL, 3 RR
    this.wheelPoints = [
      { x: -wheelX, y: CONN_Y, z: wheelZ },
      { x: wheelX, y: CONN_Y, z: wheelZ },
      { x: -wheelX, y: CONN_Y, z: -wheelZ },
      { x: wheelX, y: CONN_Y, z: -wheelZ },
    ];
    for (const p of this.wheelPoints) {
      this.controller.addWheel(p, dir, axle, REST, WHEEL_RADIUS);
    }
    this.applyTuning(this.tuning);
  }

  applyTuning(tuning) {
    this.tuning = tuning;
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelSuspensionStiffness(i, tuning.suspension);
      this.controller.setWheelMaxSuspensionTravel(i, 0.4);
      // Strong damping (well above the raw "shocks" value) stops the stiff
      // springs from launching the light chassis after a compression.
      this.controller.setWheelSuspensionCompression(i, tuning.shocks * 2 + 3.5);
      this.controller.setWheelSuspensionRelaxation(i, tuning.shocks * 2 + 3.0);
      this.controller.setWheelFrictionSlip(i, tuning.tires);
      this.controller.setWheelMaxSuspensionForce(i, 1000000);
      // Mostly grippy & controllable, with just a hint of rear looseness for
      // character (rear a touch lower than front). Not a drift machine.
      this.controller.setWheelSideFrictionStiffness(i, i >= 2 ? 0.85 : 1.0);
    }
  }

  // Scale tyre grip by a multiplier (e.g. <1 on mud) so the truck slides when
  // traction is low. Cached so we only touch the controller on change.
  applyGrip(mult) {
    if (this._grip === mult) return;
    this._grip = mult;
    for (let i = 0; i < 4; i++) {
      this.controller.setWheelFrictionSlip(i, this.tuning.tires * mult);
      this.controller.setWheelSideFrictionStiffness(i, (i >= 2 ? 0.85 : 1.0) * mult);
    }
  }

  #buildMesh() {
    this.group = new THREE.Group();
    // The cab model + placeholders live inside this wrapper so the body-feel
    // lean/bounce can pose them without fighting the physics-driven group.
    this.bodyVisual = new THREE.Group();
    this.group.add(this.bodyVisual);
    const bodyMat = new THREE.MeshStandardMaterial({ color: this.tuning.color ?? 0x3a78c2, roughness: 0.6, metalness: 0.2 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.7 });

    // --- Placeholder geometry (shown until Car1.glb loads) ---
    // Flatbed base.
    const base = new THREE.Mesh(new THREE.BoxGeometry(CHASSIS.hx * 2, CHASSIS.hy * 2, CHASSIS.hz * 2), bodyMat);
    base.castShadow = true;
    this._placeholders = [base];
    this.bodyVisual.add(base);

    // Cab over the front third.
    const cab = new THREE.Mesh(new THREE.BoxGeometry(CHASSIS.hx * 1.9, 0.7, 1.1), bodyMat);
    cab.position.set(0, CHASSIS.hy + 0.35, CHASSIS.hz - 0.7);
    cab.castShadow = true;
    this._placeholders.push(cab);
    this.bodyVisual.add(cab);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.hx * 1.7, 0.4, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x9fd8ef, roughness: 0.2, metalness: 0.4 })
    );
    glass.position.set(0, CHASSIS.hy + 0.45, CHASSIS.hz - 0.15);
    this._placeholders.push(glass);
    this.bodyVisual.add(glass);

    // Bed rim (visual to match the colliders).
    const mkRim = (x, y, z, w, h, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this._placeholders.push(m);
      this.bodyVisual.add(m);
    };
    mkRim(0, CHASSIS.hy + 0.2, -CHASSIS.hz + 0.1, CHASSIS.hx * 2, 0.4, 0.2);
    mkRim(-CHASSIS.hx + 0.1, CHASSIS.hy + 0.2, 0.4, 0.2, 0.4, (CHASSIS.hz - 0.4) * 2);
    mkRim(CHASSIS.hx - 0.1, CHASSIS.hy + 0.2, 0.4, 0.2, 0.4, (CHASSIS.hz - 0.4) * 2);

    this.scene.add(this.group);

    // Placeholder wheel meshes (children of scene, positioned each frame).
    const wheelGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.3, 16);
    wheelGeo.rotateZ(Math.PI / 2);
    this.wheelMeshes = this.wheelPoints.map(() => {
      const m = new THREE.Mesh(wheelGeo, darkMat);
      m.castShadow = true;
      this.scene.add(m);
      return m;
    });

    // Resolves once the truck's visual is settled (real model in, or the
    // placeholder revealed as fallback) — the loading bar waits on this.
    this.ready = new Promise((res) => { this._markReady = res; });

    // Keep the placeholder hidden so the player never sees the blocky stand-in
    // pop into the real truck — Car1.glb is preloaded, so it appears almost
    // instantly. A short fallback reveals the placeholder only if the model is
    // unusually slow (or fails) so the truck is never invisible for long.
    this.bodyVisual.visible = false;
    for (const w of this.wheelMeshes) w.visible = false;
    this._phFallback = setTimeout(() => {
      if (this._placeholders.length) {
        this.bodyVisual.visible = true;
        for (const w of this.wheelMeshes) w.visible = true;
      }
      this._markReady?.();
    }, 500);

    // --- Load Car1.glb and replace placeholder when ready ---
    const loader = new GLTFLoader();
    loader.load('./Car1.glb', (gltf) => {
      clearTimeout(this._phFallback);
      // Remove all placeholder children from the body-visual wrapper.
      for (const ph of this._placeholders) this.bodyVisual.remove(ph);
      this._placeholders = [];

      const model = gltf.scene;

      // Auto-scale: fit the longest horizontal dimension to the chassis length (4 m).
      const box = new THREE.Box3().setFromObject(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const targetLen = CHASSIS.hz * 2; // 4 m
      const scale = targetLen / Math.max(size.x, size.z);
      model.scale.setScalar(scale);

      // Centre the model horizontally.
      // Y: drop the model so its bounding-box floor sits at approximately wheel
      // contact height in the chassis body's local frame
      // (WHEEL_RADIUS + REST - CONN_Y ≈ 0.70 below chassis centre).
      const scaledMinY = box.min.y * scale;
      const wheelContactLocal = WHEEL_RADIUS + REST - CONN_Y; // ~0.70
      model.position.set(
        -center.x * scale,
        -scaledMinY - wheelContactLocal,
        -center.z * scale
      );
      // The GLB's front faces +Z (toward camera) but the truck drives toward +Z,
      // so flip 180° around Y to make the car face the correct driving direction.
      // Model's front faces -Z in the GLB; flip 180° so it faces +Z (driving direction).
      model.rotation.y = Math.PI;

      // Find and cache all four wheel nodes by name.
      this._wheelFL = null;
      this._wheelFR = null;
      this._wheelBL = null;
      this._wheelBR = null;
      model.traverse((child) => {
        // Three.js sanitises GLB node names (spaces → underscores), and the
        // model has been re-exported a few times, so match on keywords rather
        // than exact strings. Normalise to lowercase alphanumerics.
        const n = child.name.toLowerCase();
        if (n.includes('wheel') || n.includes('whell')) {
          if (n.includes('front') && n.includes('left'))  this._wheelFL = child;
          else if (n.includes('front') && n.includes('right')) this._wheelFR = child;
          else if (n.includes('back2')) this._wheelBL = child;
          else if (n.includes('back'))  this._wheelBR = child;
        }
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = false;
        }
      });
      // Force matrixAutoUpdate on every wheel node (and its mesh children).
      // GLTFLoader can leave nodes with pre-baked matrices and autoUpdate off,
      // which makes quaternion/rotation changes invisible.
      const activateMatrix = (obj) => {
        obj.matrixAutoUpdate = true;
        obj.children.forEach(activateMatrix);
      };
      [this._wheelFL, this._wheelFR, this._wheelBL, this._wheelBR]
        .filter(Boolean).forEach(activateMatrix);


      this.bodyVisual.add(model);
      this._glbModel = model;

      // Hide placeholder wheels — the GLB has its own wheels baked in.
      for (const w of this.wheelMeshes) w.visible = false;
      // Reveal the now-real truck (the body was hidden during loading).
      this.bodyVisual.visible = true;
      this._markReady?.();

    }, undefined, (err) => {
      console.warn('Car1.glb failed to load — using placeholder geometry.', err);
      clearTimeout(this._phFallback);
      this.bodyVisual.visible = true;
      for (const w of this.wheelMeshes) w.visible = true;
      this._markReady?.();
    });
  }

  #buildWheels() {
    this._tmpV = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    // Pre-allocated quaternions for GLB wheel animation — no per-frame allocation.
    this._steerQ    = new THREE.Quaternion();
    this._rollQ     = new THREE.Quaternion();
    this._combinedQ = new THREE.Quaternion();
    this._Y_AXIS    = new THREE.Vector3(0, 1, 0);
    this._X_AXIS    = new THREE.Vector3(1, 0, 0);
  }

  // --- Interpolation helpers -------------------------------------------

  // Call this ONCE per frame, BEFORE the fixed-step accumulator loop.
  // Saves the body's current transform so sync() can lerp from it.
  capturePreStepState() {
    const t = this.body.translation();
    const r = this.body.rotation();
    this._prevT = { x: t.x, y: t.y, z: t.z };
    this._prevR = { x: r.x, y: r.y, z: r.z, w: r.w };
  }

  // control: { throttle:-1..1, steer:-1..1, brake:bool }; dt seconds.
  update(control, dt) {
    // Smooth steering toward target for a less twitchy feel.
    const targetSteer = -control.steer * MAX_STEER;
    // Slightly more responsive than stock (dt*8) without being twitchy.
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * 9);

    // Cut drive force past the arcade top speed so the light chassis doesn't
    // run away. Only limits powered acceleration, not coasting/downhill.
    const overTop = this.speedKmh >= (this.tuning.topSpeed ?? 60);
    const force = overTop && control.throttle > 0 ? 0 : control.throttle * this.tuning.engineForce;
    // All-wheel drive — spreading torque across all four wheels avoids the
    // backflip a rear-only light truck suffers under hard acceleration.
    for (let i = 0; i < 4; i++) this.controller.setWheelEngineForce(i, force * 0.5);
    // Front-wheel steering.
    this.controller.setWheelSteering(0, this.steerAngle);
    this.controller.setWheelSteering(1, this.steerAngle);
    // Braking on all wheels.
    const brake = control.brake ? 12 : (control.throttle === 0 ? 0.6 : 0);
    for (let i = 0; i < 4; i++) this.controller.setWheelBrake(i, brake);

    this.controller.updateVehicle(dt);

    // Accumulate signed wheel roll: project velocity onto the body's forward (+Z)
    // so the wheels spin backward when reversing, and stop when stationary.
    const v = this.body.linvel();
    const r2 = this.body.rotation();
    this._tmpQ.set(r2.x, r2.y, r2.z, r2.w);
    // forward = body-local +Z in world space
    const fwdX = 2 * (this._tmpQ.x * this._tmpQ.z + this._tmpQ.w * this._tmpQ.y);
    const fwdZ = 1 - 2 * (this._tmpQ.x * this._tmpQ.x + this._tmpQ.y * this._tmpQ.y);
    const signedSpeed = v.x * fwdX + v.z * fwdZ; // positive = driving forward
    this._rollAngle = (this._rollAngle ?? 0) + (signedSpeed / WHEEL_RADIUS) * dt;

    // Remember inputs for the dust system (launch/skid emission).
    this.lastThrottle = control.throttle;
    this.lastBrake = control.brake;

    // --- Visual body feel (cab model only — physics untouched) --------------
    // Roll into turns: outward lean scaled by steering and speed.
    const sf = Math.min(1, this.speedKmh / (this.tuning.topSpeed ?? 60));
    const rollTarget = THREE.MathUtils.clamp(
      -this.steerAngle * 0.25 * (0.3 + 0.7 * sf), -LEAN_ROLL_MAX, LEAN_ROLL_MAX);
    // Pitch with longitudinal acceleration: nose up on throttle, dip on brake.
    const accel = (signedSpeed - this._prevSignedSpeed) / dt;
    this._prevSignedSpeed = signedSpeed;
    const pitchTarget = THREE.MathUtils.clamp(
      -accel * LEAN_PITCH_PER_ACCEL, -LEAN_PITCH_MAX, LEAN_PITCH_MAX);
    this._leanRollV += ((rollTarget - this._leanRoll) * LEAN_SPRING_K - this._leanRollV * LEAN_SPRING_DAMP) * dt;
    this._leanRoll += this._leanRollV * dt;
    this._leanPitchV += ((pitchTarget - this._leanPitch) * LEAN_SPRING_K - this._leanPitchV * LEAN_SPRING_DAMP) * dt;
    this._leanPitch += this._leanPitchV * dt;

    // Suspension bounce: track the deepest fall speed; the moment the fall
    // arrests (suspension caught it), dip the cab and let the spring rebound
    // with a cartoon overshoot. Robust even though the suspension spreads the
    // landing over many steps (a per-step dvy check misses it entirely).
    this._fallVy = Math.min(this._fallVy ?? 0, v.y);
    if (v.y > -0.5) {
      if (this._fallVy < -BOUNCE_MIN_FALL) {
        this._bounceV -= Math.min(BOUNCE_KICK_MAX, (-this._fallVy - BOUNCE_MIN_FALL) * BOUNCE_KICK);
      }
      this._fallVy = 0;
    }
    this._bounceV += (-this._bounce * BOUNCE_SPRING_K - this._bounceV * BOUNCE_SPRING_DAMP) * dt;
    this._bounce = THREE.MathUtils.clamp(this._bounce + this._bounceV * dt, -BOUNCE_MAX, BOUNCE_MAX);
  }

  // Called after the physics step to sync visuals.
  // alpha = accumulator / FIXED_TIMESTEP — interpolates between the pre-step
  // snapshot and the current body position, eliminating per-frame jitter caused
  // by physics running at 60 Hz while rendering may run faster or uneven.
  sync(alpha = 1) {
    const t = this.body.translation();
    const r = this.body.rotation();

    if (this._prevT && alpha < 0.999) {
      const a = alpha;
      this.group.position.set(
        this._prevT.x + (t.x - this._prevT.x) * a,
        this._prevT.y + (t.y - this._prevT.y) * a,
        this._prevT.z + (t.z - this._prevT.z) * a
      );
      this._interpQ.set(this._prevR.x, this._prevR.y, this._prevR.z, this._prevR.w);
      this._currQ.set(r.x, r.y, r.z, r.w);
      this._interpQ.slerp(this._currQ, a);
      this.group.quaternion.copy(this._interpQ);
    } else {
      this.group.position.set(t.x, t.y, t.z);
      this.group.quaternion.set(r.x, r.y, r.z, r.w);
    }

    // Cartoon body language: lean/pitch/bounce the cab over the wheels.
    this.bodyVisual.rotation.set(this._leanPitch, 0, this._leanRoll);
    this.bodyVisual.position.y = this._bounce;

    // Only sync placeholder wheels when the GLB hasn't loaded yet.
    if (!this._glbModel) {
      for (let i = 0; i < 4; i++) {
        const p = this.wheelPoints[i];
        this._tmpV.set(p.x, p.y - REST * 0.65, p.z).applyQuaternion(this.group.quaternion).add(this.group.position);
        const m = this.wheelMeshes[i];
        m.position.copy(this._tmpV);
        m.quaternion.copy(this.group.quaternion);
        if (i < 2) m.rotateY(this.steerAngle);
      }
    }

    // Animate GLB wheels: front wheels steer + roll, back wheels roll only.
    const roll = this._rollAngle ?? 0;
    this._steerQ.setFromAxisAngle(this._Y_AXIS, this.steerAngle);
    this._rollQ.setFromAxisAngle(this._X_AXIS, roll);
    this._combinedQ.multiplyQuaternions(this._steerQ, this._rollQ);

    const applyAndUpdate = (wheel, q) => {
      if (!wheel) return;
      wheel.quaternion.copy(q);
      wheel.updateMatrix(); // force matrix recompute from quaternion
    };
    applyAndUpdate(this._wheelFL, this._combinedQ);
    applyAndUpdate(this._wheelFR, this._combinedQ);
    applyAndUpdate(this._wheelBL, this._rollQ);
    applyAndUpdate(this._wheelBR, this._rollQ);
  }

  get position() {
    const t = this.body.translation();
    return this._tmpV.set(t.x, t.y, t.z).clone();
  }

  get speedKmh() {
    const v = this.body.linvel();
    return Math.hypot(v.x, v.y, v.z) * 3.6;
  }

  // Gear readout for the HUD (purely cosmetic).
  get gear() {
    const s = this.speedKmh;
    if (s < 12) return 1;
    if (s < 30) return 2;
    if (s < 55) return 3;
    return 4;
  }

  // All four wheels off the ground — used to reward air time (style scoring).
  get airborne() {
    for (let i = 0; i < 4; i++) if (this.controller.wheelIsInContact(i)) return false;
    return true;
  }

  // Sideways velocity (km/h) — the body's lateral (local +X) speed component.
  // High while sliding/drifting through a corner; ~0 when tracking straight.
  get lateralSpeedKmh() {
    const v = this.body.linvel();
    const r = this.body.rotation();
    // world-space right vector (body-local +X)
    const rx = 1 - 2 * (r.y * r.y + r.z * r.z);
    const rz = 2 * (r.x * r.z - r.y * r.w);
    return Math.abs(v.x * rx + v.z * rz) * 3.6;
  }

  reset() {
    this.body.setTranslation({ x: this.start.x, y: this.start.y, z: this.start.z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.steerAngle = 0;
    this._prevT = null;
    this._prevR = null;
    this._rollAngle = 0;
  }

  // Flip upright in place — for recovering from a roll mid-route (R key).
  recover() {
    const t = this.body.translation();
    this.body.setTranslation({ x: t.x, y: t.y + 1.2, z: t.z }, true);
    this.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this._prevT = null;
    this._prevR = null;
  }
}
