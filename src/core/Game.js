import * as THREE from 'three';
import { Physics } from './Physics.js';
import { Input } from './Input.js';
import { SaveData } from './SaveData.js';
import { World } from '../entities/World.js';
import { Truck } from '../entities/Truck.js';
import { Cargo } from '../entities/Cargo.js';
import { UPGRADES } from '../data/upgrades.js';
import { VEHICLES } from '../data/vehicles.js';
import { ratingFor } from '../data/deliveries.js';
import { HUD } from '../ui/HUD.js';
import { Menu } from '../ui/Menu.js';

const FIXED = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);

export class Game {
  constructor() {
    this.save = new SaveData();
    this.input = new Input();
    this.state = 'garage'; // 'garage' | 'driving' | 'result'
    this.clock = new THREE.Clock();
    this.accumulator = 0;
    this.elapsed = 0;

    this.#initRenderer();
    this.#initScene();

    this.physics = new Physics(-20);
    this.world = new World(this.scene, this.physics);

    this.startPos = new THREE.Vector3(0, 1.0, 6);
    this.truck = null;
    this.cargo = null;
    this.activeDelivery = null;

    this.hud = new HUD(document.getElementById('ui-root'), this.input);
    // Manual deliver only works when the truck is actually on the pad — no
    // cashing out from the start line.
    this.hud.onDeliver(() => {
      if (this.state === 'driving' && this.truck && this.world.isAtDelivery(this.truck.position)) {
        this.finishDelivery();
      }
    });
    this.menu = new Menu(document.getElementById('ui-root'), this);

    this.camTarget = new THREE.Vector3();
    this.camDesired = new THREE.Vector3();

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
    this.activeDelivery = delivery;
    const tuning = this.computeTuning();
    this.truck = new Truck(this.scene, this.physics, this.startPos, tuning);
    this.cargo = new Cargo(this.scene, this.physics, delivery, this.truck);

    this.elapsed = 0;
    this.accumulator = 0;
    this.delivered = false;
    this.state = 'driving';
    this.menu.hide();
    this.hud.show(delivery);
    this.#snapCamera();
  }

  finishDelivery() {
    if (this.state !== 'driving') return;
    this.state = 'result';

    const integrity = this.cargo.integrity;
    const rating = ratingFor(integrity);
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
    this.renderer.render(this.scene, this.camera);
  }

  #fixedUpdate(dt) {
    const control = this.input.state;
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED && steps < 5) {
      this.truck.update(control, FIXED);
      this.physics.step();
      // Impacts reported this step damage the cargo, scaled by force magnitude.
      this.physics.drainContactForces((a, b, magnitude) => {
        if (a === 'cargo' || b === 'cargo') this.cargo.registerImpact(magnitude);
      });
      this.accumulator -= FIXED;
      steps++;
      this.elapsed += FIXED;
    }
  }

  #updateRun(dt) {
    this.truck.sync();
    this.cargo.update(dt);

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

  #computeCamDesired() {
    if (!this.truck) return;
    const pos = this.truck.position;
    const q = this.truck.group.quaternion;
    const yaw = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    const offset = new THREE.Vector3(0, 4.5, -9).applyAxisAngle(UP, yaw);
    this.camDesired.copy(pos).add(offset);
    this.camTarget.copy(pos).add(new THREE.Vector3(0, 1.2, 4).applyAxisAngle(UP, yaw));
  }

  #updateCamera(dt) {
    if (this.state !== 'driving' || !this.truck) return;
    this.#computeCamDesired();
    const k = 1 - Math.pow(0.001, dt); // frame-rate independent smoothing
    this.camera.position.lerp(this.camDesired, k);
    this.camera.lookAt(this.camTarget);
  }
}
