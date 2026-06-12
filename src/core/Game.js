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
import { ROUTES } from '../data/routes.js';
import { HUD } from '../ui/HUD.js';
import { Menu } from '../ui/Menu.js';
import { Customer } from '../ui/Customer.js';
import { WheelParticles } from '../entities/WheelParticles.js';
import { VintageFX } from './VintageFX.js';

const FIXED = 1 / 60;
const UP = new THREE.Vector3(0, 1, 0);

// ---- Game-feel tunables (impact juice) -------------------------------------
// Hitstop: a brief full freeze of the sim so big hits "land". Kept tiny — long
// freezes read as lag, not impact.
const HITSTOP_BREAK_SEC = 0.18;     // freeze when the cargo is ruined/breaks
const HITSTOP_BIGHIT_SEC = 0.07;    // freeze on a hard (but survivable) slam
const HITSTOP_BIGHIT_FORCE = 45000; // contact force that counts as a "big hit"
// Slow-mo beat when the cargo crosses a damage stage (perfect → damaged):
const SLOWMO_STAGE_SEC = 0.5;       // real-time duration of the beat
const SLOWMO_STAGE_SCALE = 0.35;    // sim speed during the beat
// Camera shake on damage-stage transitions (on top of per-impact shake):
const SHAKE_ON_DAMAGED = 0.16;
const SHAKE_ON_RUINED = 0.4;
// Cargo squash level that triggers the landing-thunk sound:
const THUNK_SQUASH_EDGE = 0.3;
// Near-miss "phew": a scare registers past these, relief fires once it calms.
const PHEW_SCARE_TIP = 0.55;  // tipProgress that counts as a scare
const PHEW_SCARE_TILT = 0.9;  // tilt (rad) that counts as a scare
const PHEW_CALM_TIP = 0.15;   // recovered below this …
const PHEW_CALM_TILT = 0.4;   // … and this → phew!

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
    // Pause + mute (HUD buttons; also P/Esc and M on the keyboard).
    this.paused = false;
    this.hud.onPause(() => this.togglePause());
    this.hud.onMute(() => this.toggleMute());
    this.hud.setMuted(this.audio.muted);

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

  startDelivery(delivery, routeId = 'highway') {
    this.#teardownRun();
    // Called from a click handler — a valid user gesture to start audio.
    this.audio.unlock();
    this.activeDelivery = delivery;
    // Phase 5 — risk/reward route: open the chosen branch, barricade the other.
    this.route = ROUTES[routeId] ?? ROUTES.highway;
    this.world.setActiveRoute(this.route.id);
    const tuning = this.computeTuning();
    this.truck = new Truck(this.scene, this.physics, this.startPos, tuning);
    this.cargo = new Cargo(this.scene, this.physics, delivery, this.truck);
    this.particles = new WheelParticles(this.scene);
    this.audio.startEngine();

    this.elapsed = 0;
    this.accumulator = 0;
    this.delivered = false;
    this._failing = false;
    this._failAt = 0;
    this.styleScore = 0;
    // Par time = chosen route's length / its par pace. The shortcut's pace is
    // generous (hazards expected) — beat it hard for a big time score.
    this.targetTime = (this.world.routeLength || 420) / this.route.parSpeed;
    this.camRoll = 0;
    this.camShake = 0;
    this._prevTruckVY = 0;
    // Impact-juice state: pending freeze-frame / slow-mo beat, and the last seen
    // damage stage so transitions (perfect → damaged → ruined) can be felt.
    this.hitstop = 0;
    this.slowmo = 0;
    this._lastStage = 'perfect';
    this._prevSquash = 0;
    this._scared = false;
    this.state = 'driving';
    this.menu.hide();
    this.hud.show(delivery, this.route);
    this.customer.bind(delivery);
    this.customer.onStart();
    this.#snapCamera();
  }

  finishDelivery(failed = false) {
    if (this.state !== 'driving') return;
    this.state = 'result';
    this.audio.stopEngine();
    this.audio.setTension(0);
    // A wrecked load gets a thud, not a fanfare.
    if (failed) this.audio.playImpact(1); else this.audio.playReward();

    const integrity = this.cargo.integrity;
    const rating = ratingFor(integrity);
    this.customer.onResult(rating.label);
    const floor = this.truck.tuning.insurance; // insurance payout floor
    const payoutFrac = Math.max(rating.payout, floor);
    // The risky route pays a bonus on whatever survives the trip.
    const routeMult = this.route?.payoutMult ?? 1;
    const earnings = Math.round(this.activeDelivery.reward * payoutFrac * routeMult);

    // Star rating from three inputs: condition, time vs par, and clean style.
    const score = this.#computeStars(integrity, failed);

    this.save.addMoney(earnings);
    this.save.recordBest(this.activeDelivery.id, integrity);
    if (!failed) this.save.recordStars(this.activeDelivery.id, score.stars);

    this.hud.hide();
    this.menu.showResult({
      delivery: this.activeDelivery,
      integrity,
      rating: rating.label,
      earnings,
      time: this.elapsed,
      insured: floor > rating.payout,
      failed,
      failReason: failed ? this.cargo.failKind : null,
      stars: score.stars,
      breakdown: { condition: score.condition, time: score.time, style: score.style },
      totalStars: this.save.totalStars(),
      route: this.route,
    });
  }

  // Map a finished run to 1–5 stars. condition (cargo intact) is weighted
  // heaviest, time vs par next, clean drift/air style is the bonus that pushes a
  // careful-and-fast run up to the full five. A failed (ruined) run is 1 star.
  #computeStars(integrity, failed) {
    if (failed) return { stars: 1, condition: 0, time: 0, style: 0 };
    const condition = integrity / 100;
    const time = THREE.MathUtils.clamp((2 * this.targetTime - this.elapsed) / this.targetTime, 0, 1);
    const STYLE_MAX = 40; // points that count as a maxed-out flair run
    const style = THREE.MathUtils.clamp(this.styleScore / STYLE_MAX, 0, 1);
    const total = 0.5 * condition + 0.3 * time + 0.2 * style;
    const stars = THREE.MathUtils.clamp(Math.round(1 + total * 4), 1, 5);
    return { stars, condition, time, style };
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
    this.paused = false;
    this.audio.stopEngine();
    this.audio.setTension(0);
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

    // Keyboard shortcuts: M mutes anytime; P / Esc toggles pause while driving.
    if (this.input.consumeMute()) this.toggleMute();
    if (this.input.consumePause()) this.togglePause();

    if (this.state === 'driving' && !this.paused) {
      if (this.hitstop > 0) {
        // Freeze-frame: hold the whole sim for a beat so the hit registers.
        // The camera keeps easing (below) so it reads as impact, not a hang.
        this.hitstop -= dt;
      } else {
        // Slow-mo beat: run the sim at a fraction of real time briefly.
        let scale = 1;
        if (this.slowmo > 0) {
          this.slowmo -= dt;
          scale = SLOWMO_STAGE_SCALE;
        }
        this.#fixedUpdate(dt * scale);
        this.#updateRun(dt * scale);
      }
    }

    this.#updateCamera(dt);
    this.fx.render(this.clock.elapsedTime);
  }

  // Pause only matters mid-drive: freeze the sim and silence the engine.
  togglePause() {
    if (this.state !== 'driving') return;
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
    if (this.paused) {
      this.audio.stopEngine();
      this.audio.setTension(0);
    } else {
      this.audio.startEngine();
      // Drop any time accrued while paused so physics doesn't lurch on resume.
      this.accumulator = 0;
    }
  }

  toggleMute() {
    this.audio.setMuted(!this.audio.muted);
    this.hud.setMuted(this.audio.muted);
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
          const before = this.cargo.damage;
          this.cargo.registerImpact(magnitude);
          // Style is "clean" flair only — a hit that actually hurts the cargo
          // wipes most of the points you'd banked drifting/jumping into it.
          if (this.cargo.damage > before + 0.5) this.styleScore = Math.max(0, this.styleScore * 0.5 - 5);
          // Jolt the camera + thump the speakers on a meaty cargo slam.
          this.addCamShake(Math.min(0.22, magnitude / 130000));
          this.audio.playImpact(Math.min(1, magnitude / 50000));
          this.customer.onBump();
          // A truly hard slam earns a blink of freeze-frame even if it survives.
          if (magnitude > HITSTOP_BIGHIT_FORCE) {
            this.hitstop = Math.max(this.hitstop, HITSTOP_BIGHIT_SEC);
          }
        }
      });
      // Damage/age logic runs on the fixed step for frame-rate independence.
      this.cargo.update(FIXED);

      // Damage-stage transitions get a felt beat: a slow-mo moment when the
      // cargo first cracks, a hard freeze + shake the instant it's ruined.
      const stage = this.cargo.stage;
      if (stage !== this._lastStage) {
        if (stage === 'ruined') {
          this.hitstop = Math.max(this.hitstop, HITSTOP_BREAK_SEC);
          this.addCamShake(SHAKE_ON_RUINED);
          // Comedic break flourish flavoured by HOW it died.
          this.audio.playBreak(this.cargo.failKind || this.cargo.behavior.failKind || 'crush');
        } else if (stage === 'damaged') {
          this.slowmo = Math.max(this.slowmo, SLOWMO_STAGE_SEC);
          this.addCamShake(SHAKE_ON_DAMAGED);
          this.audio.playCrack();
        }
        this._lastStage = stage;
      }
      // A freeze-frame fired mid-loop: stop stepping this frame so it lands NOW.
      if (this.hitstop > 0) break;

      // Style points: clean air time + sliding/drifting (mostly when traction
      // breaks — mud, or a hard turn at speed). The grippy truck rarely slides on
      // dry road, so a lower threshold keeps drift style attainable.
      if (this.truck.airborne && this.truck.speedKmh > 15) this.styleScore += FIXED * 6;
      const drift = this.truck.lateralSpeedKmh;
      if (drift > 8 && this.truck.speedKmh > 18) this.styleScore += FIXED * Math.min(1, drift / 30) * 8;

      // Leaving the road bounces the cargo over rough terrain. Accrue damage
      // while any part of the truck is past the road edge, scaled by how far off
      // and how fast you're going — a constant nudge to stay on the track.
      const off = this.world.offRoadDistance(this.truck.position.x, this.truck.position.z);
      this.offRoad = off > 0 && !this.cargo.broken && this.cargo.age > this.cargo.settleTime;
      if (this.offRoad) {
        const offFactor = Math.min(1, off / 6);
        const speedFactor = 0.3 + 0.7 * Math.min(1, this.truck.speedKmh / 40);
        this.cargo.addDamage((2 + 10 * offFactor) * speedFactor * FIXED);
      }

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

    // Nervous string tension while the cargo skates across the bed.
    this.audio.setTension(this.cargo.broken ? 0 : (this.cargo.slideAmount ?? 0));

    // Deep thunk the moment a landing squash kicks in.
    const squash = this.cargo.squash ?? 0;
    if (squash > THUNK_SQUASH_EDGE && (this._prevSquash ?? 0) <= THUNK_SQUASH_EDGE) {
      this.audio.playThunk(squash);
    }
    this._prevSquash = squash;

    // Startled cluck when a live-animal crate shuffles or takes a knock.
    if (this.cargo.cluckPending) {
      this.cargo.cluckPending = false;
      this.audio.playCluck();
    }

    // Near-miss relief: the cargo nearly went over but recovered → "PHEW!".
    const tip = this.cargo.tipProgress ?? 0;
    const tilt = this.cargo.lastTilt ?? 0;
    if (!this.cargo.broken && (tip > PHEW_SCARE_TIP || tilt > PHEW_SCARE_TILT)) {
      this._scared = true;
    } else if (this._scared && !this.cargo.broken
        && tip < PHEW_CALM_TIP && tilt < PHEW_CALM_TILT) {
      this._scared = false;
      this.audio.playPhew();
      this.hud.flashPhew();
    }
    if (this.cargo.broken) this._scared = false;

    // Customer reacts: panic when the cargo leans dangerously (≈ >43°).
    this.customer.setClock(this.elapsed);
    if ((this.cargo.lastTilt ?? 0) > 0.75 && !this.cargo.broken) this.customer.onNearFall();

    // Off-road feedback: warn the player, rumble the camera over rough ground,
    // and make the passenger wince while the cargo is taking terrain damage.
    this.hud.setOffRoad(this.offRoad);
    if (this.offRoad) {
      this.addCamShake(0.06 + 0.06 * Math.min(1, this.truck.speedKmh / 40));
      if (!this.cargo.broken) this.customer.onNearFall();
    }

    // Cargo-personality warning (tipping fish tank, primed gas canister, …).
    this.hud.setCargoWarn(this.cargo.warning);

    // R recovers the truck upright; bring the cargo back onto the bed with it.
    if (this.input.consumeReset()) {
      this.truck.recover();
      this.cargo.placeOnBed();
    }

    // Cargo ruined → the delivery has failed. Give the smash a beat to register
    // on screen, then bounce to the (failed) result.
    if (this.cargo.ruined && !this._failing) {
      this._failing = true;
      this._failAt = this.elapsed + 1.1;
    }
    if (this._failing && this.elapsed >= this._failAt) {
      this.finishDelivery(true);
      return;
    }

    // Reached the delivery pad? Surface the manual DELIVER button while on it,
    // and auto-deliver once the truck has come to a near stop.
    const atPad = this.world.isAtDelivery(this.truck.position);
    this.hud.setDeliverable(atPad);
    if (atPad && this.truck.speedKmh < 8) this.finishDelivery();

    this.hud.update({
      time: this.elapsed,
      integrity: this.cargo.integrity,
      stage: this.cargo.stage,
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
