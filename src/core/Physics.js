import RAPIER from '@dimforge/rapier3d-compat';

// Thin wrapper around a Rapier world. rapier3d-compat must be initialised once
// (it loads its WASM) before any world is created.
export class Physics {
  static async init() {
    await RAPIER.init();
  }

  constructor(gravityY = -20) {
    this.RAPIER = RAPIER;
    this.world = new RAPIER.World({ x: 0, y: gravityY, z: 0 });
    this.world.timestep = 1 / 60;
    this.eventQueue = new RAPIER.EventQueue(true);
    // collider handle -> arbitrary entity tag, for resolving contact events
    this.tags = new Map();
  }

  tag(collider, value) {
    this.tags.set(collider.handle, value);
    return collider;
  }

  tagOf(handle) {
    return this.tags.get(handle);
  }

  step() {
    this.world.step(this.eventQueue);
  }

  // Invoke cb(tagA, tagB, magnitude) for each contact-force event this step.
  drainContactForces(cb) {
    this.eventQueue.drainContactForceEvents((event) => {
      const a = this.tags.get(event.collider1());
      const b = this.tags.get(event.collider2());
      cb(a, b, event.totalForceMagnitude());
    });
  }

  remove(body) {
    if (body) this.world.removeRigidBody(body);
  }
}

export { RAPIER };
