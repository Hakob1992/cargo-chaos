import * as THREE from 'three';
import { RAPIER } from '../core/Physics.js';

// The drivable course: a long road running down +Z, flanked by ground, with a
// few bumps/ramps for chaos and a delivery pad at the far end.
export class World {
  constructor(scene, physics) {
    this.scene = scene;
    this.physics = physics;
    this.world = physics.world;
    this.length = 220; // road length along Z
    this.width = 14;    // road width along X
    this.deliveryZ = this.length - 12;
    this.obstacles = [];

    this.#buildLighting();
    this.#buildGround();
    this.#buildRoad();
    this.#buildObstacles();
    this.#buildDeliveryPad();
    this.#buildScenery();
  }

  #buildLighting() {
    const hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4a6a3a, 0.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(40, 80, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 80;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 260;
    this.scene.add(sun);
    this.scene.fog = new THREE.Fog(0xbfe3ff, 120, 320);
  }

  #addStaticBox(cx, cy, cz, hx, hy, hz, color, { friction = 1.0 } = {}) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2),
      new THREE.MeshStandardMaterial({ color, roughness: 0.95 })
    );
    mesh.position.set(cx, cy, cz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.scene.add(mesh);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz)
    );
    const col = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction),
      body
    );
    return { mesh, body, col };
  }

  #buildGround() {
    // Big grassy plain.
    const groundMesh = new THREE.Mesh(
      new THREE.BoxGeometry(400, 2, 400),
      new THREE.MeshStandardMaterial({ color: 0x5c8a3a, roughness: 1 })
    );
    groundMesh.position.set(0, -1, this.length / 2);
    groundMesh.receiveShadow = true;
    this.scene.add(groundMesh);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -1, this.length / 2)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(200, 1, 200).setFriction(1.0),
      body
    );
  }

  #buildRoad() {
    // Asphalt strip slightly above the grass.
    const road = new THREE.Mesh(
      new THREE.BoxGeometry(this.width, 0.2, this.length),
      new THREE.MeshStandardMaterial({ color: 0x39393f, roughness: 0.9 })
    );
    road.position.set(0, 0.1, this.length / 2);
    road.receiveShadow = true;
    this.scene.add(road);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0.1, this.length / 2)
    );
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(this.width / 2, 0.1, this.length / 2).setFriction(1.1),
      body
    );

    // Centre dashes (visual only).
    const dashMat = new THREE.MeshStandardMaterial({ color: 0xf2d63a, roughness: 0.8 });
    for (let z = 6; z < this.length - 6; z += 8) {
      const dash = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 3), dashMat);
      dash.position.set(0, 0.22, z);
      this.scene.add(dash);
    }
  }

  #buildObstacles() {
    // Speed bumps across the road — the classic cargo-jostler. Sit ~0.13m
    // proud of the road surface (top y≈0.33) so they shake cargo, not launch it.
    const bumpColor = 0xb8b8c0;
    for (const z of [40, 95, 150]) {
      this.#addStaticBox(0, 0.26, z, this.width / 2 - 0.5, 0.07, 1.1, bumpColor);
    }

    // Scattered low blocks to weave around (sit on the road, ~0.3m proud).
    this.#addStaticBox(-3.5, 0.45, 70, 0.6, 0.3, 0.6, 0x9a6b3a);
    this.#addStaticBox(3.5, 0.45, 175, 0.6, 0.3, 0.6, 0x9a6b3a);
  }

  #buildDeliveryPad() {
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(5, 5, 0.3, 32),
      new THREE.MeshStandardMaterial({
        color: 0x2fbf6f,
        emissive: 0x1c7a44,
        emissiveIntensity: 0.4,
        roughness: 0.6,
      })
    );
    pad.position.set(0, 0.25, this.deliveryZ);
    pad.receiveShadow = true;
    this.scene.add(pad);
    this.deliveryPad = pad;

    // Glowing ring marker.
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(5, 0.25, 12, 48),
      new THREE.MeshStandardMaterial({ color: 0x9affc8, emissive: 0x35d07a, emissiveIntensity: 0.8 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0, 0.5, this.deliveryZ);
    this.scene.add(ring);
    this.deliveryRing = ring;

    this.deliveryPos = new THREE.Vector3(0, 0, this.deliveryZ);
  }

  #buildScenery() {
    // Low-poly cone trees along both shoulders for a sense of speed.
    const trunkMat = new THREE.MeshStandardMaterial({ color: 0x5b3a1e });
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f7d34 });
    for (let z = 0; z < this.length; z += 11) {
      for (const side of [-1, 1]) {
        const x = side * (this.width / 2 + 4 + Math.random() * 6);
        const g = new THREE.Group();
        const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 1.4), trunkMat);
        trunk.position.y = 0.7;
        const leaves = new THREE.Mesh(new THREE.ConeGeometry(1.6, 3.4, 7), leafMat);
        leaves.position.y = 2.8;
        g.add(trunk, leaves);
        g.position.set(x, 0, z + Math.random() * 6);
        g.castShadow = true;
        this.scene.add(g);
      }
    }
  }

  // Has the truck reached the delivery pad?
  isAtDelivery(position, radius = 4.5) {
    const dx = position.x - this.deliveryPos.x;
    const dz = position.z - this.deliveryPos.z;
    return Math.hypot(dx, dz) <= radius;
  }

  update(t) {
    if (this.deliveryRing) this.deliveryRing.position.y = 0.5 + Math.sin(t * 2) * 0.15;
  }
}
