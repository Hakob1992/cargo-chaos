import * as THREE from 'three';

// Generic pooled particle burst: instanced bits that arc under gravity, shrink
// out, and optionally tumble. Used for water droplets (spheres, no spin) and
// glass shards (tetrahedra, spinning). Cheap enough to leave running.
export class BurstFX {
  constructor(scene, opts = {}) {
    this.scene = scene;
    const {
      color = 0x4aa3d6, opacity = 0.9, roughness = 0.25, max = 80,
      gravity = -18, spin = false, doubleSide = false,
      geometry = new THREE.IcosahedronGeometry(0.05, 0),
      upSpeed = [1.6, 4.0], spread = 2.4, lifeRange = [0.45, 0.9],
    } = opts;
    this.gravity = gravity;
    this.spin = spin;
    this.upSpeed = upSpeed;
    this.spread = spread;
    this.lifeRange = lifeRange;

    const mat = new THREE.MeshStandardMaterial({
      color, roughness, metalness: 0.0,
      transparent: opacity < 1, opacity,
      side: doubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    this.mesh = new THREE.InstancedMesh(geometry, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;
    scene.add(this.mesh);

    this.max = max;
    this.parts = Array.from({ length: max }, () => ({
      active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      rot: new THREE.Euler(), angVel: new THREE.Vector3(), life: 0, ttl: 1, size: 1,
    }));
    this._next = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._hidden = new THREE.Vector3(0, -9999, 0);
    for (let i = 0; i < max; i++) {
      this._m.makeScale(0, 0, 0).setPosition(this._hidden);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Emit `count` bits from `pos` with a base velocity plus randomised spread.
  // `intensity` (0..1) scales launch speed and bit size.
  burst(pos, baseVel, count, intensity = 1) {
    const n = Math.min(count, this.max);
    const upMin = this.upSpeed[0];
    const upRange = this.upSpeed[1] - this.upSpeed[0];
    for (let k = 0; k < n; k++) {
      const p = this.parts[this._next];
      this._next = (this._next + 1) % this.max;
      p.active = true;
      p.pos.copy(pos).addScaledVector(this._s.set(Math.random() - 0.5, Math.random() * 0.4, Math.random() - 0.5), 0.35);
      const up = upMin + Math.random() * upRange * intensity;
      p.vel.copy(baseVel).add(this._s.set(
        (Math.random() - 0.5) * this.spread * intensity,
        up,
        (Math.random() - 0.5) * this.spread * intensity,
      ));
      p.ttl = p.life = this.lifeRange[0] + Math.random() * (this.lifeRange[1] - this.lifeRange[0]);
      p.size = (0.5 + Math.random() * 0.8) * (0.7 + intensity * 0.6);
      if (this.spin) {
        p.rot.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
        p.angVel.set((Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16, (Math.random() - 0.5) * 16);
      }
    }
  }

  update(dt) {
    let any = false;
    for (let i = 0; i < this.max; i++) {
      const p = this.parts[i];
      if (!p.active) continue;
      any = true;
      p.vel.y += this.gravity * dt;
      p.pos.addScaledVector(p.vel, dt);
      p.life -= dt;
      if (p.life <= 0 || p.pos.y < -4) {
        p.active = false;
        this._m.makeScale(0, 0, 0).setPosition(this._hidden);
      } else {
        const t = p.life / p.ttl;               // 1 → 0
        const sc = p.size * (0.35 + 0.65 * t);   // shrink as it dies
        if (this.spin) {
          p.rot.x += p.angVel.x * dt;
          p.rot.y += p.angVel.y * dt;
          p.rot.z += p.angVel.z * dt;
          this._q.setFromEuler(p.rot);
        } else {
          this._q.identity();
        }
        this._m.compose(p.pos, this._q, this._s.set(sc, sc, sc));
      }
      this.mesh.setMatrixAt(i, this._m);
    }
    if (any) this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }
}
