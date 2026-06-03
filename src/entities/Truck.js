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

export class Truck {
  constructor(scene, physics, startPos, tuning) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.tuning = tuning;
    this.start = startPos.clone();
    this.steerAngle = 0;

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
      // Rear wheels grip harder sideways to curb spin-outs.
      this.controller.setWheelSideFrictionStiffness(i, i >= 2 ? 1.0 : 0.7);
    }
  }

  #buildMesh() {
    this.group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: this.tuning.color ?? 0x3a78c2, roughness: 0.6, metalness: 0.2 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x222228, roughness: 0.7 });

    // --- Placeholder geometry (shown until Car1.glb loads) ---
    // Flatbed base.
    const base = new THREE.Mesh(new THREE.BoxGeometry(CHASSIS.hx * 2, CHASSIS.hy * 2, CHASSIS.hz * 2), bodyMat);
    base.castShadow = true;
    this._placeholders = [base];
    this.group.add(base);

    // Cab over the front third.
    const cab = new THREE.Mesh(new THREE.BoxGeometry(CHASSIS.hx * 1.9, 0.7, 1.1), bodyMat);
    cab.position.set(0, CHASSIS.hy + 0.35, CHASSIS.hz - 0.7);
    cab.castShadow = true;
    this._placeholders.push(cab);
    this.group.add(cab);

    const glass = new THREE.Mesh(
      new THREE.BoxGeometry(CHASSIS.hx * 1.7, 0.4, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x9fd8ef, roughness: 0.2, metalness: 0.4 })
    );
    glass.position.set(0, CHASSIS.hy + 0.45, CHASSIS.hz - 0.15);
    this._placeholders.push(glass);
    this.group.add(glass);

    // Bed rim (visual to match the colliders).
    const mkRim = (x, y, z, w, h, d) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), bodyMat);
      m.position.set(x, y, z);
      m.castShadow = true;
      this._placeholders.push(m);
      this.group.add(m);
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

    // --- Load Car1.glb and replace placeholder when ready ---
    const loader = new GLTFLoader();
    loader.load('./Car1.glb', (gltf) => {
      // Remove all placeholder children from the group.
      for (const ph of this._placeholders) this.group.remove(ph);
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


      this.group.add(model);
      this._glbModel = model;

      // Hide placeholder wheels — the GLB has its own wheels baked in.
      for (const w of this.wheelMeshes) w.visible = false;

    }, undefined, (err) => {
      console.warn('Car1.glb failed to load — using placeholder geometry.', err);
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
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * 8);

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
