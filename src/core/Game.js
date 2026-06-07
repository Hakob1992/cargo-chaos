import * as THREE from 'three';
import { Physics } from './Physics.js';
import { Input } from './Input.js';
import { AudioManager } from './Audio.js';
import { SaveData } from './SaveData.js';
import { World } from '../entities/World.js';
import { Truck } from '../entities/Truck.js';
import { Cargo } from '../entities/Cargo.js';
import { UPGRADES } from '../data/upgrades.js';
import { VEHICLES } from '../data/vehicles.js';
import { ratingFor } from '../data/deliveries.js';
import { HUD } from '../ui/HUD.js';
import { Menu } from '../ui/Menu.js';
import { Customer } from '../ui/Customer.js';
import { WheelParticles } from '../entities/WheelParticles.js';
import { VintageFX } from './VintageFX.js';

const FIXED = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);

export class Game {
  constructor() {
    this.save = new SaveData();
    this.input = new Input();
    this.audio = new AudioManager();
    this.state = 'garage'; // 'garage' | 'driving' | 'result'
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.elapsed = 0;

    this.#initRenderer();
    this.#initScene();

    // Vintage rubber-hose cartoon post-processing (ink outlines, sepia, grain).
    this.fx = new VintageFX(this.renderer, this.scene, this.camera);
    window.__fx = this.fx; // quick live tuning from the console

    this.physics = new Physics(-20);
    this.world = new World(this.scene, this.physics);

    this.startPos = new THREE.Vector3(0, 1.0, 6);
    this.truck = null;
    this.cargo = null;
    this.activeDelivery = null;
    this.particles = null;

    this.hud = new HUD(document.getElementById('ui-root'), this.input);
    // Manual deliver only works when the truck is actually on the pad — no
    // cashing out from the start line.
    this.hud.onDeliver(() => {
      if (this.state === 'driving' && this.truck && this.world.isAtDelivery(this.truck.position)) {
        this.finishDelivery();
      }
    });
    this.menu = new Menu(document.getElementById('ui-root'), this);
    this.customer = new Customer(document.getElementById('ui-root'));

    this.camTarget = new THREE.Vector3();
    this.camDesired = new THREE.Vector3();
    // Dynamic-camera state: bank roll, bump shake, and a vy tracker for landings.
    this.camRoll = 0;
    this.camShake = 0;
    this._prevTruckVY = 0;
    this._shakeV = new THREE.Vector3();

    window.addEventListener('resize', () => this.#onResize());
    this.menu.showGarage();
  }

  #initRenderer() {
    this.canvas = document.getElementById('game-canvas');
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  #initScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xbfe3ff);
    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 600);
    this.camera.position.set(0, 8, -10);
    this.camera.lookAt(0, 0, 20);
  }

  #onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    if (this.fx) this.fx.setSize(window.innerWidth, window.innerHeight);
  }

  // Build the tuning object the truck reads, from the active vehicle + upgrades.
  computeTuning() {
    const vehicle = VEHICLES[0]; // Rusty Pickup (only playable one in the prototype)
    const val = (id) => {
      const u = UPGRADES.find((x) => x.id === id);
      return u.values[this.save.level(id)];
    };
    return {
      color: vehicle.color,
      engineForce: val('engine'),
      // Arcade top speed (km/h), rising with the engine upgrade.
      topSpeed: 58 + this.save.level('engine') * 14,
      tires: val('tires'),
      suspension: val('suspension'),
      shocks: val('shocks'),
      straps: val('straps'),
      insurance: val('insurance'),
    };
  }

  // ---- Game flow -----------------------------------------------------------

  startDelivery(delivery) {
    this.#teardownRun();
    // Called from a click handler — a valid user gesture to start audio.
    this.audio.unlock();
    this.activeDelivery = delivery;
    const tuning = this.computeTuning();
    this.truck = new Truck(this.scene, this.physics, this.startPos, tuning);
    this.cargo = new Cargo(this.scene, this.physics, delivery, this.truck);
    this.particles = new WheelParticles(this.scene);
    this.audio.startEngine();

    this.elapsed = 0;
    this.accumulator = 0;
    this.delivered = false;
    this.camRoll = 0;
    this.camShake = 0;
    this._prevTruckVY = 0;
    this.state = 'driving';
    this.menu.hide();
    this.hud.show(delivery);
    this.customer.bind(delivery);
    this.customer.onStart();
    this.#snapCamera();
  }

  finishDelivery() {
    if (this.state !== 'driving') return;
    this.state = 'result';
    this.audio.stopEngine();
    this.audio.playReward();

    const integrity = this.cargo.integrity;
    const rating = ratingFor(integrity);
    this.customer.onResult(rating.label);
    const floor = this.truck.tuning.insurance; // insurance payout floor
    const payoutFrac = Math.max(rating.payout, floor);
    const earnings = Math.round(this.activeDelivery.reward * payoutFrac);

    this.save.addMoney(earnings);
    this.save.recordBest(this.activeDelivery.id, integrity);

    this.hud.hide();
    this.menu.showResult({
      delivery: this.activeDelivery,
      integrity,
      rating: rating.label,
      earnings,
      time: this.elapsed,
      insured: floor > rating.payout,
    });
  }

  abandonRun() {
    // Bailed out before reaching the pad — counts as a delivery of whatever's left.
    if (this.state === 'driving') this.finishDelivery();
  }

  returnToGarage() {
    this.#teardownRun();
    this.state = 'garage';
    this.hud.hide();
    this.menu.showGarage();
  }

  #teardownRun() {
    this.audio.stopEngine();
    if (this.customer) this.customer.hide();
    if (this.particles) { this.particles.dispose(); this.particles = null; }
    if (this.cargo) { this.cargo.dispose(); this.cargo = null; }
    if (this.truck) {
      // Remove truck meshes + body.
      this.scene.remove(this.truck.group);
      for (const w of this.truck.wheelMeshes) this.scene.remove(w);
      this.physics.remove(this.truck.body);
      this.truck = null;
    }
  }

  // ---- Main loop -----------------------------------------------------------

  start() {
    this.renderer.setAnimationLoop(() => this.#frame());
  }

  #frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.world.update(this.clock.elapsedTime);

    if (this.state === 'driving') {
      this.#fixedUpdate(dt);
      this.#updateRun(dt);
    }

    this.#updateCamera(dt);
    this.fx.render(this.clock.elapsedTime);
  }

  #fixedUpdate(dt) {
    const control = this.input.state;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED && steps < 5) {
      // Reduce tyre grip when the truck is on a mud patch (slippery!).
      this.truck.applyGrip(this.world.gripAt(this.truck.position));
      this.truck.update(control, FIXED);
      // Snapshot both bodies' transforms IMMEDIATELY BEFORE this step. After the
      // loop, _prev holds the second-most-recent state and the live body holds
      // the most-recent one — the two consecutive states sync() interpolates
      // between (canonical fixed-timestep interpolation). Capturing here, rather
      // than once before the loop, keeps the pair adjacent even when 0 or 2+
      // steps run in a frame — that mismatch was the source of the vibration.
      this.truck.capturePreStepState();
      this.cargo.capturePreStepState();
      this.physics.step();
      // Impacts reported this step damage the cargo, scaled by force magnitude.
      this.physics.drainContactForces((a, b, magnitude) => {
        if (a === 'cargo' || b === 'cargo') {
          this.cargo.registerImpact(magnitude);
          // Jolt the camera + thump the speakers on a meaty cargo slam.
          this.addCamShake(Math.min(0.22, magnitude / 130000));
          this.audio.playImpact(Math.min(1, magnitude / 50000));
          this.customer.onBump();
        }
      });
      // Damage/age logic runs on the fixed step for frame-rate independence.
      this.cargo.update(FIXED);
      this.accumulator -= FIXED;
      steps++;
      this.elapsed += FIXED;
    }
  }

  #updateRun(dt) {
    // alpha is the leftover fraction of a fixed step — used to interpolate the
    // truck + cargo meshes between the pre-step and post-step physics positions
    // so both move in lockstep with no jitter.
    const alpha = this.accumulator / FIXED;
    this.truck.sync(alpha);
    this.cargo.sync(alpha);

    // Dust particles from all four wheel contact points.
    if (this.particles) this.particles.update(dt, this.truck);

    // Engine note tracks speed + throttle.
    this.audio.setEngine(this.truck.speedKmh, this.input.state.throttle);

    // Customer reacts: panic when the cargo leans dangerously (≈ >43°).
    this.customer.setClock(this.elapsed);
    if ((this.cargo.lastTilt ?? 0) > 0.75 && !this.cargo.broken) this.customer.onNearFall();

    // R recovers the truck upright; bring the cargo back onto the bed with it.
    if (this.input.consumeReset()) {
      this.truck.recover();
      this.cargo.placeOnBed();
    }

    // Reached the delivery pad? Surface the manual DELIVER button while on it,
    // and auto-deliver once the truck has come to a near stop.
    const atPad = this.world.isAtDelivery(this.truck.position);
    this.hud.setDeliverable(atPad);
    if (atPad && this.truck.speedKmh < 8) this.finishDelivery();

    this.hud.update({
      time: this.elapsed,
      damage: Math.round(this.cargo.damage),
      speed: Math.round(this.truck.speedKmh),
      gear: this.truck.gear,
    });
  }

  #snapCamera() {
    this.#computeCamDesired();
    this.camera.position.copy(this.camDesired);
  }

  // Add a camera shake impulse (0..1-ish), accumulated and decayed each frame.
  addCamShake(amount) {
    this.camShake = Math.min(0.8, this.camShake + amount);
  }

  #computeCamDesired() {
    if (!this.truck) return;
    // Follow the INTERPOLATED mesh position (group.position), NOT the raw 60 Hz
    // body position. Tracking the raw body made the camera step while the truck
    // glided, which read as world-wide stutter / "frame drops".
    const pos = this.truck.group.position;
    const q = this.truck.group.quaternion;
    const yaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    // Zoom out + lift as speed rises, so fast driving feels fast and reads ahead.
    const sf = Math.min(1, this.truck.speedKmh / (this.truck.tuning.topSpeed ?? 60));
    const dist = 9 + sf * 2.0;   // gentler zoom-out (was 4.5)
    const height = 4.5 + sf * 0.6; // gentler lift (was 1.3)
    const offset = new THREE.Vector3(0, height, -dist).applyAxisAngle(UP, yaw);
    this.camDesired.copy(pos).add(offset);
    this.camTarget.copy(pos).add(new THREE.Vector3(0, 1.2, 4).applyAxisAngle(UP, yaw));
    this._speedFactor = sf;
  }

  #updateCamera(dt) {
    if (this.state !== 'driving' || !this.truck) return;
    this.#computeCamDesired();
    const k = 1 - Math.pow(0.001, dt); // frame-rate independent smoothing
    this.camera.position.lerp(this.camDesired, k);

    // Bump shake: a big sudden upward velocity change = a landing/hard bump.
    const vy = this.truck.body.linvel().y;
    const dvy = vy - this._prevTruckVY;
    this._prevTruckVY = vy;
    if (dvy > 6) {
      const hit = Math.min(0.28, (dvy - 6) * 0.022);
      this.addCamShake(hit);
      this.audio.playSqueak(hit);
      this.audio.playRattle(hit);
      // Burst of dust from all wheels on landing / hard bump.
      if (this.particles) this.particles.burst(this.truck, hit);
    }
    this.camShake *= Math.pow(0.05, dt); // decay
    if (this.camShake > 0.001) {
      this._shakeV.set(
        (Math.random() * 2 - 1),
        (Math.random() * 2 - 1) * 0.7,
        (Math.random() * 2 - 1)
      ).multiplyScalar(this.camShake * 0.5);
      this.camera.position.add(this._shakeV);
    }

    this.camera.lookAt(this.camTarget);

    // Bank into turns: roll around the view axis with steering, stronger at speed.
    const targetRoll = -this.truck.steerAngle * 0.12 * (0.4 + 0.6 * (this._speedFactor ?? 0));
    this.camRoll += (targetRoll - this.camRoll) * Math.min(1, dt * 5);
    this.camera.rotateZ(this.camRoll);
  }
}
